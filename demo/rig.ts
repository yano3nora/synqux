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
 * TASK-260812 Phase A-2: host stall diagnostic rig (demo only; not built or published)
 *
 * An in-memory event log for finding what stops in an inactive host tab.
 * Observation points correspond to the decision table (TASK-260812 A-3):
 *
 * - tick        : actual chained timer interval -> timer throttling level
 * - lifecycle   : visibilitychange / freeze / resume / pagehide / pageshow
 * - connected   : Firebase `.info/connected` changes -> connection health (zombie check)
 * - action      : arrival of internal synqux actions (such as synqux/requestAdded)
 *                 -> whether transport events still arrive (to distinguish freezes)
 * - hb-*        : periodic serverTimestamp write probe
 *                 -> worst heartbeat write interval under throttling (threshold basis)
 * - probe-*     : dispatchAndWait decision latency from a guest (?probe=<sec>)
 * - host        : changes to this device's host state
 *
 * Enable with `?rig=1` (measurement only) or `?rig=1&probe=30` (periodic guest probe).
 * Logs are stored in an in-memory ring buffer. Use the dump button to download JSON.
 * A tab freeze (chrome://discards) stops JS but keeps memory, so the dump after
 * resuming shows the gap during the freeze.
 */

type RigEntry = {
  /** Device clock (epoch ms), used to observe freeze gaps without server time. */
  t: number
  kind: string
  detail?: string | number
}

type RigHandle = {
  /** Prepend before synqux middleware to record incoming internal actions. */
  middleware: Middleware<
    Record<string, never>,
    unknown,
    Dispatch<UnknownAction>
  >
  /** Call after subscribe completes to start timer/lifecycle/connection/probe measurements. */
  start: (context: {
    db: Database
    groupId: string
    getSelfId: () => string | null | undefined
    getIsHost: () => boolean
    getPeersDigest: () => string
    /** For the guest probe. Pass the synqux instance's dispatchAndWait directly. */
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

  // ---- Observation point 4: incoming internal synqux actions (transport health) ----
  // Also record demo synced actions (counter/ledger) to check whether application continues.
  const middleware: RigHandle['middleware'] = () => (next) => (action) => {
    const type = (action as UnknownAction).type
    if (typeof type === 'string') {
      log('action', type)
    }
    return next(action)
  }

  const start: RigHandle['start'] = (context) => {
    // ---- Observation point 1: timer throttling level ----
    // setInterval may fire in batches when throttled, so chained setTimeout measures
    // the actual interval when JS could run. Store the drift (actual - nominal) in detail.
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

    // ---- Observation point 2: Page Lifecycle ----
    document.addEventListener('visibilitychange', () =>
      log('lifecycle', `visibility:${document.visibilityState}`),
    )
    // freeze/resume use the Page Lifecycle API (Chrome) and do not fire in unsupported browsers.
    document.addEventListener('freeze', () => log('lifecycle', 'freeze'))
    document.addEventListener('resume', () => log('lifecycle', 'resume'))
    window.addEventListener('pagehide', () => log('lifecycle', 'pagehide'))
    window.addEventListener('pageshow', () => log('lifecycle', 'pageshow'))

    // ---- Observation point 3: Firebase connection health ----
    onValue(ref(context.db, '.info/connected'), (snapshot) =>
      log('connected', String(snapshot.val())),
    )

    // ---- Observation point 5: heartbeat write probe ----
    // Preview Phase B's timer-driven server-time writes. Measure the worst write
    // interval under throttling/freezing and record acknowledgement latency.
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

    // ---- Observation point 7: this device's host state changes (migration) ----
    let wasHost = context.getIsHost()
    log('host', String(wasHost))
    window.setInterval(() => {
      const isHost = context.getIsHost()
      if (isHost !== wasHost) {
        wasHost = isHost
        log('host', String(isHost))
      }
    }, 1_000)

    // ---- Observation point 6: guest probe (continuous decision latency) ----
    // Alternate counter/add between +1 and -1 to preserve the count. Rejected requests
    // still provide a decision and latency, so success or failure does not matter.
    if (Number.isFinite(probeSeconds) && probeSeconds > 0) {
      const probeIntervalMs = probeSeconds * 1_000
      let probeSign = 1
      const probe = async (): Promise<void> => {
        const started = Date.now()
        log('probe-start', context.getPeersDigest())
        try {
          await context.dispatchAndWait(
            { type: 'counter/add', payload: probeSign } as Action,
            // Use a timeout just below the interval to detect a missing decision.
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
