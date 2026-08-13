synqux
===

synqux adds client-hosted realtime multi-device sync to Redux (Redux Toolkit) apps. A client's action becomes a "request" to the host device, the host judges it by trial-running your reducer, and every device applies accepted actions in the order the host assigned. Built for small-scale cooperative / turn-based multiplayer.

## Core Concepts

**Plain RTK is the sync framework.** You write ordinary Redux reducers and dispatch ordinary actions — no wrapper types, no special dispatch API. synqux does not do optimistic updates, so "the state on screen" is always "the synced state"; there is no rollback UI to design.

**The reducer is the only arbiter.** Validation lives in the reducer: on failure it returns the unchanged state plus an error result (`stateWithError`). The host trial-runs the reducer against a request and accepts or rejects it based on that result. Because the reducer is the single source of judgment, the same code runs identically on host, client, and standalone (sync disabled) — no branching logic per role.

**One host, one order.** Each sync group has exactly one host, derived deterministically from the connected peer pool (with automatic migration when the host leaves). The host stamps each accepted request with a sequence number `(epoch, seq)`, and every device applies actions strictly in that order. Rejected requests change nothing; only the requester is notified of the result.

**Synced state vs. local state.** Your root state is split in two: exactly **one synced slice** (shared and arbitrated across devices) and any number of **locals slices** (per-device state such as scenes, UI, sound). Locals reducers can observe synced actions and their outcomes, so per-device presentation follows shared state without being part of it.

**Transport is abstracted.** The core depends only on a small transport interface ("a NoSQL-ish JSON store with realtime push"). A Firebase Realtime Database adapter (`synqux/firebase`) and a deterministic in-memory implementation with fault injection (`synqux/testing`) ship in the box. Consumer tests are deterministic simulations — no emulator required.

**Sync heals itself.** If delivery gaps stall a device, sync health detects it and runs staged recovery automatically: resubscribe, then restore from snapshot. Only when recovery fails does synqux ask the consumer to prompt a reload. The request log is pruned automatically outside the apply window, so it never grows unbounded.

**Game developers learn three rules; setup is one file.** Feature code only needs the [three rules](#three-rules-to-remember) below. Store wiring lives in a single setup file that feature developers never touch.

## Quick Start

> [!IMPORTANT]
> synqux assumes authenticated, cooperative clients. It provides no protection against modified clients, cheating, or direct tampering with Firebase data. If you must assume hostile clients, move arbitration, sequencing, and persistence to a trusted server. `demo/database.rules.json` is for the emulator only — never reuse it in production.

A working reference lives in [demo/](./demo/) (Firebase emulator + multiple tabs syncing live). The steps below are the same setup, minimized.

### 1. Install

```sh
npm install synqux @reduxjs/toolkit
# if you use the firebase transport
npm install firebase
```

### 2. Write a synced slice

Take a normal Redux reducer and add two things: the state carries a `result` (`SynquxSynced`), and validation failures return the unchanged state via `stateWithError`. Success results are stamped automatically by the root reducer helper (full source: [demo/counter.ts](./demo/counter.ts)).

```ts
import { stateWithError, type SynquxSynced } from 'synqux'

export type CounterState = SynquxSynced<CounterAction> & { count: number }

export const counterReducer: Reducer<CounterState> = (
  state = { result: null, count: 0 },
  action,
) => {
  switch (action.type) {
    case 'counter/add': {
      const next = state.count + (action.payload ?? 1)

      // Validation lives in the reducer. The host reads this result to
      // reject the request; only the requester gets notified.
      if (next > 100 || next < 0) {
        return stateWithError({ ...state }, action, {
          message: { text: 'count must stay between 0 and 100' },
        })
      }

      return { ...state, count: next }
    }
    default:
      return state
  }
}
```

### 3. Wire the store

The setup layer is one file in your template; feature developers never touch it (full source: [demo/main.ts](./demo/main.ts)). Finish Firebase auth (e.g. anonymous sign-in) before creating the transport. Production notes for the Firebase transport are in [Usage](#firebase-transport-in-production).

```ts
import { configureStore } from '@reduxjs/toolkit'
import { createSynqux, createSynquxRootReducer } from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import { counterReducer } from './counter'        // synced slice (satisfies SynquxSynced)
import { scenesReducer } from './scenes/reducers'  // local slice (not synced)

export const synqux = createSynqux({
  transport: firebaseTransport(db),                // finish auth before creating the transport
  // Returns rootReducer / selectSynced / isSyncedAction — spread as-is into the config.
  ...createSynquxRootReducer({
    isSyncedAction: (a): a is CounterAction => a.type.startsWith('counter/'),
    synced: { counter: counterReducer },
    locals: { scenes: scenesReducer },             // run in declaration order; meta.root exposes earlier stages
  }),
})

export const store = configureStore({
  reducer: synqux.rootReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: { ignoredActionPaths: ['meta.root'] }, // required
    }).prepend(...synqux.middlewares),
})
```

NOTE: `synced` accepts **exactly one** slice (by design; two or more throws). If you have multiple domains to sync, compose them into one reducer and lift `result` to the top level. See `demoReducer` in [demo/main.ts](./demo/main.ts), which folds counter and ledger into one slice.

### 4. Subscribe and sync

```ts
// Call once at startup (even in standalone mode — snapshot restore happens here).
await synqux.subscribe({ store, groupId: 'room-1' })

// Keep title-screen devices out of host candidacy, then switch in place on join.
await synqux.setRole('player') // when subscribe started with role: 'guest'

// Then just dispatch as usual. The middleware turns it into a request, the
// host arbitrates, and every device applies in the same order.
// No optimistic updates — what you render is the synced state.
store.dispatch({ type: 'counter/add', payload: 1 })
```

If `state.counter.count` matches across every device (tab) subscribed to the same `groupId`, it works. The fastest way to try it locally: `npm run demo:emulator` + `npm run demo`, then open http://localhost:5173 in multiple tabs.

React apps should subscribe through [`useSynquxSubscription`](#subscribe-from-react) instead of calling `subscribe` by hand.

### Three rules to remember

1. **Never mutate synced state directly — dispatch actions.** Requests happen automatically; you write plain Redux.
2. **Validate in the reducer; return `stateWithError` on failure.**

    ```ts
    if (state.phase !== 'battle') {
      return stateWithError(state, action, { message: { text: 'not available right now' } })
    }
    ```

3. **Read "am I host?" and "who is here?" through selectors / hooks** — `selectIsHost` / `selectPeers` / `selectSelfId`, or with React, `useIsHost` / `usePeers` / `useLatestResult` from `synqux/react`. Reading the result off your own synced state (`state.game.result`) is also fine.

## Usage

Each section starts with the design concept, then the concrete behavior and options.

### Subscribe from React

**Concept.** React consumers get one canonical entry point for starting sync, so StrictMode double-mounts and multiple components racing to subscribe cannot double-subscribe.

```tsx
const phase = useSynquxSubscription(synqux, {
  groupId,
  role: 'player',
})
```

**Behavior.**

- The store is taken from `react-redux`'s `useStore()`; `state.synqux.phase` guards against duplicate subscriptions.
- Only non-React consumers call `synqux.subscribe({ store, groupId, ... })` imperatively. `label` identifies dedicated resident processes and is normally unused on player devices.
- Recurring side effects tied to connection state belong in instance-level callbacks, not per-component effects:

```ts
const synqux = createSynqux({
  // e.g. expose phase for E2E tests without a consumer effect
  onPhaseChanged: (phase) => { document.body.dataset.synquxPhase = phase },
  // UI transition on subscribe failure / timeout. Always set this in React consumers.
  onSubscribeFailed: () => showReloadPrompt(),
  // UI transition when auto-recovery fails. Called once until unsubscribe.
  onUnrecoverable: () => showReloadPrompt(),
  // ...transport / reducer config
})
```

### Handle unrecoverable sync stalls

**Concept.** When a device detects a gap in applied sequence numbers, synqux recovers on its own: resubscribe to requests, then restore from snapshot. The consumer only owns the last resort — telling the user to reload.

```tsx
const unrecoverable = useIsSyncUnrecoverable() // without React: selectIsSyncUnrecoverable(store.getState())

useEffect(() => {
  if (
    unrecoverable &&
    window.confirm('Sync has stopped. Reload to recover?')
  ) {
    window.location.reload()
  }
}, [unrecoverable])
```

**Behavior.**

- `unrecoverable` turns true only after one full recovery cycle fails. Prompt a reload then, and only then.
- `useIsSyncStalled` covers "stalled, including while recovering" — use it for progress indicators.
- Wording, notification style, and how to trigger the reload are the consumer's choice.

### Use server time in reducers (`action.meta.dispatched`)

**Concept.** Time-based logic ("unlocks after N seconds", "day rollover") breaks sync if each device reads its own clock — `Date.now()` inside a reducer is a determinism violation (detected in dev mode). Instead, read the timestamp synqux burns into the action: every device and the host's trial run see the same value.

```ts
case 'game/harvest': {
  // dispatched is server-based time (ms) — identical on every device and in the host's trial run
  const now = action.meta?.dispatched ?? 0

  if (now - state.plantedAt < GROW_MS) {
    return stateWithError(state, action, { message: { text: 'not grown yet' } })
  }
  // ...
}
```

**Behavior.**

- On the sync path, `meta.dispatched` is overwritten at request time with the transport's server-based clock (`serverNow()`).
- The only meta fields a reducer may read are `requestedBy` and `dispatched` (SPEC-0002).
- Performance: the firebase transport subscribes to `.info/serverTimeOffset` once at connection and caches it, so `serverNow()` is `Date.now() + offset` — O(1), no round trip per request.
- Caveat: in standalone mode (`enabled: false`) or while `setEnabled(false)`, `dispatched` falls back to the device clock. A single device can't disagree with itself, but "server-based" is only guaranteed on the sync path.

### Pause syncing for tutorials (`setEnabled`)

**Concept.** A tutorial wants to run the same reducers locally without polluting the real synced state. `setEnabled(false)` is a **send gate**: synced actions skip request creation and apply locally, immediately, without persistence.

```ts
store.dispatch(synqux.actions.setEnabled(false)) // tutorial starts (local-only from here)
store.dispatch({ type: 'game/reset' })          // tutorial setup is a plain action too
// ... tutorial plays out; every dispatch applies locally ...
```

**Behavior.**

- Only sending stops. Receiving and host duties keep running.
- Precondition: **use it while no other device in the group is active.** If the group is live, remote applies interleave with your local divergence — and if you are the host, you arbitrate and snapshot on top of diverged state, corrupting the canonical synced state.
- Returning: flipping back to `setEnabled(true)` does not erase local divergence. End the tutorial with the equivalent of a reload — a fresh store and a new `subscribe` — to return to the snapshot's canonical history.
- Full contract: [SPEC-0001](./docs/SPEC-0001-requests-sync.md), "setEnabled".

### Auto-dispatch on timers or state conditions (`automations`)

**Concept.** Non-user-initiated dispatches ("force finish 10 minutes after start", "fire as soon as state X holds") written as `useEffect` + `setTimeout` fan out from every device at once, and a failed push loses a fire-once event forever. An automation rule is evaluated by **the host only**, and retried until its condition clears (ADR-0015).

```ts
const synqux = createSynqux({
  transport,
  automations: [{
    id: 'force-finish',
    // Contract: applying the action must make `when` false again (self-terminating).
    when: (s, { now }) => s.phase === 'playing' && now - s.startedAt > 10 * 60_000,
    action: () => ({ type: 'game/finishGame' }),
  }],
  // ...
})
```

**Behavior.**

- Evaluated at two points: **right after each synced action applies**, and **every `retryMs` (default 1000ms)**. While `when` stays true, the action is re-issued every `retryMs`.
- `when` sees only synced state and server time. Local presentation state and locals are unavailable by design (blocked at the type level).
- The engine does not guarantee exactly-once (a dual-host window can double-fire). Make the reducer reject the second application (`assertActionIdempotency` mode `'rejects-repeat'`), and use a message-less `stateWithError` (log-only) for retry rejections to avoid UI noise.
- Host migration needs no handoff: the new host derives the same conclusion from state. Evaluation continues during tutorials (`setEnabled(false)`) — gate rules you want paused via a predicate on synced state (e.g. a tutorial flag).

### React to applied actions (`listeners`)

**Concept.** "Notify an external system when this synced action applies (host only)" or "play a sound / log analytics on every device" — hand-writing these as RTK listeners behind the synqux middleware makes every consumer re-solve ordering, restore-replay resends, and host gating. A listener rule fires at the point of application, with those three handled by the engine (ADR-0017).

```ts
const synqux = createSynqux({
  transport,
  listeners: [{
    id: 'report-progress',
    mode: 'host-only', // external notification fires on the host device only
    match: (action) => action.type === 'game/finishPhase',
    effect: (_action, { synced }) => reportProgress(synced.phase),
  }, {
    id: 'play-draw-sound',
    mode: 'everyone', // presentation / logging fires on each applying device
    match: (action) => action.type === 'game/drawCard',
    effect: (action) => playSound(action.payload.card),
  }],
  // ...
})
```

**Behavior.**

- Fires right after this device **actually applies** a synced action — but only while `phase === 'live'`. Past actions re-applied during restore replay do not fire. Effects are fire-and-forget and never block application.
- Contrast with automations: automations act **before** application (host derives the next action from a state predicate); listeners act **after** (reacting to an applied action). Effects receive no `dispatch` — if you want the next synced action, use automations; if you want local state to follow synced state, use `extraReducers` in a locals reducer.
- Not exactly-once (host handover can double-fire or drop). Write effects idempotently. Rejected requests never apply, so they never fire.

### Wait for a dispatch to apply (`dispatchAndWait`)

**Concept.** On the sync path, `store.dispatch` only means "the request was written to the transport". When a thunk needs "proceed after the reset has applied", use `dispatchAndWait`.

```ts
const result = await synqux.dispatchAndWait(
  { type: 'game/resetGameState' },
  { signal: AbortSignal.timeout(5000) },
)
if (result.type === 'error') { /* rejected */ }
```

**Behavior.**

- The contract is "until **this device** finishes processing the verdict". Apply-on-every-device cannot be guaranteed in a distributed system.
- Both success and error (rejection) resolve with a Result. It rejects only on signal abort or unsubscribe; pick your own timeout via `AbortSignal.timeout()` etc.

### Run without sync (standalone)

**Concept.** Standalone mode (`enabled: false`) runs the exact same reducers and dispatch flow on a single device, so a solo mode or an offline title screen needs no separate code path.

**Behavior.**

- In browsers, synced state persists to localStorage by default and restores on the next `subscribe`.
- Pass `localSnapshots: false` to disable, or your own `SnapshotStore` implementation for a different backend.

### Firebase transport in production

- In your RTDB rules, set `".indexOn": ["seq"]` on `requests/$groupId` for the retention query.
- Design read/write authorization from Authentication and room membership yourself. Anonymous auth alone does not prevent access to other rooms or data tampering.
- To keep full replay data after pruning, `firebaseTransport(db, { archivePrunedRequests: true })` moves pruned requests to `logs/`. `logs/` grows unbounded — the consumer owns its size and its deletion when a group is discarded.

### Typed `useSelector` / `useDispatch`

Nothing synqux-specific: Redux's official [`.withTypes<>()` pattern](https://redux.js.org/usage/usage-with-typescript#define-typed-hooks) works as-is. Derive RootState from `synqux.rootReducer` so the internal slice (`state.synqux`) is typed too.

```ts
// hooks.ts (once, in the setup layer)
import { useDispatch, useSelector } from 'react-redux'
import type { store, synqux } from './store'

export type RootState = ReturnType<typeof synqux.rootReducer>
export type AppDispatch = typeof store.dispatch

export const useAppSelector = useSelector.withTypes<RootState>()
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()

// Feature developers use these (s.counter is fully typed)
const count = useAppSelector((s) => s.counter.count)
```

The `synqux/react` hooks (`useIsHost` / `useLatestResult` etc.) resolve types through the Provider and work without this wiring.

### Test your consumer (`synqux/testing`)

- `createMemoryHub()` — a deterministic in-memory transport hub with fault injection (duplicate / delay / drop / subscription cutoff), for simulation tests of your slices and flows.
- `assertActionIdempotency()` — an action idempotency harness with explicit mode declarations: `'idempotent'` for set-style actions, `'rejects-repeat'` for execute-once actions, `'repeatable'` to explicitly exempt intentionally repeatable ones.
- Action design guidelines and the sync-debugging playbook are in [SPEC-0001](./docs/SPEC-0001-requests-sync.md).

## API Reference

The authority on API boundaries, type signatures, and what is deliberately not provided is [SPEC-0002](./docs/SPEC-0002-public-api.md). This section is only the full export list with one-line descriptions (the public surface is pinned by regression tests in `src/index.test.ts`; update this table and SPEC-0002 together with any change).

### `synqux` (main entry)

Setup layer (touched only by the single setup file in your template):

| export | description |
| --- | --- |
| `createSynqux(config)` | Creates a sync instance. Returns `middlewares` / `rootReducer` / `reducer` / `subscribe` / `setRole` / `dispatchAndWait` / `actions.setEnabled` / `selectSynced` |
| `createSynquxRootReducer({ isSyncedAction, synced, locals })` | Serial rootReducer helper ("synced is pure, locals see earlier stages"). Auto-stamps a default success result on synced actions (ADR-0013). Spread the return value (`rootReducer` / `selectSynced` / `isSyncedAction`) into the `createSynqux` config |
| `localStorageSnapshotStore()` | Default browser persistence for standalone mode. Pass to `localSnapshots` to use or replace explicitly |
| `synquxReducer` | Internal slice reducer mounted at the reserved key `state.synqux` (for the primitive wiring style) |
| `synquxRestored` | Internal snapshot-restore action. Match it in a primitive-style rootReducer to swap in the full synced state (**never dispatch from a consumer**) |
| `SYNQUX_VERSION` / `SYNQUX_SCHEMA_VERSION` | Package version / wire format (envelope) schema version |

Reducer helpers (game-developer layer; identical with or without sync):

| export | description |
| --- | --- |
| `createSyncedActionMatchers({ isSyncedAction, selectSynced })` | Returns type guards (`isSucceededAction` / `isMySucceededAction`) for locals reducers to check "did the applied action succeed / was it my request". Accepts the return value of `createSynquxRootReducer` as-is. Forbidden inside synced reducers |
| `isSynquxAction(action)` | Excludes synqux-internal actions in listeners / middleware. Avoids direct prefix checks |
| `isResultForPeer(result, peerId)` | Checks whether a result targets everyone or the given peer, per the `targets` contract |
| `stateWithError(state, action, option?)` | Declares a validation failure: stacks an error result without changing state. Without `message`, the rejection is log-only (no dispatch to the requester) |
| `stateWithResult(state, result)` | Stacks an arbitrary result (e.g. success + message) |
| `stateWithTransaction(state, mutate)` | Applies multiple changes in `mutate` as a unit; if an error result is stacked midway, **all changes roll back** and only the error remains. Copies the whole state — avoid for high-frequency actions |
| `stateWithDefaultResult(state, action)` | Immutably stamps the action's own default success result. Automatic with `createSynquxRootReducer`; in the primitive style, call it first in the synced reducer (ADR-0013) |
| `generateResult(props)` | Builds a result object (low-level material for the helpers above) |

Selectors (static functions, no instance needed, usable without React):

| export | description |
| --- | --- |
| `selectIsHost(root)` | Whether this device is the host |
| `selectPeers(root)` / `selectSelfId(root)` | Connected peers / this device's id |
| `selectSelf(root)` / `selectSelfRole(root)` | This device's Peer / normalized role |
| `selectSyncPhase(root)` / `selectIsLive(root)` | Distinguish initial restore from live streaming / live check |
| `selectSyncHealth(root)` | Sync health (`phase` and more) |
| `selectIsSyncStalled(root)` | Whether application is stalled (includes auto-recovery; for progress UI) |
| `selectIsSyncUnrecoverable(root)` | Whether auto-recovery failed (for reload prompts) |

Types (all contract types are exported from the main entry):

| export | description |
| --- | --- |
| `SynquxSynced<TAction, TMessage>` | Type contract for the synced slice (carries `result`) |
| `Result` / `ResultMessage` | The verdict a reducer writes and the host reads, and its UI display data |
| `SynquxActionMeta` | Meta synqux attaches to actions (reducers may read only `requestedBy` / `dispatched`) |
| `Peer` / `PeerRole` | Connected device and role (`player` / `dedicated` / `guest`). Guests can also issue requests |
| `SynquxHealth` / `SynquxPhase` | Sync health / subscription phase |
| `Synqux` / `CreateSynquxConfig` / `SynquxSubscribeOptions` | `createSynqux` return value / config / `subscribe` options |
| `SynquxAutomation` | Rule type for the `automations` config (host-driven auto dispatch, ADR-0015) |
| `SynquxListener` | Rule type for the `listeners` config (live-only reactions to applied synced actions, ADR-0017) |
| `SynquxRootState` / `SynquxState` / `PendingRequest` | Composed rootReducer state / internal slice state and pending request |
| `SynquxTransport` / `RequestEnvelope` | Transport abstraction and request envelope (contract for adapter authors) |
| `SnapshotStore` / `SnapshotFence` / `SnapshotEnvelope` | Snapshot persistence contract (fenced conditional writes) |
| `Unsubscribe` | Unsubscribe function |

### `synqux/react`

| export | description |
| --- | --- |
| `SynquxProvider` | Resolution context for the hooks. Pass the `createSynqux` return value as the `sync` prop |
| `useIsHost()` / `usePeers()` / `useSelfId()` | Hook versions of the selectors |
| `useSelf()` / `useSelfRole()` | This device's Peer / normalized role |
| `useSyncPhase()` / `useIsLive()` | Distinguish initial restore from live streaming / live check |
| `useSyncHealth()` / `useIsSyncStalled()` / `useIsSyncUnrecoverable()` | Hook versions of sync health |
| `useLatestResult()` | Reads the latest result (for toasts etc.; reading synced state directly is also fine) |
| `useMyLatestResult()` | Returns the latest result only if it targets everyone or this device |
| `useSynquxSubscription(synqux, options)` | Canonical subscription entry for React consumers. Gets the store from `useStore()` and prevents double subscription via phase |

### `synqux/testing`

| export | description |
| --- | --- |
| `createMemoryHub()` | Deterministic in-memory transport hub with fault injection (duplicate / delay / drop / subscription cutoff), for consumer simulation tests |
| `assertActionIdempotency(...)` / `verifyActionIdempotency(...)` | Action idempotency harness with mode declarations (`idempotent` / `rejects-repeat` / `repeatable`) — assert / report variants |
| `MemoryHub` / `FaultTarget` / `IdempotencyReport` | Types for the above |

### `synqux/firebase`

| export | description |
| --- | --- |
| `firebaseTransport(db, options?)` | Firebase RTDB adapter. `options.archivePrunedRequests` moves pruned requests to `logs/` |

## Development
- node 20+ (development pins node 24 via mise)
- peerDependencies: `@reduxjs/toolkit` ^2 / optional: `react` 18+, `react-redux` 9+ (for synqux/react), `firebase` 9+ (for synqux/firebase)
- Java is required only for running the demo emulator

### Structure
```
.
├ src/
│ ├ core/       … transport-agnostic sync state machine (main entry)
│ ├ firebase/   … Firebase RTDB adapter (synqux/firebase)
│ ├ react/      … read-only hooks (synqux/react)
│ └ testing/    … in-memory transport / idempotency harness (synqux/testing)
├ demo/         … manual sync check on the firebase emulator (not published; type-checked by npm test)
├ docs/         … specs and decision records (SPEC / ADR / TASK)
└ mise.toml     … toolchain (node pin, git hooks)
```

- Spec authority: [SPEC-0001-requests-sync](./docs/SPEC-0001-requests-sync.md) (mechanism, invariants, known issues)
- API boundary: [SPEC-0002-public-api](./docs/SPEC-0002-public-api.md)
- Decisions: [ADR-0001](./docs/ADR-0001-design.md) (overall design) / [ADR-0002](./docs/ADR-0002-host-seq.md) (host-assigned seq) / [ADR-0003](./docs/ADR-0003-sync-health.md) (stall detection) / [ADR-0004](./docs/ADR-0004-sync-auto-recovery.md) (auto recovery) / [ADR-0005](./docs/ADR-0005-requests-retention.md) (retention) / [ADR-0006](./docs/ADR-0006-presence-reregistration.md) (presence re-registration) / [ADR-0007](./docs/ADR-0007-action-repeat-contract.md) (action repeat contract) / [ADR-0008](./docs/ADR-0008-result-envelope-reshape.md) (Result / wire v3) / [ADR-0009](./docs/ADR-0009-trust-model.md) (trust model) / [ADR-0010](./docs/ADR-0010-response-immutability-and-fork-survival.md) (frozen response resend) / [ADR-0011](./docs/ADR-0011-snapshot-fencing.md) (snapshot fencing) / [ADR-0012](./docs/ADR-0012-transport-failure-and-abort.md) (failure notification / abort)

### Getting Started
```sh
mise install     # pin node
mise trust
mise run provision  # generate git hooks + npm ci

# demo (sync check on the firebase emulator; see demo/README.md)
npm run demo:emulator  # terminal 1: RTDB emulator (requires Java)
npm run demo           # terminal 2: open http://localhost:5173 in multiple tabs
```

### Commands
```sh
npm ci             # install packages
npm run fix        # fix lint, format
npm run check      # check lint, format
npm test           # type check & test (vitest / oxlint / oxfmt / tsc)
npm run dev:test   # vitest watch
npm run build      # build to dist with d.ts
```

## Publishing
Publishing is a human decision, done manually (agents never run it). Version bump, test/build/smoke,
and the publish gate are centralized in [`scripts/release.mjs`](./scripts/release.mjs). Distribution
itself is `npm publish` (`prepublishOnly` forces test + build + smoke, so only green builds ship).
The changelog is a GitHub Release generated by `gh release create --generate-notes` from commits / PRs
(no hand-written CHANGELOG). package.json is the version authority; `prepare` syncs package.json /
package-lock / `SYNQUX_VERSION` in `src/index.ts` at once (the old inline `npm version` sync is gone —
running `npm version` by hand leaves src out of sync and fails `src/index.test.ts`).

```sh
# 1. prepare: sync the three version sites + test → build → smoke (no publish)
mise run release:prepare -- 0.1.0   # strict semver (ADR-0001 Decision 6)

# 2. human: review the diff, commit the bump, tag it
git add .
git commit -m "release: release v0.1.0"
git tag v0.1.0

# 3. npm login via browser before publishing
npm login

# 4. publish: consistency checks → push → npm publish → GitHub Release (humans only)
mise run release:publish -- 0.1.0 --i-understand-this-pushes-and-publishes
```

Re-running `prepare` for the same version is safe (the bump is idempotent). For releases with breaking
changes (wire format schema version changes), state in the GitHub Release notes whether a coordinated
deploy is required.

`publish` aborts unless "burned-in version == tag", "working tree clean", and "tag points at HEAD" all
hold. Push happens before `npm publish` (which is hard to undo), so a tag that reached the remote alone
can be deleted and retried.

- Consumer policy: templates track `^latest`; shipped game repos pin exact versions. Breaking changes (including wire format schema version changes) are always a major
- Deploys that change the wire format (schema version) are rolled out "while no session is in progress" to absorb old/new coexistence

### Resources
- [GitHub](https://github.com/yano3nora/synqux) / [npm](https://www.npmjs.com/package/synqux)
- [Redux Toolkit](https://redux-toolkit.js.org/) / [Firebase Realtime Database](https://firebase.google.com/docs/database)
