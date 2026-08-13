import {
  createListenerMiddleware,
  isAction,
  type Action,
  type Dispatch,
  type Middleware,
  type Reducer,
  type UnknownAction,
} from '@reduxjs/toolkit'
import { waitUntilOrFail } from '@yano3nora/ts-utils'
import {
  APPLIED_WINDOW_SIZE,
  createOrdering,
  type OrderingState,
} from './ordering.js'
import { findFirstDivergence } from './diff.js'
import { deriveHostId } from './host.js'
import { localStorageSnapshotStore } from './local-storage.js'
import { selectIsHost, selectSelf } from './selectors.js'
import {
  buildSnapshotPayload,
  canonicalStringify,
  parseSnapshotPayload,
} from './snapshot.js'
import {
  synquxActions,
  synquxReducer,
  synquxRestored,
  type PendingRequest,
  type SynquxHealth,
  type SynquxPhase,
  type SynquxState,
} from './slice.js'
import {
  SYNQUX_SCHEMA_VERSION,
  type Peer,
  type PeerRole,
  type RequestEnvelope,
  type Result,
  type SnapshotStore,
  type SynquxActionMeta,
  type SynquxSynced,
  type SynquxTransport,
} from './types.js'

/**
 * 待機 fork の安全網タイムアウト (ms)
 *
 * fork の待機はイベント駆動 (waker) が主で、状態変化 (peer 増減・request 受信・
 * 適用完了) の notify で即時に再評価される。このタイムアウトは「notify の
 * 取りこぼし」に備えた保険であり、平常時のレイテンシには現れない
 */
const WAKE_FALLBACK_MS = 1000

/** gap の継続時間を評価する heartbeat 間隔。correctness には使わない */
const HEALTH_CHECK_INTERVAL_MS = 1000

/** automation 評価で取得済みの serverNow を request 化へ引き渡す端末内 marker */
const AUTOMATION_REQUESTED_AT = Symbol('synqux.automationRequestedAt')

const OK_HEALTH: SynquxHealth = {
  phase: 'ok',
  expectedSeq: null,
  maxSeenSeq: null,
  gapSince: null,
}

/**
 * イベント駆動待機のシグナル (ADR-0002 / イベント駆動化)
 * notify で全 waiter を起こす。timeout は安全網 (起きて再評価して損はない)
 *
 * export はユニットテスト用で、公開 API (src/index.ts) には含めない
 */
export const createWaker = () => {
  let waiters = new Set<() => void>()

  return {
    notify(): void {
      const pending = waiters
      waiters = new Set()
      for (const resolve of pending) {
        resolve()
      }
    },

    wait(timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          // timeout 経由でも自分を掃除する。notify 経由では既に新 Set に
          // 差し替わっているため delete は no-op (host 不在が長引いても
          // timeout 済み waiter が次の notify まで残留しない)
          waiters.delete(done)
          resolve()
        }
        const timer = setTimeout(done, timeoutMs)

        waiters.add(done)
      })
    },

    /** テスト用: 未解放 waiter 数 (メモリ有界性の検証にのみ使う) */
    waiterCount(): number {
      return waiters.size
    },
  }
}

export type CreateSynquxConfig<
  TRoot extends { synqux: SynquxState },
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
> = {
  transport: SynquxTransport

  /** 何を request 化するか。consumer の synced domain action の判定述語 */
  isSyncedAction: (action: Action) => action is TAction

  /** host が試し実行する判定器。通常 createSynquxRootReducer の返り値を渡す */
  rootReducer: Reducer<TRoot>

  /** 試し実行結果から result を読む位置。通常 createSynquxRootReducer の返り値を渡す */
  selectSynced: (root: TRoot) => TSynced

  /**
   * false で standalone (同期なし・host 常時 true) として動作する
   * runtime の on/off (tutorial 等) は actions.setEnabled で行う
   */
  enabled?: boolean

  /**
   * stall 判定のヒステリシス ms。「観測済み最大 seq が appliedSeq を超えたまま
   * appliedSeq がこの時間進まない」で stalled になる。一時遅配を誤検知しない
   * 値にすること。端末ローカル時刻は通知用であり correctness には使わない
   */
  stallAfterMs?: number

  /** readonly 端末などで request 送信自体を抑止する hook。既定は常に許可 */
  canRequest?: (root: TRoot) => boolean

  /**
   * standalone 時の synced state 永続化先。browser では省略時に localStorage を
   * 使い、false で明示的に無効化する。独自実装の SnapshotStore へ差し替え可能
   */
  localSnapshots?: SnapshotStore | false

  /**
   * 購読 phase の遷移通知。dataset 属性の付与 (E2E 用フラグ) など、接続状態に
   * 連動する定型処理を consumer の effect 監視なしで書くための hook。
   * 同値遷移では呼ばない
   */
  onPhaseChanged?: (phase: SynquxPhase) => void

  /**
   * subscribe の失敗・タイムアウト時の失敗遷移 (リロード案内等)。未設定のまま
   * 失敗すると「未接続なのに操作できるように見える」沈黙端末が残るため、
   * react consumer は必ず設定すること。手続き購読 (subscribe を直接 await する
   * 非 react consumer) がこれを設定した場合、呼び出し側の catch はログ程度に
   * 留めて政策を二重にしない
   */
  onSubscribeFailed?: (error: unknown) => void

  /**
   * 自動回復に失敗し unrecoverable へ遷移した瞬間の通知 (リロード案内など
   * consumer の失敗遷移用)。unsubscribe まで再発火しない
   */
  onUnrecoverable?: () => void

  /** host が synced state とサーバ時刻から評価する自動 dispatch rule */
  automations?: SynquxAutomation<TSynced, TAction>[]

  /**
   * host 生存監視 (ADR-0016)。host は heartbeatIntervalMs ごとに presence の
   * lastSeenAt をサーバ時刻で更新し、他端末は staleThresholdMs を超えて沈黙した
   * host を guest へ降格して host migration を促す (background tab の freeze 等で
   * 「presence は生きているが host が沈黙する」停止の恒久対策)。false で無効化。
   * 既定値 (30s / 180s) は TASK-260812 の実測に基づく。上書きする場合、
   * staleThresholdMs は「timer throttling 下の heartbeat 最悪間隔 (実測約 60s)」を
   * 十分上回る値にすること (throttle されているだけの機能する host を誤降格させない)
   */
  hostLiveness?: SynquxHostLiveness | false

  /**
   * 決定性検出網 (ADR-0001 Decision 8): host の試し実行結果と実適用後の synced を
   * 比較し、純粋性契約でも防げない非決定 reducer (Date.now / Math.random 等) を
   * dev モードで検出する。既定は NODE_ENV !== 'production'
   */
  devDeterminismCheck?: boolean
}

export type SynquxHostLiveness = {
  /** host が lastSeenAt を touch する間隔 ms。既定 30_000 */
  heartbeatIntervalMs?: number

  /** これを超えて heartbeat の無い host を降格する ms。既定 180_000 */
  staleThresholdMs?: number
}

export type SynquxAutomation<TSynced, TAction extends Action> = {
  /** rule の識別子。1 instance 内で一意であること */
  id: string

  /** action が必要かを synced state とサーバ基準時刻だけから判定する */
  when: (synced: TSynced, ctx: { now: number }) => boolean

  /** 通常の middleware 経路へ dispatch する synced action を構築する */
  action: (synced: TSynced) => TAction

  /** when が true のままの場合の再発行間隔。既定 1000ms */
  retryMs?: number
}

export type SynquxSubscribeOptions<TRoot> = {
  store: {
    dispatch: Dispatch
    getState: () => TRoot
  }
  groupId: string
  role?: Peer['role']
  label?: Peer['label']

  /**
   * subscribe 完了までの初期化 (接続確立・restore) の中断 (ADR-0012)。
   * 省略時は無期限に待つ — offline 起動は transport の自動再接続でそのまま
   * 復帰できるため、打ち切るかどうか・何秒待つかは consumer の UX 判断とする
   * (打ち切りたい場合は AbortSignal.timeout() 等を渡す)。
   * subscribe 完了後の切断には作用しない (返り値の unsubscribe を使う)
   */
  signal?: AbortSignal
}

export type Synqux<
  TRoot extends { synqux: SynquxState },
  TAction extends Action = Action,
> = {
  /**
   * store 構築時に prepend する middleware 群
   * `getDefaultMiddleware().prepend(...sync.middlewares)` の形で、
   * 配列順 (meta 付与 → host 判定 fork → 適用 fork → request 化) を崩さないこと
   */
  middlewares: Middleware[]

  /** 予約 key `state.synqux` に mount する内部 slice (primitive 方式用) */
  reducer: Reducer<SynquxState>

  /**
   * store 構築用の rootReducer (config で渡したものの echo)
   * createSynquxRootReducer の spread 方式だと consumer の手元に rootReducer が
   * 残らないため、configureStore への配線材料を instance 1 個に纏める
   */
  rootReducer: Reducer<TRoot>

  /**
   * presence 登録 → snapshot restore → requests 購読を開始する
   * standalone (enabled=false) 時は transport に触れず localSnapshots から
   * restore だけ行う。返り値で購読破棄 + presence 解除
   */
  subscribe: (
    options: SynquxSubscribeOptions<TRoot>,
  ) => Promise<() => Promise<void>>

  /**
   * 自端末の role を presence 上で切り替える。
   * subscribe 中でなければ throw。standalone (enabled=false) 時は no-op。
   * state 上の現在 role と同値なら transport 更新もしない。presence 反映ラグの
   * 窓では同値の重複 updateSelf が残り得るが、in-place 同値書き込みで無害
   */
  setRole: (role: PeerRole) => Promise<void>

  /**
   * synced action を dispatch し、その裁定結果を自端末で処理し終えるまで待つ。
   * success / error はいずれも resolve し、全端末での適用完了は保証しない。
   */
  dispatchAndWait: (
    action: TAction,
    options?: { signal?: AbortSignal },
  ) => Promise<Result<TAction>>

  actions: {
    /** tutorial 等で runtime に同期を on/off する */
    setEnabled: typeof synquxActions.setEnabled
  }

  /**
   * synqux/react の useLatestResult が synced の位置を解決するための内部 field。
   * ゲーム開発者はこれを直接使わず、result は自分の synced state から
   * `(s) => s.game.result` のように直接読むこと (SPEC-0002-public-api.md)
   */
  selectSynced: (root: TRoot) => SynquxSynced
}

export const createSynqux = <
  TRoot extends { synqux: SynquxState },
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
>(
  config: CreateSynquxConfig<TRoot, TSynced, TAction>,
): Synqux<TRoot, TAction> => {
  const { transport } = config
  const instanceEnabled = config.enabled ?? true
  const canRequest = config.canRequest ?? (() => true)
  const stallAfterMs = config.stallAfterMs ?? 30_000
  const automations = config.automations ?? []
  const localSnapshots = (() => {
    if (config.localSnapshots === false) {
      return undefined
    }
    if (config.localSnapshots) {
      return config.localSnapshots
    }
    // core の型環境は WebWorker も含み `window` global を前提にしないため、
    // globalThis 上の browser window を構造型で確認する。
    const browserWindow = (
      globalThis as { window?: { localStorage: typeof localStorage } }
    ).window
    if (browserWindow === undefined) {
      return undefined
    }

    try {
      // localStorage は存在しても SecurityError や容量制限で使用不能な環境がある。
      // create 時に一度だけ実書き込みで確認し、失敗時は永続化なしへ退避する。
      const probeKey = `__synqux_storage_probe__${Math.random().toString(36)}`
      browserWindow.localStorage.setItem(probeKey, probeKey)
      browserWindow.localStorage.removeItem(probeKey)
      return localStorageSnapshotStore()
    } catch {
      return undefined
    }
  })()
  const automationIds = new Set<string>()

  for (const automation of automations) {
    if (automationIds.has(automation.id)) {
      throw new Error(`Duplicate SynquxAutomation id: ${automation.id}`)
    }
    automationIds.add(automation.id)

    if (
      automation.retryMs !== undefined &&
      (!Number.isFinite(automation.retryMs) || automation.retryMs <= 0)
    ) {
      throw new Error(
        `SynquxAutomation retryMs must be a positive finite number: ${automation.id}`,
      )
    }
  }

  const hostLiveness =
    config.hostLiveness === false
      ? (false as const)
      : {
          heartbeatIntervalMs:
            config.hostLiveness?.heartbeatIntervalMs ?? 30_000,
          staleThresholdMs: config.hostLiveness?.staleThresholdMs ?? 180_000,
        }

  if (hostLiveness !== false) {
    for (const [key, value] of Object.entries(hostLiveness)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`hostLiveness.${key} must be a positive finite number`)
      }
    }
    // 1 回の heartbeat 欠落 (書き込み失敗等) で即 demote になる設定は dual-host 窓を
    // 無用に開くだけなので、生成時に拒否する
    if (hostLiveness.staleThresholdMs < hostLiveness.heartbeatIntervalMs * 2) {
      throw new Error(
        'hostLiveness.staleThresholdMs must be at least twice heartbeatIntervalMs',
      )
    }
  }

  // 処理済みリスト等の同期状態はすべてインスタンス内部に持つ (Decision 3)
  const ordering = createOrdering()
  let lastPrunedBeforeSeq = 0

  // 待機 fork をイベントで起こすシグナル。notify 点は「state 変化 = 再評価に
  // 値する事象」に限る: peer 増減 / request 受信 / 適用完了
  const waker = createWaker()

  const devDeterminismCheck =
    config.devDeterminismCheck ??
    (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

  /**
   * 決定性検出網: host が試し実行した synced (canonical JSON) を request id で
   * 控えておき、実適用後の synced と比較する。差分 = reducer が非決定
   * (Date.now / Math.random 等を読んでいる) 疑い。自端末が host のときのみ働く
   * best-effort な検出であり、同期の正しさ自体はこの検査に依存しない
   */
  const expectedSyncedByRequest = new Map<RequestEnvelope['id'], string>()

  const formatDivergedValue = (value: unknown): string => {
    const json = JSON.stringify(value)
    const rendered = json === undefined ? 'undefined' : json
    return rendered.length > 200 ? `${rendered.slice(0, 200)}...` : rendered
  }

  const verifyDeterminism = (
    id: RequestEnvelope['id'],
    actual: TSynced,
  ): void => {
    const expected = expectedSyncedByRequest.get(id)

    if (expected === undefined) {
      return
    }

    expectedSyncedByRequest.delete(id)

    const canonicalActual = canonicalStringify(actual)

    if (expected !== canonicalActual) {
      const divergence = findFirstDivergence(
        JSON.parse(expected),
        JSON.parse(canonicalActual),
      )
      const path = divergence?.path || '(root)'
      const expectedValue = formatDivergedValue(divergence?.expected)
      const actualValue = formatDivergedValue(divergence?.actual)

      console.error(
        `[synqux] Determinism check failed for request ${id}: ` +
          'the state applied locally differs from the host trial run. ' +
          'A synced reducer is probably non-deterministic (Date.now / Math.random / external reads). ' +
          `synced diverged at "${path}": expected ${expectedValue}, actual ${actualValue}`,
      )
    }
  }

  type PendingDispatch = {
    resolve: (result: Result<TAction>) => void
    reject: (reason: unknown) => void
    removeAbortListener: () => void
  }
  type SubscriptionSession = {
    groupId: string
    store: SynquxSubscribeOptions<TRoot>['store']
    pendingDispatches: Map<string, PendingDispatch>
  }

  // subscribe 後に確定する購読セッション。待機 resolver も session と共に破棄する。
  let session: SubscriptionSession | null = null
  // session 確定前の await 中も、同一 instance の並行初期化を同期的に拒否する
  let subscribing = false
  // phase dispatch と外部通知を同じ遷移点へ集約する。sessionEnded が state を先に
  // idle へ戻す cleanup 順でも、通知済み値を基準に idle を一度だけ通知できる。
  let lastNotifiedPhase: SynquxPhase = 'idle'
  const changePhase = (
    store: SynquxSubscribeOptions<TRoot>['store'],
    phase: SynquxPhase,
  ): void => {
    if (lastNotifiedPhase === phase) {
      return
    }

    store.dispatch(synquxActions.phaseChanged(phase))
    lastNotifiedPhase = phase
    try {
      config.onPhaseChanged?.(phase)
    } catch (error) {
      // dataset 更新等の consumer callback が投げても、購読の初期化・cleanup を
      // 中断して phase と実セッションを食い違わせない。
      console.error(error)
    }
  }

  const resultHash = (result: Result): string | undefined =>
    ((result.action as UnknownAction).meta as SynquxActionMeta | undefined)
      ?.hash

  const resolvePendingDispatch = (result: Result | null | undefined): void => {
    if (!session || !result) {
      return
    }

    const hash = resultHash(result)
    if (!hash) {
      return
    }

    const pending = session.pendingDispatches.get(hash)
    if (!pending) {
      return
    }

    session.pendingDispatches.delete(hash)
    pending.removeAbortListener()
    pending.resolve(result as Result<TAction>)
  }

  const endSubscriptionSession = (
    subscriptionSession: SubscriptionSession,
  ): void => {
    if (session !== subscriptionSession) {
      return
    }

    session = null
    const error = new Error('synqux was unsubscribed before dispatch completed')
    for (const pending of subscriptionSession.pendingDispatches.values()) {
      pending.removeAbortListener()
      pending.reject(error)
    }
    subscriptionSession.pendingDispatches.clear()
  }

  // action 適用 middleware から、現在の subscribe session に属する engine だけを
  // 起こす。未 subscribe / unsubscribe 後は no-op に戻して session leak を防ぐ。
  let evaluateAutomationsAfterApply: () => void = () => undefined

  type SubscribeCleanup = () => void | Promise<void>

  /**
   * 初期化と通常 unsubscribe で同じ逆順 cleanup を使う。rollback 時は個々の
   * cleanup 失敗を記録して続行し、呼び出し元が初期化時の元 error を rethrow する。
   */
  const runSubscribeCleanups = async (
    cleanups: readonly SubscribeCleanup[],
    rethrowCleanupFailure: boolean,
  ): Promise<void> => {
    let firstCleanupError: unknown

    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error) {
        console.error(error)
        firstCleanupError ??= error
      }
    }

    if (rethrowCleanupFailure && firstCleanupError !== undefined) {
      throw firstCleanupError
    }
  }

  let hashSequence = 0
  const generateHash = (): string =>
    `${Date.now().toString(36)}-${(hashSequence++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  /**
   * 「いつ永続化するか」の policy 点 (Decision 11)
   * v1 は移植元踏襲で「受理 request ごと」(host) /「適用 action ごと」(standalone)。
   * throttle 等の変更はこの 2 関数だけを差し替える
   */
  const persistSnapshot = async (
    synced: TSynced,
    orderingState: OrderingState,
  ): Promise<boolean> => {
    if (!session) {
      return false
    }

    return transport.saveSnapshot(
      session.groupId,
      buildSnapshotPayload({ synced, ordering: orderingState }),
      {
        epoch: orderingState.epoch,
        appliedSeq: orderingState.appliedSeq,
      },
    )
  }

  const persistLocalSnapshot = (root: TRoot): void => {
    if (!session || !localSnapshots) {
      return
    }

    const orderingState = ordering.state()
    // 移植元 saveGameState 踏襲で失敗は握りつぶす (standalone 永続化は best effort)
    void Promise.resolve(
      localSnapshots.saveSnapshot(
        session.groupId,
        buildSnapshotPayload({
          synced: config.selectSynced(root),
          ordering: orderingState,
        }),
        {
          epoch: orderingState.epoch,
          appliedSeq: orderingState.appliedSeq,
        },
      ),
    ).catch((e: unknown) => console.error(e))
  }

  // ---------------------------------------------------------------
  // 封筒の直列化・復元 (形状保存問題を core で一度だけ解く)
  // ---------------------------------------------------------------

  const serializeResult = (result: Result): string =>
    JSON.stringify({
      ...result,
      action: {
        ...result.action,
        // 永続化不要 & 重たい root を除去 (undefined は stringify で消える)
        meta: {
          ...((result.action as UnknownAction).meta as SynquxActionMeta),
          root: undefined,
        },
      },
    })

  const parseEnvelope = (envelope: RequestEnvelope): PendingRequest => ({
    id: envelope.id,
    requested: envelope.requested,
    requestedBy: envelope.requestedBy,
    responsedBy: envelope.responsedBy,
    responsed: envelope.responsed,
    epoch: envelope.epoch,
    seq: envelope.seq,
    action: {
      type: envelope.action.type,
      payload:
        envelope.action.payload === undefined
          ? undefined
          : JSON.parse(envelope.action.payload),
      meta: envelope.action.meta,
    },
    result:
      envelope.result === undefined
        ? undefined
        : (JSON.parse(envelope.result) as Result),
  })

  /**
   * result.log の console 出力 (ADR-0008)。出力は synqux の責務で、
   * targets 準拠 (空 = standalone 扱いで無条件出力) で自端末宛てのみ出す
   */
  const emitLog = (root: TRoot, result: Result): void => {
    if (!result.log) {
      return
    }

    const selfId = root.synqux.connections.selfId
    if (
      result.targets.length > 0 &&
      (!selfId || !result.targets.includes(selfId))
    ) {
      return
    }

    if (result.type === 'error') {
      console.error(result.log)
    } else {
      console.log(result.log)
    }
  }

  /**
   * 適用済み synced action が生んだ result の log を出力する。
   * host の試し実行は middleware を通らないため二重出力しない。過去 result の
   * 再出力は「直前 dispatch と同一 hash の result か」で防ぐ
   */
  const emitAppliedResultLog = (root: TRoot, action: UnknownAction): void => {
    const result = config.selectSynced(root).result

    if (!result?.log) {
      return
    }

    const actionHash = (action.meta as SynquxActionMeta | undefined)?.hash
    const resultHash = (
      (result.action as UnknownAction).meta as SynquxActionMeta | undefined
    )?.hash

    if (!actionHash || actionHash !== resultHash) {
      return
    }

    emitLog(root, result)
  }

  // ---------------------------------------------------------------
  // middlewares
  // ---------------------------------------------------------------

  /**
   * synced action へ hash / dispatched を付与する (移植元 actionMetaSetter 相当)
   * hash は「適用完了の検知」(内部 entities 破棄) と「result 通知の重複判定」の鍵
   */
  const metaSetterMiddleware: Middleware = () => (next) => (action) => {
    if (!isAction(action) || !config.isSyncedAction(action)) {
      return next(action)
    }

    const meta = (action as UnknownAction).meta as SynquxActionMeta | undefined

    if (meta?.hash) {
      return next(action)
    }

    return next({
      ...action,
      meta: {
        ...meta,
        hash: generateHash(),
        // 同期時は request 化の時点でサーバ基準時刻に上書きされる
        dispatched: meta?.dispatched ?? Date.now(),
      },
    })
  }

  /**
   * synced action を横取りして request 化する (移植元 actionRequestMiddleware 相当)
   * ローカル適用せず中断する = 楽観更新をしない。画面に出る state は常に
   * 「同期済み state」であり、画面と判定 state の恒常的なズレが構造上起きない
   */
  const actionRequestMiddleware: Middleware =
    (store) => (next) => async (action) => {
      if (!isAction(action)) {
        return next(action)
      }

      const state = store.getState() as TRoot
      const isSynced = config.isSyncedAction(action)
      const meta = (action as UnknownAction).meta as
        | SynquxActionMeta
        | undefined
      const selfId = state.synqux.connections.selfId
      const shouldRequest =
        instanceEnabled && state.synqux.enabled && !!selfId && !!session

      if (shouldRequest && isSynced && !meta?.requestedBy) {
        // readonly 端末などは request 送信自体を行わない (握りつぶす)
        if (!canRequest(state)) {
          return
        }

        // automation は evaluation path で取得した同一 serverNow を when と request
        // 時刻に使う。通常 dispatch は従来どおりここでサーバ時刻を取得する。
        const requested =
          (
            action as UnknownAction & {
              [AUTOMATION_REQUESTED_AT]?: number
            }
          )[AUTOMATION_REQUESTED_AT] ?? (await transport.serverNow())

        await transport.pushRequest({
          v: SYNQUX_SCHEMA_VERSION,
          groupId: session!.groupId,
          requested,
          requestedBy: selfId!,
          action: {
            type: action.type,
            // undefined 落ち対策で payload は JSON 文字列化して運ぶ
            ...((action as UnknownAction).payload === undefined
              ? {}
              : { payload: JSON.stringify((action as UnknownAction).payload) }),
            meta: {
              ...meta,
              requestedBy: selfId!,
              dispatched: requested,
            },
          },
        })

        // response を待たず中断する。どのみち request は全端末が受信 → dispatch する
        return
      }

      const applied = next(action)

      if (isSynced) {
        // 適用 (同期 dispatch・standalone 双方) が生んだ result.log を出力する
        emitAppliedResultLog(store.getState() as TRoot, action as UnknownAction)
        evaluateAutomationsAfterApply()
      }

      // standalone (instance 設定で無効) のときだけ localSnapshots へ永続化する。
      // runtime の setEnabled(false) (tutorial 等) では保存しない
      if (!instanceEnabled && isSynced) {
        persistLocalSnapshot(store.getState() as TRoot)
      }

      return applied
    }

  /**
   * request ごとの host 裁定 fork (ADR-0002)
   *
   * 全端末が request ごとに fork を持ち、「自分が host か」を監視し続ける。
   * fork は裁定 response の ack 後も終了せず、request が**適用されるまで**
   * 生存し (v1 の「応答済みまで」から延長)、
   * 自分が host のとき以下を裁定する:
   * - 未裁定の request → 通常の裁定 (試し実行 → seq 採番 → respond)
   * - seq スロットを別 request に取られた確定敗者 (dual-host 窓の産物) → 再裁定
   *
   * NOTE 前 host の「responded 済み・未適用」の in-flight 裁定は再採番しない
   * (誰かが適用済みかもしれず、再採番は適用列の分岐を作る)。直列ゲートで
   * その適用を待ってから次の裁定に進む
   */
  const hostForkActive = new Set<RequestEnvelope['id']>()

  const spawnHostFork = (
    listener: {
      getState: () => unknown
      fork: (fn: () => Promise<void>) => unknown
    },
    id: RequestEnvelope['id'],
  ): void => {
    if (hostForkActive.has(id)) {
      return
    }
    hostForkActive.add(id)

    listener.fork(async () => {
      try {
        while (true) {
          if (ordering.isApplied(id)) {
            break
          }

          // 裁定時刻 (調査用、ADR-0008)。current 読み取り → 直列ゲート判定 →
          // seq 発行 → 試し実行 → orderingState 評価固定の同期ブロックへ await を
          // 挟まないため、state を読む前に取得しておく (既知の問題①と同じ構図の
          // 予防)。取得失敗時は端末時計で代用する (correctness に不使用)
          const responsed = await transport.serverNow().catch(() => Date.now())

          const current = listener.getState() as TRoot
          const entity = current.synqux.requests.entities[id]
          const responsedBy = current.synqux.connections.selfId

          // entity 消滅 = 適用直後 (hash matcher が破棄済み)。接続切れも同様に離脱
          if (!entity || !responsedBy) {
            break
          }

          // host 昇格するまでは判定を行わない
          if (!selectIsHost(current)) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          const responded = entity.seq !== undefined

          if (responded) {
            // 窓より古い過去 → 適用済み扱いで破棄 (responseListener 側も破棄する)
            if (ordering.isBeyondWindow(entity.seq!)) {
              break
            }

            // 確定敗者 (スロットを別 request が消費) だけが再裁定の対象。
            // それ以外の responded は正当な in-flight であり、適用を待つのみ
            const isLoser =
              ordering.isStale(entity.seq!) && !ordering.isApplied(id)

            if (!isLoser) {
              await waker.wait(WAKE_FALLBACK_MS)
              continue
            }
          }

          // 直列裁定ゲート: 自分の発行済み or 他 host の in-flight (未適用の
          // responded) が残る間は、試し実行の土台 state が古いため裁定しない
          const hasInflight = Object.values(
            current.synqux.requests.entities,
          ).some(
            (pending) =>
              pending.seq !== undefined && pending.seq > ordering.appliedSeq(),
          )
          if (hasInflight || ordering.hasPendingIssue()) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          const epoch = ordering.beginHosting()
          const seq = ordering.issueSeq()

          let successfulAdjudication: {
            next: TRoot
            orderingState: OrderingState
          } | null = null
          let frozenResponse: Readonly<
            Parameters<SynquxTransport['respondRequest']>[1]
          >

          try {
            // reducer が唯一の判定器: rootReducer の試し実行で成否を判定する
            const next = config.rootReducer(current, entity.action as TAction)
            const result = config.selectSynced(next).result

            // snapshot へ載せる順序状態を ack await の「前」に評価固定する
            // (v1 の既知の問題①と同じ構図の再発防止)
            const orderingState = ordering.stateWith(seq, id)

            // 決定性検出網: 試し実行結果を控える。log 専用の error (message
            // なし) は dispatch されず実適用が発生しないため対象外
            if (
              devDeterminismCheck &&
              !(result?.type === 'error' && !result.message)
            ) {
              expectedSyncedByRequest.set(
                id,
                canonicalStringify(config.selectSynced(next)),
              )
            }

            // ここが裁定の確定点。以後の transport / snapshot 障害で内容を
            // 差し替えないよう、配信前に response 封筒を凍結する (ADR-0010)
            frozenResponse = Object.freeze({
              epoch,
              seq,
              responsedBy,
              responsed,
              result: result ? serializeResult(result) : null,
            })
            successfulAdjudication = { next, orderingState }
          } catch (e) {
            // reducer throw も正当な拒否裁定として、この時点で内容を確定する
            console.error(e)
            frozenResponse = Object.freeze({
              epoch,
              seq,
              responsedBy,
              responsed,
              result: serializeResult({
                action: entity.action as TAction,
                type: 'error',
                targets: [entity.requestedBy],
                // message なし = log 専用の拒否として dispatch を省略させる
                log: e instanceof Error ? e.message : String(e),
              }),
            })
          }

          let abandonedDelivery = false
          while (true) {
            try {
              await transport.respondRequest(id, frozenResponse)
              break
            } catch (respondError) {
              console.error(respondError)

              const latest = listener.getState() as TRoot
              const latestEntity = latest.synqux.requests.entities[id]
              const latestSelfId = latest.synqux.connections.selfId
              if (
                ordering.isApplied(id) ||
                !latestEntity ||
                !latestSelfId ||
                !selectIsHost(latest)
              ) {
                // 復帰後に同じ state から再裁定しても決定的に同値となり、
                // 二重発行時は fencing の tiebreak が収束させる (ADR-0002)
                ordering.retractIssue()
                abandonedDelivery = true
                break
              }

              await waker.wait(WAKE_FALLBACK_MS)
            }
          }

          if (abandonedDelivery) {
            // fork は終了せず、外側の既存分岐で host / entity / 適用を再評価する
            continue
          }

          if (successfulAdjudication) {
            try {
              const { next, orderingState } = successfulAdjudication
              const snapshotSaved = await persistSnapshot(
                config.selectSynced(next),
                orderingState,
              )

              // stale snapshot + prune の組は復元不能を作るため、snapshot が
              // 失敗した場合は同じ try 内の prune まで進めない。fenced-out 時も
              // 自分の prune 線は保存済み snapshot と無関係に先行し得るため、
              // 進むと stale snapshot + 封筒削除の復元不能を自ら作ってしまう。
              if (snapshotSaved) {
                const beforeSeq = orderingState.appliedSeq - APPLIED_WINDOW_SIZE
                if (
                  beforeSeq > 1 &&
                  beforeSeq > lastPrunedBeforeSeq &&
                  transport.pruneRequests
                ) {
                  lastPrunedBeforeSeq = beforeSeq
                  // retention は correctness のクリティカルパスではない。失敗時は
                  // 後続 snapshot のより新しい閾値で再試行されるため待たない。
                  void transport.pruneRequests(beforeSeq).catch(console.error)
                }
              }
            } catch (postProcessError) {
              // 確定済み response は後処理の成否にかかわらず変更しない
              console.error(postProcessError)
            }
          }

          // changed の適用完了まで fork を生存させ、敗者化も自ら再裁定する
        }
      } finally {
        hostForkActive.delete(id)
      }
    })
  }

  const requestListener = createListenerMiddleware()
  requestListener.startListening({
    actionCreator: synquxActions.requestAdded,
    effect: (action, listener) => {
      spawnHostFork(listener, action.payload.request.id)
      waker.notify() // 新規 request: 直列裁定ゲートの再評価を促す
    },
  })
  // 裁定済みで届いた request (restore / 再配送) にも敗者救済の watch が要るため、
  // changed 側からも host fork を立てる (active set で二重起動はしない)
  requestListener.startListening({
    actionCreator: synquxActions.requestChanged,
    effect: (action, listener) => {
      spawnHostFork(listener, action.payload.request.id)
      waker.notify() // 裁定の到着/更新: seq 待ちと勝者判定の再評価を促す
    },
  })
  // peer 増減で host が変わり得るため、昇格待機中の fork を起こす
  // (migration 回復の主経路。1000ms ポーリングは安全網に格下げ)
  requestListener.startListening({
    actionCreator: synquxActions.peerUpserted,
    effect: () => waker.notify(),
  })
  requestListener.startListening({
    actionCreator: synquxActions.peerRemoved,
    effect: () => waker.notify(),
  })

  /**
   * host 裁定済み request を適用する fork (ADR-0002)
   * ここで初めて request.action が全端末に dispatch される
   *
   * 適用規則は「appliedSeq + 1 の seq を持つ envelope を適用」。同一 seq に
   * 複数 request が衝突している場合 (dual-host 窓) は (epoch 降順,
   * responsedBy 辞書順降順) の決定的 tiebreak で勝者を選び、敗者は host の
   * 再裁定 (requestChanged で entity が新しい seq に上書きされる) を待つ
   */
  const responseListener = createListenerMiddleware()
  responseListener.startListening({
    actionCreator: synquxActions.requestChanged,
    effect: (action, listener) => {
      const { id } = action.payload.request

      listener.fork(async () => {
        while (true) {
          // 処理済み (または他 fork が処理中) なら自端末で反映済みのため破棄。
          // isProcessing は同一 changed の同時二重配送による二重 dispatch を防ぐ
          // 処理中ガード (v1 の既知の問題①′対策を継続)
          if (ordering.isApplied(id) || ordering.isProcessing(id)) {
            break
          }

          // 裁定印は再裁定で変わり得るため、fork の起動時 payload ではなく
          // 最新の entity を毎 loop 読み直す
          const current = listener.getState() as TRoot
          const entity = current.synqux.requests.entities[id]

          if (!entity || entity.seq === undefined) {
            // entity 消滅 = 他 fork が適用完了。裁定印なしは routing 上来ない
            break
          }

          const seq = entity.seq

          // 窓より古い過去は正史/敗者の区別記録がなく、適用済み扱いで破棄する
          // (restore 時の全量購読で届く歴史的 envelope はここで落ちる)
          if (ordering.isBeyondWindow(seq)) {
            break
          }

          if (ordering.isStale(seq)) {
            // 正史なら isApplied で break 済み → ここに来るのは dual-host 窓の
            // 敗者。host の再裁定 (新しい seq) を待つ
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // 先行する seq が未適用のあいだ待機する (順序の線形化)
          if (ordering.shouldWait(seq)) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // seq == appliedSeq + 1: 同一 seq の衝突があれば決定的 tiebreak
          const rivals = Object.values(current.synqux.requests.entities).filter(
            (pending) => pending.seq === seq,
          )
          const winner = rivals.reduce((best, candidate) => {
            const bestKey: [number, string] = [
              best.epoch ?? 0,
              best.responsedBy ?? '',
            ]
            const candidateKey: [number, string] = [
              candidate.epoch ?? 0,
              candidate.responsedBy ?? '',
            ]
            return candidateKey[0] > bestKey[0] ||
              (candidateKey[0] === bestKey[0] && candidateKey[1] > bestKey[1])
              ? candidate
              : best
          })

          if (winner.id !== id) {
            // 自分は敗者候補: 勝者の適用 → 自分の再裁定を待つ
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // log 専用の error (message なし) は UI に出すデータがなく、
          // 負荷軽減のため dispatch せず console へ直接出力する (ADR-0008)
          if (entity.result?.type === 'error' && !entity.result.message) {
            emitLog(current, entity.result)
            ordering.markApplied(seq, id)
            waker.notify() // 適用完了: 次の seq を待つ fork を起こす
            resolvePendingDispatch(entity.result)
            break
          }

          // dispatch 直前 (await を挟まず同期的) にガードを立てる。
          // seq 待機 loop 内で立てると fork が死んだとき誰も処理できなくなる
          ordering.beginProcessing(id)

          try {
            listener.dispatch(entity.action as TAction)

            // 決定性検出網: 実適用後の synced を host の試し実行結果と照合する。
            // dispatch は同期のため、await を挟まないここでの getState() だけが
            // 「この request 適用直後」の state を正確に指す — 以前は下の entity
            // 消滅待ち (interval poll) の後に読んでいたため、poll の初回判定までに
            // 次の request が適用されると false positive になった (TASK-260810)
            verifyDeterminism(
              id,
              config.selectSynced(listener.getState() as TRoot),
            )

            // dispatch は同期で、成功した時点で適用は確定している。markApplied を
            // ここ (dispatch 直後・await なし) で行い、「entity は消えたが
            // appliedSeq が進んでいない」観測窓を作らない — この窓があると
            // 他 fork が rival 消失を「自分が勝者」と誤認し得る。
            // NOTE dispatch **前**への前倒しは不可 (失敗時に seq が永久欠番になる)
            ordering.markApplied(seq, id)
            waker.notify() // 適用完了: 次の seq を待つ fork を起こす
            resolvePendingDispatch(
              config.selectSynced(listener.getState() as TRoot).result,
            )

            // 内部 entities からの破棄 (同 hash の action 通過) を確認してから
            // fork を終える。通常は dispatch 内で同期完了しており即座に通る
            await waitUntilOrFail(
              () =>
                !(listener.getState() as TRoot).synqux.requests.entities[id],
              { intervalMillis: WAKE_FALLBACK_MS },
            )
          } finally {
            // markApplied 済みなら不要。失敗時も解放し、再配送での retry 余地を残す
            ordering.endProcessing(id)
          }

          break
        }
      })
    },
  })

  // ---------------------------------------------------------------
  // subscribe (受信ルーティング / restore / presence)
  // ---------------------------------------------------------------

  const initializeSubscription = async (
    { store, groupId, role, label, signal }: SynquxSubscribeOptions<TRoot>,
    cleanups: SubscribeCleanup[],
  ): Promise<() => Promise<void>> => {
    if (store.getState().synqux === undefined) {
      throw new Error(
        'state.synqux is not mounted. Wire sync.reducer (or createSynquxRootReducer) into your root reducer.',
      )
    }

    changePhase(store, 'subscribing')
    // 失敗 rollback 時に sessionEnded の cleanup がまだ積まれていなくても
    // 'subscribing' のまま取り残さないよう、phase の復帰は独立した cleanup で持つ
    cleanups.push(() => {
      changePhase(store, 'idle')
    })

    /**
     * rule の retry 状態と interval は subscribe session に閉じ込める。
     * 発行時刻は dispatch 前に記録し、同期的な再評価でも同じ rule を二重発行しない。
     */
    const startAutomationEngine = (
      subscriptionSession: SubscriptionSession,
    ): void => {
      if (automations.length === 0) {
        return
      }

      const lastIssuedAt = new Map<string, number>()
      let active = true
      const isAutomationHost = (root: TRoot): boolean => {
        if (!instanceEnabled) {
          return true
        }

        const { selfId, entities } = root.synqux.connections
        return !!selfId && deriveHostId(Object.values(entities)) === selfId
      }

      const evaluate = async (): Promise<void> => {
        if (!active || session !== subscriptionSession) {
          return
        }

        const beforeTime = store.getState()
        if (!isAutomationHost(beforeTime) || !canRequest(beforeTime)) {
          return
        }

        // 1 evaluation path につき時刻取得は 1 回。standalone は transport に
        // 接続しないため端末時刻を使い、全 rule で同じ now を共有する。
        let now: number
        try {
          now = instanceEnabled ? await transport.serverNow() : Date.now()
        } catch {
          // 時刻を得られなければ安全に発行できない。次の path で再試行する。
          return
        }

        if (!active || session !== subscriptionSession) {
          return
        }

        const root = store.getState()
        if (!isAutomationHost(root) || !canRequest(root)) {
          return
        }

        const synced = config.selectSynced(root)

        for (const automation of automations) {
          const retryMs = automation.retryMs ?? 1000
          const lastIssued = lastIssuedAt.get(automation.id)

          if (lastIssued !== undefined && now - lastIssued < retryMs) {
            continue
          }

          let shouldIssue: boolean
          try {
            shouldIssue = automation.when(synced, { now })
          } catch (error) {
            console.error(error)
            continue
          }

          if (!shouldIssue) {
            continue
          }

          let action: TAction
          try {
            action = automation.action(synced)
          } catch (error) {
            console.error(error)
            continue
          }

          if (!config.isSyncedAction(action)) {
            console.error(
              `[synqux] Automation "${automation.id}" returned a non-synced action; skipped.`,
            )
            continue
          }

          lastIssuedAt.set(automation.id, now)
          try {
            // pushRequest の reject を含む非同期失敗は次回 retry に委ねる。
            void Promise.resolve(
              store.dispatch({
                ...action,
                [AUTOMATION_REQUESTED_AT]: now,
              }),
            ).catch(() => undefined)
          } catch {
            // middleware が同期 throw した場合も engine 自体は止めない。
          }
        }
      }

      const evaluateAfterApply = (): void => {
        void evaluate()
      }
      evaluateAutomationsAfterApply = evaluateAfterApply

      const tickMs = Math.min(
        ...automations.map((automation) => automation.retryMs ?? 1000),
      )
      const timer = setInterval(() => void evaluate(), tickMs)

      cleanups.push(() => {
        // serverNow await 中の evaluation も、再開時の active 検査で発行を止める。
        active = false
        clearInterval(timer)
        lastIssuedAt.clear()
        if (evaluateAutomationsAfterApply === evaluateAfterApply) {
          evaluateAutomationsAfterApply = () => undefined
        }
      })
    }

    /**
     * host liveness (ADR-0016): 自分が host の間は heartbeat で生存を可視化し、
     * そうでない間は導出 host の staleness を監視して guest へ demote する。
     * demote は presence の変化として全端末へ配送され、既存の host migration に
     * 合流する — deriveHostId は pool の純粋関数のまま変えない。
     * 評価は heartbeatIntervalMs の周期 tick のみ: staleness は時間経過でしか
     * 進行しないため、イベント駆動の再評価を足しても検知は早まらない
     */
    const startHostLivenessEngine = (
      subscriptionSession: SubscriptionSession,
    ): void => {
      if (hostLiveness === false) {
        return
      }

      let active = true
      // serverNow / demote の await 中に次 tick が重ならないよう同期ガードを立てる
      // (check-then-act の間に await を挟まない、の AGENTS 原則の適用)
      let inFlight = false

      /**
       * 「現在の host をいつから host として観測しているか」の端末ローカル時刻。
       * 一度 host を降りた端末が古い lastSeenAt を持ったまま再昇格した直後に、
       * observer が即 demote する誤検知を防ぐヒステリシス。health timer の
       * Date.now と同様、correctness には使わず判定の猶予にだけ使う
       */
      let observedHostId: string | null = null
      let observedHostSince = 0

      const tick = async (): Promise<void> => {
        if (!active || session !== subscriptionSession || inFlight) {
          return
        }

        const { selfId, entities } = store.getState().synqux.connections
        if (!selfId) {
          return
        }

        const hostId = deriveHostId(Object.values(entities)) ?? null
        if (hostId !== observedHostId) {
          observedHostId = hostId
          observedHostSince = Date.now()
        }
        if (hostId === null) {
          return
        }

        inFlight = true
        try {
          if (hostId === selfId) {
            // 自分が host: 生存を書く。失敗は次 tick の retry に委ねる (automations
            // と同じ政策 — heartbeat が書けない状態が続けば demote されるのが正しい)
            await transport.heartbeat().catch(() => undefined)
            return
          }

          // observer: host の観測開始から閾値経過するまでは判定しない (上記の再昇格
          // 直後ケースと、途中参加直後に古い pool 観で demote するケースの両方を防ぐ)
          if (Date.now() - observedHostSince < hostLiveness.staleThresholdMs) {
            return
          }

          let now: number
          try {
            now = await transport.serverNow()
          } catch {
            return
          }
          if (!active || session !== subscriptionSession) {
            return
          }

          // await 中の pool 変化を拾い直し、host が替わっていたら判定しない
          const currentEntities = store.getState().synqux.connections.entities
          const peers = Object.values(currentEntities)
          if (deriveHostId(peers) !== hostId) {
            return
          }
          const host = currentEntities[hostId]
          if (host === undefined) {
            return
          }

          // lastSeenAt 未記録 (一度も heartbeat していない新 host) は connected 起点
          const lastSeen = Math.max(host.lastSeenAt ?? 0, host.connected)
          if (now - lastSeen <= hostLiveness.staleThresholdMs) {
            return
          }

          // 候補不在ガード: demote しても host 不在の完全停止になるだけなら悪化を
          // 避けて何もしない (次 tick で pool が変わっていれば再評価される)
          const demotedPool = peers.map((peer) =>
            peer.id === hostId ? { ...peer, role: 'guest' as const } : peer,
          )
          if (deriveHostId(demotedPool) === undefined) {
            return
          }

          // 複数 observer の同時 demote は同値書き込みで冪等 (transport 契約 11)。
          // 失敗は握りつぶし、stale が続いていれば次 tick で再評価する
          await transport.demotePeer(hostId).catch(() => undefined)
        } finally {
          inFlight = false
        }
      }

      const timer = setInterval(
        () => void tick(),
        hostLiveness.heartbeatIntervalMs,
      )
      cleanups.push(() => {
        active = false
        clearInterval(timer)
      })
    }

    // ---- standalone: transport に触れず local restore だけ行う ----
    if (!instanceEnabled) {
      const subscriptionSession: SubscriptionSession = {
        groupId,
        store,
        pendingDispatches: new Map(),
      }
      session = subscriptionSession
      cleanups.push(() => endSubscriptionSession(subscriptionSession))
      store.dispatch(
        synquxActions.sessionStarted({ selfId: null, enabled: false }),
      )
      cleanups.push(() => {
        expectedSyncedByRequest.clear()
        store.dispatch(synquxActions.sessionEnded())
      })

      const payload = await localSnapshots?.loadSnapshot(groupId)
      signal?.throwIfAborted()

      if (payload) {
        const envelope = parseSnapshotPayload(payload)
        ordering.restore(envelope.ordering)
        expectedSyncedByRequest.clear()
        store.dispatch(
          synquxRestored({ synced: clearRestoredResult(envelope.synced) }),
        )
      }

      startAutomationEngine(subscriptionSession)

      changePhase(store, 'live')

      return async () => {
        await runSubscribeCleanups(cleanups, true)
      }
    }

    // ---- synced: presence 登録 → restore → requests 購読 ----

    const healthEquals = (left: SynquxHealth, right: SynquxHealth): boolean =>
      left.phase === right.phase &&
      left.expectedSeq === right.expectedSeq &&
      left.maxSeenSeq === right.maxSeenSeq &&
      left.gapSince === right.gapSince

    let unrecoverableNotified = false
    const updateHealth = (health: SynquxHealth): void => {
      const previous = store.getState().synqux.health
      if (healthEquals(previous, health)) {
        return
      }

      store.dispatch(synquxActions.healthChanged(health))
      if (
        !unrecoverableNotified &&
        previous.phase !== 'unrecoverable' &&
        health.phase === 'unrecoverable'
      ) {
        unrecoverableNotified = true
        try {
          config.onUnrecoverable?.()
        } catch (error) {
          // consumer の失敗 UI callback が投げても、購読 teardown や回復処理を
          // 止めず、診断可能な形で console にだけ残す。
          console.error(error)
        }
      }
    }

    // 購読の回復不能な打ち切り (permission denied 等、transport 契約 8、ADR-0012)。
    // 自動 retry しない — rules ミス等は購読し直しても失敗し続けるだけなので、
    // unrecoverable を提示して unsubscribe → 再 subscribe の判断を consumer に委ねる
    let torndown = false
    let fatalHealth: SynquxHealth | null = null
    const handleTransportError = (error: unknown): void => {
      if (torndown || fatalHealth !== null) {
        return
      }

      fatalHealth = {
        phase: 'unrecoverable',
        expectedSeq: ordering.appliedSeq() + 1,
        maxSeenSeq: ordering.maxSeenSeq(),
        gapSince: Date.now(),
      }
      console.error(
        '[synqux] Transport subscription was terminated (permission denied etc). ' +
          'Sync is unrecoverable until unsubscribe / resubscribe.',
        error,
      )

      // 即時通知は best effort (setEnabled off 中は heartbeat 側の裁定に任せる)
      if (store.getState().synqux.enabled) {
        updateHealth(fatalHealth)
      }
    }

    const { selfId } = await transport.connect({ groupId, role, label, signal })
    cleanups.push(() => transport.disconnect())
    signal?.throwIfAborted()

    const unsubscribePeers = transport.subscribePeers({
      onAdded: (peer) => store.dispatch(synquxActions.peerUpserted(peer)),
      onChanged: (peer) => store.dispatch(synquxActions.peerUpserted(peer)),
      onRemoved: (peer) => store.dispatch(synquxActions.peerRemoved(peer.id)),
      onError: handleTransportError,
    })
    cleanups.push(unsubscribePeers)

    store.dispatch(synquxActions.sessionStarted({ selfId, enabled: true }))
    cleanups.push(() => {
      expectedSyncedByRequest.clear()
      store.dispatch(synquxActions.sessionEnded())
    })

    // 復帰端末は snapshot (synced + 順序状態) を復元してから requests を購読する。
    // 途中参加・リロード・host migration をまたいでも状態と順序保証が継続する
    const payload = await transport.loadSnapshot(groupId)
    signal?.throwIfAborted()

    if (payload) {
      const envelope = parseSnapshotPayload(payload)
      ordering.restore(envelope.ordering)
      expectedSyncedByRequest.clear()
      store.dispatch(
        synquxRestored({ synced: clearRestoredResult(envelope.synced) }),
      )
    }

    const rejectUnknownSchema = (envelope: RequestEnvelope): boolean => {
      if (envelope.v === SYNQUX_SCHEMA_VERSION) {
        return false
      }

      // wire format の新旧混在は黙って無視せず、明示的に拒否して運用側に知らせる
      console.error(
        `[synqux] Rejected request ${envelope.id}: unsupported schema version ${String(envelope.v)}`,
      )
      return true
    }

    // NOTE after (id 辞書順フィルタ) は使わない: id 順は端末時計依存で
    // 「id は古いが seq は新しい」request を取り逃がすため、全量購読して
    // 適用済み分は seq / 直近窓で破棄する (ADR-0002 Decision 5)。再取得コストは
    // transport の retention 契約 (snapshot 地点より古い requests の prune) で抑える
    const requestHandlers: Parameters<SynquxTransport['subscribeRequests']>[1] =
      {
        onAdded: (envelope) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          // 同一 request の added 重複配送 (遅延ののち重複) を破棄する
          if (!ordering.acceptAdded(envelope.id)) {
            return
          }

          const request = parseEnvelope(envelope)
          ordering.observe({ epoch: request.epoch, seq: request.seq })

          // restore タイミング次第で裁定済み request が added で届く。
          // 裁定済みのものは changed 相当として適用側の待機 loop に回す
          if (request.responsedBy) {
            store.dispatch(synquxActions.requestChanged({ request }))
            return
          }

          store.dispatch(synquxActions.requestAdded({ request }))
        },

        onChanged: (envelope) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          const request = parseEnvelope(envelope)

          // host により裁定されたものだけ受け取る
          if (!request.responsedBy) {
            return
          }

          ordering.observe({ epoch: request.epoch, seq: request.seq })
          store.dispatch(synquxActions.requestChanged({ request }))
        },

        onError: handleTransportError,
      }

    // 再購読ではこの関数から同じ routing を開き直す。unsubscribe closure も
    // 常に最新の購読を参照し、初回購読だけを解除する leak を避ける。
    const openRequestsSubscription = (): (() => void) =>
      transport.subscribeRequests({}, requestHandlers)

    let unsubscribeRequests = openRequestsSubscription()
    cleanups.push(() => unsubscribeRequests())

    let gapStartedAt: number | null = null
    let lastAppliedSeq = ordering.appliedSeq()
    let recoveryStage: 'none' | 'resubscribed' | 'restored' = 'none'
    let stageStartedAt: number | null = null
    let recoveryInFlight = false

    const resetRecovery = (): void => {
      recoveryStage = 'none'
      stageStartedAt = null
      recoveryInFlight = false
    }

    const recoveryHealth = (
      phase: Exclude<SynquxHealth['phase'], 'ok'>,
      applied: number,
      maxSeen: number,
    ): SynquxHealth => ({
      phase,
      expectedSeq: applied + 1,
      maxSeenSeq: maxSeen,
      gapSince: gapStartedAt,
    })

    const subscriptionSession: SubscriptionSession = {
      groupId,
      store,
      pendingDispatches: new Map(),
    }
    session = subscriptionSession
    cleanups.push(() => endSubscriptionSession(subscriptionSession))

    const restoreFromLatestSnapshot = async (): Promise<void> => {
      recoveryInFlight = true
      const appliedBeforeLoad = ordering.appliedSeq()

      try {
        const latestPayload = await transport.loadSnapshot(groupId)

        // load 中に unsubscribe されたセッションへ state を dispatch しない。
        if (session !== subscriptionSession) {
          return
        }

        const applied = ordering.appliedSeq()
        const maxSeen = ordering.maxSeenSeq()

        // await 中に欠落 envelope が遅着した場合は自然回復を優先する。
        // 古い snapshot でその進行を上書きしないため、必ず await 後に再判定する。
        if (applied > appliedBeforeLoad || maxSeen <= applied) {
          gapStartedAt = null
          lastAppliedSeq = applied
          resetRecovery()
          updateHealth(OK_HEALTH)
          return
        }

        if (latestPayload) {
          const envelope = parseSnapshotPayload(latestPayload)

          // fencing により同値 snapshot も正史として信頼できる。同値受理は
          // dual-host 早期適用の同 seq 分岐を正史へ引き戻す唯一の手段であり、
          // 健全端末に対しては冪等な restore になる。
          if (envelope.ordering.appliedSeq >= applied) {
            // restore と dispatch は await を挟まない同期ブロックにし、待機 fork の
            // 適用と restore が中途半端な ordering/state の組を観測しないようにする。
            ordering.restore(envelope.ordering)
            expectedSyncedByRequest.clear()
            store.dispatch(
              synquxRestored({
                synced: clearRestoredResult(envelope.synced),
              }),
            )
            waker.notify()

            // 再裁定 envelope を isApplied 残留で破棄した fork は break 済みで
            // 死んでいる。resubscribe (stage a) は restore (stage b) より前に
            // 走るため、restore で purge しても再処理する主体がいない。
            // 二重 fork は isApplied / isProcessing / entity 消滅 / tiebreak の
            // 既存ガードが吸収するため、未適用の裁定済み entity を再評価する。
            for (const request of Object.values(
              store.getState().synqux.requests.entities,
            )) {
              if (
                request.seq !== undefined &&
                !ordering.isApplied(request.id)
              ) {
                store.dispatch(synquxActions.requestChanged({ request }))
              }
            }
          }
        }

        recoveryStage = 'restored'
        stageStartedAt = Date.now()
      } finally {
        recoveryInFlight = false
      }
    }

    /**
     * envelope の在否ではなく ordering の進行だけを見る。dual-host の敗者を先に
     * 適用した stall では、再裁定 envelope が entities に残ったままになるため。
     * Date.now はヒステリシスと診断表示にしか使わず、適用順の correctness は
     * 引き続き host 採番 seq だけで決まるため端末時計で十分。
     */
    const healthTimer = setInterval(() => {
      const applied = ordering.appliedSeq()

      if (!store.getState().synqux.enabled) {
        gapStartedAt = null
        lastAppliedSeq = applied
        resetRecovery()
        updateHealth(OK_HEALTH)
        return
      }

      // transport 購読の打ち切りは gap の有無と無関係に回復不能 (ADR-0012)。
      // gap なし (maxSeen <= applied) の ok 巻き戻しより先に判定する
      if (fatalHealth !== null) {
        updateHealth(fatalHealth)
        return
      }

      const maxSeen = ordering.maxSeenSeq()
      const now = Date.now()

      if (applied > lastAppliedSeq || maxSeen <= applied) {
        gapStartedAt = null
        resetRecovery()
        lastAppliedSeq = applied
        updateHealth(OK_HEALTH)
        return
      }
      lastAppliedSeq = applied

      if (maxSeen > applied && gapStartedAt === null) {
        gapStartedAt = now
      }

      if (gapStartedAt === null || now - gapStartedAt < stallAfterMs) {
        updateHealth(OK_HEALTH)
        return
      }

      if (recoveryStage === 'none') {
        // stalled は consumer が検知できる遷移状態とし、次 heartbeat で (a) を始める。
        if (store.getState().synqux.health.phase !== 'stalled') {
          updateHealth(recoveryHealth('stalled', applied, maxSeen))
          return
        }

        // (a) は配送欠落を全量再配送で治す段階。added dedup を先に reset
        // しなければ、まさに取り直したい envelope 自体を握りつぶしてしまう。
        ordering.resetAddedGuard()
        unsubscribeRequests()
        unsubscribeRequests = openRequestsSubscription()
        recoveryStage = 'resubscribed'
        stageStartedAt = now
        updateHealth(recoveryHealth('recovering', applied, maxSeen))
        return
      }

      if (store.getState().synqux.health.phase === 'unrecoverable') {
        updateHealth(recoveryHealth('unrecoverable', applied, maxSeen))
        return
      }

      updateHealth(recoveryHealth('recovering', applied, maxSeen))

      if (
        recoveryStage === 'resubscribed' &&
        !recoveryInFlight &&
        stageStartedAt !== null &&
        now - stageStartedAt >= stallAfterMs
      ) {
        // (b) は isApplied ガードで再配送が効かない dual-host 早期適用を、
        // 正史 snapshot へ置換して治す段階。
        void restoreFromLatestSnapshot().catch((error: unknown) => {
          console.error(error)
          if (session === subscriptionSession) {
            recoveryStage = 'restored'
            stageStartedAt = Date.now()
          }
        })
        return
      }

      if (
        recoveryStage === 'restored' &&
        stageStartedAt !== null &&
        now - stageStartedAt >= stallAfterMs
      ) {
        // 1 gap エピソード 1 巡で止める。無限 retry は transport 障害時の
        // 帯域消費と consumer の reload loop を作るだけで、correctness を増さない。
        updateHealth(recoveryHealth('unrecoverable', applied, maxSeen))
      }
    }, HEALTH_CHECK_INTERVAL_MS)
    cleanups.push(() => clearInterval(healthTimer))

    // 最後に push = 逆順 teardown の先頭で立つ。以後に遅れて届く transport の
    // onError が、破棄済み session の store へ health を書き込むのを防ぐ
    cleanups.push(() => {
      torndown = true
    })

    startAutomationEngine(subscriptionSession)
    startHostLivenessEngine(subscriptionSession)

    changePhase(store, 'live')

    return async () => {
      await runSubscribeCleanups(cleanups, true)
    }
  }

  const subscribe = async (
    options: SynquxSubscribeOptions<TRoot>,
  ): Promise<() => Promise<void>> => {
    if (session || subscribing) {
      throw new Error('synqux is already subscribed')
    }

    // check-then-act の間に await を挟まず、初期化中であることを先に確定する。
    subscribing = true
    const cleanups: SubscribeCleanup[] = []

    try {
      // 既に abort 済みの場合も subscribe 失敗政策の対象にするため、共通の
      // rollback / onSubscribeFailed 経路へ入れてから初期化を始める。
      options.signal?.throwIfAborted()
      return await initializeSubscription(options, cleanups)
    } catch (error) {
      // ordering.restore 済みでも次回の全量 restore が完全置換するため rollback
      // しない。その他の副作用は逆順に片付け、cleanup 失敗より元 error を優先する。
      await runSubscribeCleanups(cleanups, false)
      if (config.onSubscribeFailed) {
        try {
          config.onSubscribeFailed(error)
        } catch (callbackError) {
          // consumer の失敗遷移が投げても、手続き購読へ返す元の失敗を変えない。
          console.error(callbackError)
        }
      } else {
        console.error(
          '[synqux] subscribe failed and no onSubscribeFailed is configured. The device may be left silently unconnected.',
          error,
        )
      }
      throw error
    } finally {
      subscribing = false
    }
  }

  const dispatchAndWait = (
    action: TAction,
    options?: { signal?: AbortSignal },
  ): Promise<Result<TAction>> => {
    const subscriptionSession = session
    if (!subscriptionSession) {
      throw new Error(
        'synqux is not subscribed. Call subscribe() before dispatchAndWait().',
      )
    }
    if (!config.isSyncedAction(action)) {
      return Promise.reject(
        new Error('dispatchAndWait requires a synced action'),
      )
    }

    const root = subscriptionSession.store.getState()
    const shouldRequest =
      instanceEnabled && root.synqux.enabled && !!root.synqux.connections.selfId
    if (shouldRequest && !canRequest(root)) {
      return Promise.reject(
        new Error('dispatchAndWait cannot dispatch while canRequest is false'),
      )
    }

    const signal = options?.signal
    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    const hash = generateHash()
    const source = action as UnknownAction
    const meta = source.meta as SynquxActionMeta | undefined
    const dispatchedAction = {
      ...source,
      meta: {
        ...meta,
        hash,
        // meta setter は既存 hash を尊重して素通しするため、standalone でも通常の
        // dispatch と同じ形になるよう dispatched もここで補う。
        dispatched: meta?.dispatched ?? Date.now(),
      },
    } as unknown as TAction

    return new Promise<Result<TAction>>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = subscriptionSession.pendingDispatches.get(hash)
        if (!pending) {
          return
        }
        subscriptionSession.pendingDispatches.delete(hash)
        pending.removeAbortListener()
        reject(signal?.reason)
      }
      const removeAbortListener = (): void =>
        signal?.removeEventListener('abort', onAbort)

      subscriptionSession.pendingDispatches.set(hash, {
        resolve,
        reject,
        removeAbortListener,
      })
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        // request 経路の push failure は次の transport 回復を待つ契約であり、
        // dispatchAndWait 自体の reject 理由にはしない。consumer は AbortSignal で
        // 待機期限を選べる。
        void Promise.resolve(
          subscriptionSession.store.dispatch(dispatchedAction),
        ).catch(() => undefined)
      } catch {
        // middleware の同期 throw も同様に resolver を維持し、abort/unsubscribe
        // だけを reject 理由とする。
      }

      // standalone / runtime disabled は middleware 内で同期的に local 適用済み。
      if (!shouldRequest) {
        resolvePendingDispatch(
          config.selectSynced(subscriptionSession.store.getState()).result,
        )
      }
    })
  }

  const setRole = async (role: PeerRole): Promise<void> => {
    if (!session) {
      throw new Error(
        'synqux is not subscribed. Call subscribe() before setRole().',
      )
    }
    if (!instanceEnabled) {
      return
    }

    // state 上の自 peer が既に目標 role なら transport へ書かない (冪等、ADR-0014 追補)。
    // 自 peer が presence 反映前で state に居ない間は比較材料がないため素通しで更新する
    const self = selectSelf(session.store.getState())
    if (self && (self.role ?? 'player') === role) {
      return
    }

    await transport.updateSelf({ role })
  }

  return {
    // 実行順: meta 付与 → (fork 系) → request 化。listener 2 つは actionRequest より
    // 前段に置き、内部 action (requestAdded/Changed) の匹配を request 化と分離する
    middlewares: [
      metaSetterMiddleware,
      requestListener.middleware,
      responseListener.middleware,
      actionRequestMiddleware,
    ],
    reducer: synquxReducer,
    rootReducer: config.rootReducer,
    subscribe,
    dispatchAndWait,
    setRole,
    actions: {
      setEnabled: synquxActions.setEnabled,
    },
    selectSynced: config.selectSynced,
  }
}

/**
 * restore した synced state の result は復元しない (移植元 loadGameState の
 * clearResultFromGameState 踏襲)。result は transient な通知であり、
 * リロード時に過去の toast を再生してしまうのを防ぐ
 */
const clearRestoredResult = (synced: unknown): unknown => ({
  ...(synced as SynquxSynced),
  result: null,
})
