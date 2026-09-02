import type { SynquxMode } from './slice.js'
import type { ChannelCleanup, SynquxTransport, Unsubscribe } from './types.js'

/**
 * channels — 裁定なし高頻度同期チャネル (LWW KV、ADR-0028)
 *
 * requests (正史) / snapshot (復元) / presence (接続) と独立した第 4 チャネル。
 * (channel, key) ごとの最新値だけが意味を持つデータ (カーソル座標・ドラッグ中
 * 座標) を、Redux store を通さずに transport へ流す。React binding (jotai 等) は
 * consumer 責務 (ADR-0023 の react slim 方針)
 */

export type SynquxChannelOptions = {
  /**
   * 値の削除タイミング。'disconnect' は publish した接続の切断で自動削除
   * (カーソル等)。既定 'none' (ドラッグ座標等、session を跨いで transport に残る)
   */
  cleanup?: ChannelCleanup

  /**
   * publish の per-key throttle ms (leading + trailing)。既定 70 (移植元実測値)。
   * trailing 保証により、window 中の中間値は間引かれても最終値は必ず送信される。
   * 0 で無効化
   */
  throttleMs?: number
}

export type SynquxChannelHandlers<T> = {
  /**
   * (key, value) の upsert 通知。LWW のため added / changed は区別しない。
   * at-least-once 配送のため同値の重複通知があり得る (冪等に扱うこと)
   */
  onChanged(key: string, value: T): void

  /** key の削除通知 (明示 remove / cleanup 'disconnect' の切断) */
  onRemoved(key: string): void
}

export type SynquxChannel<T> = {
  /**
   * (key, value) の LWW 書き込み。fire-and-forget で、throttle window 中は
   * 最新値へ coalesce される。session 未開始 (未 subscribe) の間は静かに drop
   * する (mousemove 等は接続前から発火するため)。value は JSON-serializable
   * であること
   */
  publish(key: string, value: T): void

  /** key の明示削除。全端末へ onRemoved が配送される。session 未開始は no-op */
  remove(key: string): Promise<void>

  /**
   * 変更購読。購読時に既知の entry が onChanged で非同期に一括配送される。
   * session を跨いで登録は生存し、session 開始で自動 attach・終了で detach する
   */
  subscribe(handlers: SynquxChannelHandlers<T>): Unsubscribe
}

/**
 * channel 名と key の書式制約。firebase adapter がそのまま path 断片に使うため、
 * groupId と同じ禁止文字集合を core の入口で拒否する (adapter 差の吸収)
 */
const INVALID_CHANNEL_CHARS = /[.#$/[\]]/

/** RTDB key の禁止対象である制御文字 (U+0000-U+001F, U+007F) の検査 */
const hasControlChars = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const assertValidSegment = (label: string, value: string): void => {
  if (
    value.length === 0 ||
    INVALID_CHANNEL_CHARS.test(value) ||
    hasControlChars(value)
  ) {
    throw new Error(
      `Invalid channel ${label} "${value}": must be a non-empty key without ".", "#", "$", "/", "[", "]" or control characters`,
    )
  }
}

const DEFAULT_THROTTLE_MS = 70

type ThrottleState = {
  timer: ReturnType<typeof setTimeout> | null
  pending: string | null
}

type ChannelHandle = {
  name: string
  cleanup: ChannelCleanup
  throttleMs: number
  subscribers: Set<SynquxChannelHandlers<unknown>>

  /**
   * 既知の最新値 (payload 文字列)。synced では transport 配送の mirror、
   * standalone では唯一の置き場。後から subscribe した購読者への初期配送に使う
   */
  values: Map<string, string>

  transportUnsubscribe: Unsubscribe | null
  throttles: Map<string, ThrottleState>

  /**
   * per-key の transport 書き込み直列 chain。publish (fire-and-forget) と
   * remove の発行順を完了順として保証し、「remove の後に in-flight の set が
   * 着地して値が復活する」逆転を防ぐ (adapter 内部の await に依存しない)
   */
  opChains: Map<string, Promise<void>>

  /**
   * chain 上で実行待ちの publish の最新 payload (per-key 高々 1 slot)。
   * transport RTT が throttle 間隔を超えても queue が伸びない —
   * in-flight 中の publish は slot の payload 差し替え (coalesce) になる
   */
  queuedPublishes: Map<string, { payload: string }>

  /** publish 失敗ログの抑制 (高頻度経路のため成功まで 1 回だけ出す) */
  publishFailureLogged: boolean

  /** 同名 channel() が常に同一参照を返すための公開 API cache */
  api: SynquxChannel<unknown> | null
}

export type ChannelEngine = {
  channel(name: string, options?: SynquxChannelOptions): SynquxChannel<unknown>

  /**
   * session 開始時の attach。synced で transport が channels 未対応かつ handle が
   * 存在する場合は throw する (subscribe の fail-fast に合流)
   */
  attachSession(mode: SynquxMode): void

  /** session 終了時の detach。購読の解除・throttle の破棄・値 cache の破棄 */
  detachSession(): void
}

const transportSupportsChannels = (
  transport: SynquxTransport,
): transport is SynquxTransport &
  Required<
    Pick<
      SynquxTransport,
      'publishChannel' | 'removeChannelValue' | 'subscribeChannel'
    >
  > =>
  typeof transport.publishChannel === 'function' &&
  typeof transport.removeChannelValue === 'function' &&
  typeof transport.subscribeChannel === 'function'

export const createChannelEngine = (
  transport: SynquxTransport,
): ChannelEngine => {
  const handles = new Map<string, ChannelHandle>()
  let activeMode: SynquxMode | null = null

  /**
   * session の世代番号 (attach / detach で increment)。世代を跨いで実行される
   * queued op を実行時点で drop し、破棄済み session の書き込みが次 session へ
   * 漏れるのを防ぐ。実行開始済みの transport promise までは中断できない —
   * そこは adapter 側が内部 await 後の session 再検査で drop する (契約 14)
   */
  let sessionGeneration = 0

  /**
   * per-key の直列実行。op の失敗が chain を止めないよう、次の op は
   * 前段の成否によらず実行する。chain の末尾が自分なら完了時に掃除する
   */
  const enqueueKeyOp = (
    handle: ChannelHandle,
    key: string,
    op: () => Promise<void>,
  ): Promise<void> => {
    const generation = sessionGeneration
    const guarded = (): Promise<void> =>
      generation === sessionGeneration ? op() : Promise.resolve()

    const previous = handle.opChains.get(key) ?? Promise.resolve()
    const entry: Promise<void> = previous.then(guarded, guarded).finally(() => {
      if (handle.opChains.get(key) === entry) {
        handle.opChains.delete(key)
      }
    })
    handle.opChains.set(key, entry)
    return entry
  }

  const assertTransportSupport = (): void => {
    if (!transportSupportsChannels(transport)) {
      throw new Error(
        'synqux.channel() requires a transport with channel support (publishChannel / removeChannelValue / subscribeChannel, ADR-0028). Upgrade the transport adapter or subscribe with mode "standalone".',
      )
    }
  }

  const parsePayload = (
    handle: ChannelHandle,
    key: string,
    payload: string,
  ): { ok: true; value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: JSON.parse(payload) as unknown }
    } catch (error) {
      // 契約外データ (直書きや別バージョンの混入)。配送だけ skip して購読は続ける
      console.error(
        `[synqux] channel "${handle.name}" received an unparsable payload for key "${key}"`,
        error,
      )
      return { ok: false }
    }
  }

  const fanOutChanged = (
    handle: ChannelHandle,
    key: string,
    payload: string,
  ): void => {
    const parsed = parsePayload(handle, key, payload)
    if (!parsed.ok) {
      return
    }

    for (const subscriber of handle.subscribers) {
      try {
        subscriber.onChanged(key, parsed.value)
      } catch (error) {
        // 1 購読者の throw で他購読者への配送を止めない (listener effect と同じ隔離)
        console.error(error)
      }
    }
  }

  const fanOutRemoved = (handle: ChannelHandle, key: string): void => {
    for (const subscriber of handle.subscribers) {
      try {
        subscriber.onRemoved(key)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /** synced session 中、購読者のいる handle の transport 購読を開く */
  const openTransportSubscription = (handle: ChannelHandle): void => {
    if (
      activeMode !== 'synced' ||
      handle.transportUnsubscribe !== null ||
      handle.subscribers.size === 0 ||
      !transportSupportsChannels(transport)
    ) {
      return
    }

    handle.transportUnsubscribe = transport.subscribeChannel(handle.name, {
      onChanged: (key, payload) => {
        handle.values.set(key, payload)
        fanOutChanged(handle, key, payload)
      },
      onRemoved: (key) => {
        handle.values.delete(key)
        fanOutRemoved(handle, key)
      },
      onError: (error) => {
        // channel の配送喪失は sync の correctness に影響しない (契約 16)。
        // health へは載せず診断ログに留める
        console.error(
          `[synqux] channel "${handle.name}" subscription was cancelled`,
          error,
        )
      },
    })
  }

  const closeTransportSubscription = (handle: ChannelHandle): void => {
    handle.transportUnsubscribe?.()
    handle.transportUnsubscribe = null

    // synced の values は transport 配送の mirror のため、購読を閉じたら stale。
    // standalone の values は publish 側の正で、detach まで保持する
    if (activeMode !== 'standalone') {
      handle.values.clear()
    }
  }

  const clearThrottles = (handle: ChannelHandle): void => {
    for (const throttle of handle.throttles.values()) {
      if (throttle.timer !== null) {
        clearTimeout(throttle.timer)
      }
    }
    handle.throttles.clear()
  }

  /** throttle 通過後の実送信。session が閉じていたら drop する */
  const send = (handle: ChannelHandle, key: string, payload: string): void => {
    if (activeMode === 'standalone') {
      handle.values.set(key, payload)
      // RTDB の local echo と同じ観測順 (publish → 非同期で自端末へ配送) に揃える
      queueMicrotask(() => {
        if (activeMode === 'standalone' && handle.values.get(key) === payload) {
          fanOutChanged(handle, key, payload)
        }
      })
      return
    }

    if (activeMode !== 'synced' || !transportSupportsChannels(transport)) {
      return
    }

    // 実行待ちの publish があれば payload の差し替えだけで済ませる (LWW の
    // coalesce)。RTT > throttle 間隔でも per-key の queue は高々 1 に保たれる
    const queued = handle.queuedPublishes.get(key)
    if (queued !== undefined) {
      queued.payload = payload
      return
    }

    // per-key 直列 chain へ積む (発行順 = 完了順の保証)。publish は
    // fire-and-forget のため op 内で失敗を握り、chain と caller へ漏らさない
    const slot = { payload }
    handle.queuedPublishes.set(key, slot)
    void enqueueKeyOp(handle, key, () => {
      // 実行開始時点の最新 payload を掴む。以降の publish は新しい op になる。
      // identity 検査は remove barrier 後に登録された別 slot の誤削除防止
      if (handle.queuedPublishes.get(key) === slot) {
        handle.queuedPublishes.delete(key)
      }
      return transport
        .publishChannel(handle.name, key, slot.payload, {
          cleanup: handle.cleanup,
        })
        .then(() => {
          handle.publishFailureLogged = false
        })
        .catch((error: unknown) => {
          // 高頻度経路のため成功まで 1 回だけログする。継続的な失敗は購読側の
          // onError (契約 16) か transport 全体の失敗として観測される
          if (!handle.publishFailureLogged) {
            handle.publishFailureLogged = true
            console.error(
              `[synqux] channel "${handle.name}" publish failed`,
              error,
            )
          }
        })
    })
  }

  const publish = (
    handle: ChannelHandle,
    key: string,
    value: unknown,
  ): void => {
    assertValidSegment('key', key)

    const payload = JSON.stringify(value)
    if (payload === undefined) {
      throw new Error(
        `channel "${handle.name}" publish requires a JSON-serializable value (got undefined-serializing input for key "${key}")`,
      )
    }

    if (activeMode === null) {
      return
    }

    if (handle.throttleMs <= 0) {
      send(handle, key, payload)
      return
    }

    const throttle = handle.throttles.get(key)
    if (throttle !== undefined && throttle.timer !== null) {
      // window 中は最新値へ coalesce する (trailing で必ず送信される)
      throttle.pending = payload
      return
    }

    // leading: window 先頭は即時送信し、以後 throttleMs の間は trailing へ畳む
    send(handle, key, payload)
    const state: ThrottleState = { timer: null, pending: null }
    state.timer = setTimeout(() => {
      state.timer = null
      if (state.pending !== null) {
        const pending = state.pending
        state.pending = null
        // trailing 送信自体も次 window の leading として扱う (再帰で window 継続)
        publish(handle, key, JSON.parse(pending) as unknown)
        return
      }

      // pending なしで window を終えた state は掃除する (触れた key ぶんの
      // Map 成長を防ぐ)。再帰 publish 済みの場合は新 state に差し替え済み
      if (handle.throttles.get(key) === state) {
        handle.throttles.delete(key)
      }
    }, handle.throttleMs)
    handle.throttles.set(key, state)
  }

  const remove = async (handle: ChannelHandle, key: string): Promise<void> => {
    assertValidSegment('key', key)

    // 送信待ちの座標が削除後に着地して「消したのに残る」を作らないため先に破棄
    const throttle = handle.throttles.get(key)
    if (throttle !== undefined) {
      if (throttle.timer !== null) {
        clearTimeout(throttle.timer)
      }
      handle.throttles.delete(key)
    }

    if (activeMode === 'standalone') {
      if (handle.values.delete(key)) {
        queueMicrotask(() => {
          if (activeMode === 'standalone' && !handle.values.has(key)) {
            fanOutRemoved(handle, key)
          }
        })
      }
      return
    }

    if (activeMode !== 'synced' || !transportSupportsChannels(transport)) {
      return
    }

    // 実行待ち slot を coalesce 対象から外す — 以降の publish が barrier 前の
    // op へ吸われて「remove より先に着地する」順序逆転を防ぐ (slot 自体は
    // barrier 前の op が実行時に消化するため、publish2 → remove の順は保たれる)
    handle.queuedPublishes.delete(key)

    // in-flight の publish より後に着地させる (per-key 直列 chain)。
    // remove は意図的な操作のため publish と違い失敗を caller へ返す
    await enqueueKeyOp(handle, key, () =>
      transport.removeChannelValue(handle.name, key),
    )
  }

  const subscribe = (
    handle: ChannelHandle,
    handlers: SynquxChannelHandlers<unknown>,
  ): Unsubscribe => {
    handle.subscribers.add(handlers)
    openTransportSubscription(handle)

    // 既知 entry の初期配送 (この購読者だけへ)。transport 購読を今開いた場合は
    // values が空で、初期 entry は transport の一括配送 (契約 14) が全購読者へ届ける
    if (handle.values.size > 0) {
      const snapshot = [...handle.values.keys()]
      queueMicrotask(() => {
        if (!handle.subscribers.has(handlers)) {
          return
        }
        for (const key of snapshot) {
          // 配送時点の最新値を届ける (microtask 間に更新・削除された key は skip)
          const payload = handle.values.get(key)
          if (payload === undefined) {
            continue
          }
          const parsed = parsePayload(handle, key, payload)
          if (parsed.ok) {
            try {
              handlers.onChanged(key, parsed.value)
            } catch (error) {
              console.error(error)
            }
          }
        }
      })
    }

    return () => {
      handle.subscribers.delete(handlers)
      if (handle.subscribers.size === 0) {
        closeTransportSubscription(handle)
      }
    }
  }

  const buildChannelApi = (handle: ChannelHandle): SynquxChannel<unknown> => {
    handle.api ??= {
      publish: (key, value) => publish(handle, key, value),
      remove: (key) => remove(handle, key),
      subscribe: (handlers) => subscribe(handle, handlers),
    }
    return handle.api
  }

  return {
    channel(name, options) {
      assertValidSegment('name', name)

      const cleanup = options?.cleanup ?? 'none'
      const throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS

      const existing = handles.get(name)
      if (existing !== undefined) {
        if (
          existing.cleanup !== cleanup ||
          existing.throttleMs !== throttleMs
        ) {
          // 同名 channel の設定分裂は「後から呼んだ側が沈黙して負ける」より
          // fail-fast の方が調査しやすい (defineSynqux の registry と同じ思想)
          throw new Error(
            `channel "${name}" is already defined with different options (cleanup: ${existing.cleanup}, throttleMs: ${existing.throttleMs.toString()})`,
          )
        }
        return buildChannelApi(existing)
      }

      if (activeMode === 'synced') {
        assertTransportSupport()
      }

      const handle: ChannelHandle = {
        name,
        cleanup,
        throttleMs,
        subscribers: new Set(),
        values: new Map(),
        transportUnsubscribe: null,
        throttles: new Map(),
        opChains: new Map(),
        queuedPublishes: new Map(),
        publishFailureLogged: false,
        api: null,
      }
      handles.set(name, handle)
      return buildChannelApi(handle)
    },

    attachSession,
    detachSession,
  }

  function detachSession(): void {
    activeMode = null
    // queued (未実行) の transport write を実行時点で drop させる
    sessionGeneration += 1
    for (const handle of handles.values()) {
      clearThrottles(handle)
      handle.transportUnsubscribe?.()
      handle.transportUnsubscribe = null
      // standalone の値は session-scoped、synced の mirror は stale — どちらも破棄
      handle.values.clear()
      // drop される op の slot を残すと次 session の publish が coalesce 先を
      // 誤り、実行されない slot へ吸われて消えるため必ず破棄する
      handle.queuedPublishes.clear()
      // 旧 session の未解決 promise が残った chain に新 session の op を
      // 繋ぐと永久停止し得るため、chain の参照ごと切り離す (旧 entry の
      // finally は identity 検査のため新 chain を誤削除しない)
      handle.opChains.clear()
      handle.publishFailureLogged = false
    }
  }

  function attachSession(mode: SynquxMode): void {
    if (mode === 'synced' && handles.size > 0) {
      assertTransportSupport()
    }

    activeMode = mode
    sessionGeneration += 1
    try {
      for (const handle of handles.values()) {
        openTransportSubscription(handle)
      }
    } catch (error) {
      // 途中の subscribeChannel の同期 throw で「開き済み購読 + activeMode」を
      // 残さない。caller (subscribe 初期化) 側の cleanup 登録は attach 成功後の
      // ため、失敗の巻き戻しはここで自己完結させる
      detachSession()
      throw error
    }
  }
}
