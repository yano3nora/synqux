import type {
  Action,
  Dispatch,
  Middleware,
  UnknownAction,
} from '@reduxjs/toolkit'
import {
  onValue,
  ref,
  serverTimestamp,
  set,
  type Database,
} from 'firebase/database'

/**
 * TASK-260812 Phase A-2: host 停止の真因計測 rig (demo 専用・build / npm 配布対象外)
 *
 * 「非アクティブ放置された host タブで何が止まるのか」を切り分けるための
 * in-memory イベントログ。判定表 (TASK-260812 A-3) に対応する観測点:
 *
 * - tick        : chained timer の実発火間隔 → timer throttling の粒度
 * - lifecycle   : visibilitychange / freeze / resume / pagehide / pageshow
 * - connected   : Firebase `.info/connected` の遷移 → 接続の生死 (ゾンビ判定)
 * - action      : synqux 内部 action (synqux/requestAdded 等) の到着
 *                 → transport イベント受信が続いているか (freeze との切り分け)
 * - hb-*        : serverTimestamp の定期書き込み probe
 *                 → throttle 下で heartbeat が実際に書ける最悪間隔 (閾値の根拠)
 * - probe-*     : guest 側からの dispatchAndWait 裁定 latency (?probe=<sec>)
 * - host        : 自端末の host 状態の遷移
 *
 * 有効化: `?rig=1` (計測のみ) / `?rig=1&probe=30` (guest の定期 probe つき)。
 * ログは in-memory ring buffer に貯め、dump ボタンで JSON ダウンロードする。
 * tab freeze (chrome://discards) はメモリを保持したまま JS を止めるだけなので、
 * 復帰後の dump に freeze 中の空白がそのまま残る
 */

type RigEntry = {
  /** 端末時計 (epoch ms)。freeze 中の空白をサーバ時刻に頼らず観測するため */
  t: number
  kind: string
  detail?: string | number
}

type RigHandle = {
  /** synqux middleware より前段に prepend し、内部 action の到着を記録する */
  middleware: Middleware<
    Record<string, never>,
    unknown,
    Dispatch<UnknownAction>
  >
  /** subscribe 完了後に呼ぶ。timer / lifecycle / connected / probe の計測を開始する */
  start: (context: {
    db: Database
    groupId: string
    getSelfId: () => string | null | undefined
    getIsHost: () => boolean
    getPeersDigest: () => string
    /** guest probe 用。synqux instance の dispatchAndWait をそのまま渡す */
    dispatchAndWait: (
      action: Action,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>
  }) => void
}

const RING_CAPACITY = 20_000
const TICK_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000

export const createRig = (params: URLSearchParams): RigHandle | undefined => {
  if (params.get('rig') !== '1') {
    return undefined
  }

  const probeSeconds = Number(params.get('probe'))
  const entries: RigEntry[] = []

  const log = (kind: string, detail?: string | number): void => {
    entries.push({ t: Date.now(), kind, detail })
    if (entries.length > RING_CAPACITY) {
      entries.shift()
    }
  }

  log('meta', navigator.userAgent)
  log('meta', location.href)

  // ---- 観測点 4: synqux 内部 action の到着 (transport 配送の生死) ----
  // demo の synced action (counter/ledger) も記録し「適用が続いているか」も併せて見る
  const middleware: RigHandle['middleware'] = () => (next) => (action) => {
    const type = (action as UnknownAction).type
    if (typeof type === 'string') {
      log('action', type)
    }
    return next(action)
  }

  const start: RigHandle['start'] = (context) => {
    // ---- 観測点 1: timer throttling の粒度 ----
    // setInterval は throttle 時にまとめ発火し得るため、chained setTimeout で
    // 「実際に JS が走れた間隔」を測る。ズレ (actual - nominal) を detail に残す
    let lastTick = Date.now()
    let lastTickGap = 0
    const tick = (): void => {
      const now = Date.now()
      lastTickGap = now - lastTick
      log('tick', lastTickGap)
      lastTick = now
      window.setTimeout(tick, TICK_INTERVAL_MS)
    }
    window.setTimeout(tick, TICK_INTERVAL_MS)

    // ---- 観測点 2: Page Lifecycle ----
    document.addEventListener('visibilitychange', () =>
      log('lifecycle', `visibility:${document.visibilityState}`),
    )
    // freeze / resume は Page Lifecycle API (Chrome)。未対応ブラウザでは発火しないだけ
    document.addEventListener('freeze', () => log('lifecycle', 'freeze'))
    document.addEventListener('resume', () => log('lifecycle', 'resume'))
    window.addEventListener('pagehide', () => log('lifecycle', 'pagehide'))
    window.addEventListener('pageshow', () => log('lifecycle', 'pageshow'))

    // ---- 観測点 3: Firebase 接続の生死 ----
    onValue(ref(context.db, '.info/connected'), (snapshot) =>
      log('connected', String(snapshot.val())),
    )

    // ---- 観測点 5: heartbeat 書き込み probe ----
    // Phase B の heartbeat と同じ「タイマー駆動でサーバ時刻を書く」を先取りし、
    // throttle / freeze 下での最悪書き込み間隔を測る。ack latency も残す
    const heartbeatRef = (): ReturnType<typeof ref> =>
      ref(
        context.db,
        `rigHeartbeats/${context.groupId}/${context.getSelfId() ?? 'unknown'}`,
      )
    let lastHeartbeatAck = Date.now()
    const heartbeat = (): void => {
      const started = Date.now()
      log('hb-start', started - lastHeartbeatAck)
      void set(heartbeatRef(), serverTimestamp())
        .then(() => {
          lastHeartbeatAck = Date.now()
          log('hb-ack', lastHeartbeatAck - started)
        })
        .catch((error: unknown) => log('hb-error', String(error)))
      window.setTimeout(heartbeat, HEARTBEAT_INTERVAL_MS)
    }
    window.setTimeout(heartbeat, HEARTBEAT_INTERVAL_MS)

    // ---- 観測点 7: 自端末の host 状態遷移 (migration の観測) ----
    let wasHost = context.getIsHost()
    log('host', String(wasHost))
    window.setInterval(() => {
      const isHost = context.getIsHost()
      if (isHost !== wasHost) {
        wasHost = isHost
        log('host', String(isHost))
      }
    }, 1_000)

    // ---- 観測点 6: guest probe (裁定 latency の継続測定) ----
    // counter/add を +1 / -1 交互に送り count を汚さない。拒否 (result error) でも
    // 「裁定された」事実と latency は取れるため成否は問わない
    if (Number.isFinite(probeSeconds) && probeSeconds > 0) {
      const probeIntervalMs = probeSeconds * 1_000
      let probeSign = 1
      const probe = async (): Promise<void> => {
        const started = Date.now()
        log('probe-start', context.getPeersDigest())
        try {
          await context.dispatchAndWait(
            { type: 'counter/add', payload: probeSign } as Action,
            // interval より僅かに短い timeout で「裁定されないまま」を検知する
            { signal: AbortSignal.timeout(probeIntervalMs - 1_000) },
          )
          log('probe-ok', Date.now() - started)
        } catch {
          log('probe-timeout', Date.now() - started)
        }
        probeSign = -probeSign
        window.setTimeout(() => void probe(), probeIntervalMs)
      }
      window.setTimeout(() => void probe(), probeIntervalMs)
    }

    // ---- dump ----
    const dump = (): void => {
      const blob = new Blob([JSON.stringify(entries, null, 1)], {
        type: 'application/json',
      })
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(blob)
      anchor.download = `rig-${context.getSelfId() ?? 'unknown'}-${Date.now()}.json`
      anchor.click()
      URL.revokeObjectURL(anchor.href)
    }

    const section = document.getElementById('rig')
    const statusEl = document.getElementById('rig-status')
    if (section && statusEl) {
      section.style.display = ''
      document.getElementById('rig-dump')?.addEventListener('click', dump)
      window.setInterval(() => {
        statusEl.textContent = `${entries.length} events / last tick gap ${lastTickGap}ms`
      }, 1_000)
    }
  }

  return { middleware, start }
}
