import { configureStore } from '@reduxjs/toolkit'
import { initializeApp } from 'firebase/app'
import { connectDatabaseEmulator, getDatabase } from 'firebase/database'
import {
  createSynqux,
  createSynquxRootReducer,
  selectIsHost,
  selectPeers,
  selectSelfId,
  type PeerRole,
} from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import { createRig } from './rig'
import { add, append, demoSlice, set, setLocked } from './slice'
import { isSyncedAction, type DemoAction } from './synqux'

/**
 * synqux demo: sync a counter across devices with the Firebase emulator
 *
 * See demo/README.md for instructions. Open it in multiple tabs (use ?role= to
 * change roles) and check +/- updates, the host display, and migration on tab close.
 */

// ---- Firebase (always uses the emulator; never connects to a real project) ----
const app = initializeApp({
  projectId: 'synqux-demo',
  // The SDK needs a URL to initialize, but the connection goes to the emulator below.
  databaseURL: 'https://synqux-demo-default-rtdb.firebaseio.com',
})
const db = getDatabase(app)
connectDatabaseEmulator(db, '127.0.0.1', 9000)

// ---- Store setup (same structure as Getting Started in the README) ----
const params = new URLSearchParams(window.location.search)
const groupId = params.get('group') ?? 'demo-room'
const roleParam = params.get('role')
// Query values are untyped, so use the default instead of casting old values or typos.
const role: PeerRole | undefined =
  roleParam === 'player' || roleParam === 'dedicated' || roleParam === 'guest'
    ? roleParam
    : undefined
const stormTotal = Number(params.get('storm'))

// createSynquxRootReducer accepts exactly one synced slice — createSyncedSlice
// covers a demo-sized app in one slice (see demo/slice.ts). Apps with many
// domains compose sub-reducers into one slice instead (README NOTE).
const synqux = createSynqux({
  transport: firebaseTransport(db, { archivePrunedRequests: true }),
  ...createSynquxRootReducer({
    isSyncedAction,
    synced: { demo: demoSlice.reducer },
    locals: {},
  }),
})

// Measurement rig for TASK-260812 Phase A-2 (enable with `?rig=1`). Place the
// middleware before synqux to record transport-driven internal actions per tab.
const rig = createRig(params)

const store = configureStore({
  reducer: synqux.rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: { ignoredActionPaths: ['meta.root'] },
    }).prepend(...(rig ? [rig.middleware] : []), ...synqux.middlewares),
})

// ---- UI (plain DOM to avoid dependencies; see synqux/react when using React) ----
const el = (id: string): HTMLElement => document.getElementById(id)!

let stormRunning = false
let stormSent = 0
let appendSequence = 0
let nextLock = true

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

/**
 * Spread requests from multiple tabs over time. Prevent re-entry and send exactly
 * `total` per storm, so the on-screen sent count shows whether each tab finished.
 */
const startStorm = (total: number): void => {
  if (stormRunning || !Number.isInteger(total) || total <= 0) {
    return
  }

  stormRunning = true

  void (async () => {
    try {
      for (let index = 0; index < total; index += 1) {
        await sleep(25 + Math.random() * 125)

        if (Math.random() < 0.1) {
          store.dispatch(setLocked(nextLock))
          nextLock = !nextLock
        } else {
          appendSequence += 1
          store.dispatch(
            append({
              by: selectSelfId(store.getState()) ?? 'anon',
              n: appendSequence,
            }),
          )
        }

        stormSent += 1
        render()
      }
    } finally {
      stormRunning = false
    }
  })()
}

el('group').textContent = groupId
el('role').textContent = role ?? 'player'

const render = (): void => {
  const state = store.getState()

  el('count').textContent = String(state.demo.count)
  el('ledger-count').textContent = String(state.demo.ledger.count)
  el('ledger-hash').textContent = state.demo.ledger.hash.slice(0, 8)
  el('ledger-locked').textContent = String(state.demo.ledger.locked)
  el('ledger-sent').textContent = String(stormSent)
  el('self').textContent = selectSelfId(state) ?? '(connecting...)'
  el('host').textContent = selectIsHost(state) ? 'HOST 👑' : 'client'
  const peers = selectPeers(state)
  const self = peers.find((peer) => peer.id === selectSelfId(state))
  el('role').textContent = self?.role ?? 'player'
  el('peers').innerHTML = peers
    .map(
      (peer) =>
        `<li>${peer.id}${peer.role ? ` <em>(${peer.role})</em>` : ''}</li>`,
    )
    .join('')

  // Read the decision result directly from synced state (the SPEC-public-api pattern).
  // Messages are for UI display (ADR-0008). Do not show log-only results here.
  // A single slice = a single result: counter and ledger rejections both land here.
  const result = state.demo.result
  el('result').textContent = result?.message
    ? `${result.type}: ${result.message.text}`
    : ''
}

store.subscribe(render)
render()

el('add1').onclick = () => store.dispatch(add(1))
el('add10').onclick = () => store.dispatch(add(10))
el('sub1').onclick = () => store.dispatch(add(-1))
el('reset').onclick = () => store.dispatch(set(0))
el('storm50').onclick = () => startStorm(50)
el('storm200').onclick = () => startStorm(200)
el('lock-toggle').onclick = () =>
  store.dispatch(setLocked(!store.getState().demo.ledger.locked))

const setRole = async (nextRole: PeerRole): Promise<void> => {
  try {
    await synqux.setRole(nextRole)
  } catch (error) {
    console.error(error)
    el('status').textContent = 'failed to change role'
  }
}
el('role-guest').onclick = () => void setRole('guest')
el('role-player').onclick = () => void setRole('player')

// ---- Start syncing (register presence -> restore snapshot -> subscribe to requests) ----
// Non-React consumers subscribe to the instance directly and handle failure UX here.
void synqux
  .subscribe({
    store,
    groupId,
    role,
    signal: AbortSignal.timeout(30_000),
  })
  .then(() => {
    el('status').textContent = 'connected'

    // Start the rig after subscribing because its measurements create probe requests.
    rig?.start({
      db,
      groupId,
      getSelfId: () => selectSelfId(store.getState()),
      getIsHost: () => selectIsHost(store.getState()),
      getPeersDigest: () =>
        selectPeers(store.getState())
          .map((peer) => `${peer.id}:${peer.role ?? 'player'}`)
          .join(','),
      dispatchAndWait: (action, options) =>
        synqux.dispatchAndWait(action as DemoAction, options),
    })

    // Start URL-configured storms after subscribing to avoid requests while disconnected.
    if (Number.isInteger(stormTotal) && stormTotal > 0) {
      startStorm(stormTotal)
    }
  })
  .catch((error: unknown) => {
    console.error(error)
    el('status').textContent =
      'cannot connect to the emulator. Start it by following demo/README.md'
  })
