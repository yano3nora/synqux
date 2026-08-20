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

Write a normal RTK slice with the definition's `createSyncedSlice` (a `createSlice` whose actions are all synced actions), and add two things: the state carries a `result` (`SynquxSynced`), and validation failures return the unchanged state via `stateWithError`. Success results are stamped automatically by the root reducer helper (full source: [demo/slice.ts](./demo/slice.ts)).

```ts
import type { SyncedAction, SynquxSynced } from 'synqux'
import { createSyncedSlice, stateWithError } from './synqux' // your definition file (created in step 3)

export type CounterState = SynquxSynced<SyncedAction> & { count: number }

export const counterSlice = createSyncedSlice({
  name: 'counter',
  initialState: { result: null, count: 0 } satisfies CounterState,
  reducers: {
    add: (state, action: SyncedAction<number>) => {
      const next = state.count + action.payload

      // Validation lives in the reducer. The host reads this result to
      // reject the request; only the requester gets notified.
      if (next > 100 || next < 0) {
        return stateWithError({ ...state }, action, {
          message: { text: 'count must stay between 0 and 100' },
        })
      }

      state.count = next // immer, as in RTK
    },
  },
})

export const { add } = counterSlice.actions
```

Every case you define here is a synced action: the creator stamps its identity (`meta.hash` / `meta.dispatched`) at creation time and registers the type in the definition, so there is no hand-written "is this action synced?" predicate to maintain.

### 3. Wire the store

The setup layer is one file in your template; feature developers never touch it (full source: [demo/main.ts](./demo/main.ts)). Finish Firebase auth (e.g. anonymous sign-in) before creating the transport. Production notes for the Firebase transport are in [Usage](#firebase-transport-in-production).

```ts
// synqux.ts — the definition file (call defineSynqux exactly once per app).
// Actions defined via its createSyncedSlice / createSyncedAction register their
// types in the definition's registry — creators and the wiring factory
// (createSynqux) must come from the same definition.
import { defineSynqux } from 'synqux'

export const { createSyncedSlice, createSyncedAction, createSynqux, stateWithError } =
  defineSynqux({
    syncedKey: 'counter', // where your synced slice mounts in the root (told once, here)
  }).withTypes<{
    synced: CounterState
  }>()
```

```ts
// store.ts — the wiring phase. Root state is derived, not hand-written.
import { configureStore } from '@reduxjs/toolkit'
import { firebaseTransport } from 'synqux/firebase'
import { counterSlice } from './counter'          // synced slice (step 2)
import { scenesReducer } from './scenes/reducers'  // local slice (not synced)
import { createSynqux } from './synqux'

export const synqux = createSynqux({
  transport: firebaseTransport(db),                // finish auth before creating the transport
  synced: counterSlice.reducer,
  locals: { scenes: scenesReducer },               // run in declaration order; meta.root exposes earlier stages
})

// Derived from syncedKey + locals — no hand-written root type, no SynquxState import.
export type RootState = ReturnType<typeof synqux.rootReducer>

export const store = configureStore({
  reducer: synqux.rootReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: { ignoredActionPaths: ['meta.root'] }, // required
    }).prepend(...synqux.middlewares),
})
```

NOTE: `synced` takes **exactly one** reducer (by design — the API shape allows no more). A demo-sized app fits in one `createSyncedSlice` (see [demo/slice.ts](./demo/slice.ts), which holds both a counter and a ledger). Apps with many domains define actions with `createSyncedAction` and fold them into the slice via `extraReducers` (or compose sub-reducers with builder functions), lifting `result` to the top level.

### 4. Subscribe and sync

```ts
// Call once at startup (even in standalone mode — snapshot restore happens here).
await synqux.subscribe({ store, groupId: 'room-1' })

// Keep title-screen devices out of host candidacy, then switch in place on join.
await synqux.setRole('player') // when subscribe started with role: 'guest'

// Then just dispatch as usual. The middleware turns it into a request, the
// host arbitrates, and every device applies in the same order.
// No optimistic updates — what you render is the synced state.
store.dispatch(add(1))
```

If `state.counter.count` matches across every device (tab) subscribed to the same `groupId`, it works. The fastest way to try it locally: `npm run demo:emulator` + `npm run demo`, then open http://localhost:5173 in multiple tabs.

React apps should subscribe through [`useSynquxSubscription`](#subscribe-from-react) instead of calling `subscribe` by hand.
The instance-level `synqux.unsubscribe()` tears down the current session even when the subscribe return-value closure is not retained; see [ADR-0019](./docs/ADR-0019-instance-unsubscribe.md).

### Three rules to remember

1. **Never mutate synced state directly — dispatch actions.** Requests happen automatically; you write plain Redux.
2. **Validate in the reducer; return `stateWithError` on failure.**

    ```ts
    if (state.phase !== 'battle') {
      return stateWithError(state, action, { message: { text: 'not available right now' } })
    }
    ```

3. **Read "am I host?" and "who is here?" through the core selectors** — pass `selectIsHost` / `selectPeers` / `selectSelfId` straight to your typed `useAppSelector` (e.g. `useAppSelector(selectIsHost)`; hook wrappers were removed in ADR-0023). Read the latest result off your own synced state with a typed selector (see below).

    ```ts
    // Canonical way to read "the latest result addressed to me" (no Provider needed).
    // `state.counter` is the synced slice from the Quick start above — adjust to your key.
    const selectMyLatestResult = (state: RootState) =>
      isResultForPeer(state.counter.result, selectSelfId(state)) ? state.counter.result : null
    ```

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
const unrecoverable = useAppSelector(selectIsSyncUnrecoverable) // without React: selectIsSyncUnrecoverable(store.getState())

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
- `selectIsSyncStalled` covers "stalled, including while recovering" — use it for progress indicators.
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
- Reducers may use `requestedBy` / `dispatched` for game decisions. Response fields (`responsedBy`, `responsed`, `epoch`, `seq`) are diagnostics for middleware, listeners, DevTools, and logs; do not branch synced state on them because dual-host candidates may differ (SPEC-0002).
- Performance: the firebase transport subscribes to `.info/serverTimeOffset` once at connection and caches it, so `serverNow()` is `Date.now() + offset` — O(1), no round trip per request.
- Caveat: in standalone mode, `dispatched` falls back to the device clock. A single device can't disagree with itself, but "server-based" is only guaranteed on the sync path.

### Run a local tutorial session

**Concept.** A tutorial needs the same reducers without joining or polluting the real sync group. Replace the synced session with a non-persistent standalone session seeded with the tutorial state (`seedSynced` swaps the synced subtree through the restore path — it is session bootstrap, not a game action), then subscribe again to restore canonical history.

```ts
await synqux.subscribe({ store, groupId })

export const startTutorial = () => async () => {
  await synqux.unsubscribe()
  await synqux.subscribe({
    store,
    groupId,
    mode: 'standalone',
    localSnapshots: false,             // never touches the real save
    seedSynced: buildTutorialState(),  // a pure function returning the tutorial state
  })
}

export const finishTutorial = () => async () => {
  await synqux.unsubscribe()
  await synqux.subscribe({ store, groupId })
}
```

`seedSynced` is standalone-only (a synced session restores from the transport snapshot — the shared truth — so subscribing with both throws), and session-scoped: on unsubscribe the synced subtree returns to the reducer's initial state, so the seed can never merge into canonical history. When combined with enabled `localSnapshots`, it starts a new save from the seed instead of loading the stored one.

**Behavior.**

- A standalone session does not connect, register presence, push requests, or read/write the transport snapshot. Local snapshots are read/written by default; `localSnapshots: false` disables them for this tutorial session.
- `synqux.unsubscribe()` is an idempotent no-op without a session. It rejects during subscribe initialization; abort that path with the subscribe `signal`. It shares a single-flight teardown with the closure returned by `subscribe` ([ADR-0019](./docs/ADR-0019-instance-unsubscribe.md)).
- Do not dispatch synced actions during the `unsubscribe → subscribe` transition window; the app-level thunk owns that exclusion.
- Re-subscribing in synced mode restores the canonical snapshot. Local tutorial state is deliberately not merged.

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
- Host migration needs no handoff: the new host derives the same conclusion from state. Automations also run in standalone sessions — gate rules you want paused via a predicate on synced state (e.g. a tutorial flag).

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
  }, {
    id: 'track-local-panel',
    mode: 'everyone',
    scope: 'all', // opt in to local actions as well as synced actions
    match: (action) => action.type === 'ui/panelOpened',
    effect: () => analytics.track('panel-opened'),
  }],
  // ...
})
```

**Behavior.**

- Fires right after this device **actually applies** an action in the rule's scope — but only while `phase === 'live'`. Past actions re-applied during restore replay do not fire. Effects are fire-and-forget and never block application.
- `scope` defaults to `'synced'`. Set `scope: 'all'` to also observe local actions on the device that dispatched them; synqux-internal actions are always excluded. Live and host-only gates still apply.
- Effects receive `ctx: { synced, self }` — the post-apply synced state and this device's presence peer (`null` before the presence echo arrives). For role-gated effects note `self.role` may be omitted, which synqux treats as the default `'player'` — normalize with `self.role ?? 'player'` (same convention as `selectSelfRole`). No `dispatch` and no locals are provided.
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

**Concept.** Standalone mode (`mode: 'standalone'`) runs the exact same reducers and dispatch flow on a single device, so a solo mode or an offline title screen needs no separate code path.

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

The core selectors (`selectIsHost` etc.) read the reserved `state.synqux` subtree, so they work through this typed `useAppSelector` as-is. No provider component is required (ADR-0022 / ADR-0023).

### Typed action vocabulary (`defineSynqux` / `createSyncedSlice` / `createSyncedAction`)

Bind your domain types once in the setup layer, and feature developers write plain RTK with zero synqux-specific annotations (ADR-0024 / ADR-0025 / ADR-0026). The definition mirrors RTK's two ways of defining actions, one-to-one:

| RTK | synqux definition | use for |
| --- | --- | --- |
| `createSlice` | `createSyncedSlice` | slice-local actions — every case you define is a synced action |
| `createAction` | `createSyncedAction` | standalone / cross-slice actions, consumed via `extraReducers` (on synced or locals slices) or builder composition |

Both stamp `hash` (a ulid, unique across all devices — safe to use as a record key in synced state) and `dispatched` **at creation time**, so `builder.addCase` infers `action.meta` as required. One creation = one intent: **never re-dispatch the same action object** — the machinery does not deduplicate it (the same identity would apply twice); call the creator again to retry (`dispatchAndWait` rejects a duplicate pending hash explicitly). `createSyncedSlice` supports plain case reducers and the `{ prepare, reducer }` notation; RTK 2.x callback creators (`create.asyncThunk` etc.) are not supported.

The definition also holds the **creator registry**: defining an action via `createSyncedSlice` / `createSyncedAction` registers the type, and the wiring judges "is this a synced action" from that registry — no hand-written prefix predicate, no exclusion list. Two contracts follow:

- **Call `defineSynqux` exactly once per app**, and take creators and the wiring factory from the same definition (each call creates an independent registry; `.withTypes` is a pure type cast and never splits it).
- **Registration happens when the creator's module is imported.** As long as your synced reducer references creators statically (`builder.addCase(creator, ...)`), everything is registered by store-creation time. Do not lazy-import creator modules — an action arriving from another device before the import completes would not be judged as synced.

```ts
// synqux.ts (once, in the setup layer)
import { defineSynqux, type LocalAction as SynquxLocalAction } from 'synqux'
import type { RootState } from './store' // derived there; type-only import

export const {
  createSyncedSlice,           // createSlice whose actions are all synced actions
  createSyncedAction,
  createSynqux,                // wiring factory — call it in your store file
  isSucceededAction,           // locals-reducer matchers, fully pre-bound
  isMySucceededAction,
  generateResult, stateWithError, stateWithResult, stateWithTransaction,
} = defineSynqux({
  // Where the synced state mounts in the root. Naming the key is your choice
  // (synqux only reserves state.synqux), so tell the definition once — the
  // wiring phase derives the root state from it.
  syncedKey: 'game',
}).withTypes<{
  synced: GameState
  message: GameResultMessage   // your ResultMessage extension (optional)
}>()

// Annotation type for locals slices (replaces PayloadAction there).
// The third param is your app-specific dispatch-time meta extension slot.
export type LocalAction<P = void> = SynquxLocalAction<P, RootState>

// Feature developers then write plain RTK:
export const launchTalks = createSyncedAction(
  'game/talks/launch',
  (phase: PhaseKey, talks: Talk[]) => ({ payload: { phase, talks } }),
)

builder.addCase(launchTalks, (state, action) => {
  action.meta.hash // required — no optional chaining, no custom narrow helper
})
```

`meta.hash` is lexicographically sortable in creation order **per device only** — the ground truth for cross-device apply order is always `seq`.

### Test your consumer (`synqux/testing`)

- `createMemoryHub()` — a deterministic in-memory transport hub with fault injection (duplicate / delay / drop / subscription cutoff), for simulation tests of your slices and flows.
- `assertActionIdempotency()` — an action repeat-contract harness with explicit mode declarations: `'idempotent'` for set-style actions, `'rejects-repeat'` for execute-once actions, `'repeatable'` to explicitly exempt intentionally repeatable ones (generic dispatcher actions whose behavior depends on the payload belong here — guard behaviors are covered by ordinary scenario tests, and operations that must run exactly once get a dedicated action whose reducer validation rejects repeats). The second application regenerates `hash` / `dispatched` to faithfully reproduce "same intent, different request" (ADR-0007 Amendment).
- `createTestRootState(locals, synqux?)` — builds a root-state fixture with the reserved `state.synqux` slice filled in, for locals reducer / selector tests.
- Action design guidelines and the sync-debugging playbook are in [SPEC-0001](./docs/SPEC-0001-requests-sync.md).

## API Reference

The authority on API boundaries, type signatures, and what is deliberately not provided is [SPEC-0002](./docs/SPEC-0002-public-api.md). This section is only the full export list with one-line descriptions (the public surface is pinned by regression tests in `src/index.test.ts`; update this table and SPEC-0002 together with any change).

### `synqux` (main entry)

Setup layer (touched only by the single setup file in your template):

| export | description |
| --- | --- |
| `createSynqux(config)` | Creates a sync instance (core / primitive form — the definition's wiring factory wraps this). Returns `middlewares` / `rootReducer` / `reducer` / `subscribe` / `unsubscribe` / `setRole` / `dispatchAndWait` |
| `createSynquxRootReducer({ isSyncedAction, syncedKey, synced, locals })` | Serial rootReducer helper ("synced is pure, locals see earlier stages"). Primitive-style helper — the definition's wiring phase calls this internally; use directly only with hand-wired stores. Takes a `syncedKey` plus a single synced reducer, auto-stamps a default success result on synced actions (ADR-0013), and returns `rootReducer` / `selectSynced` / `isSyncedAction` to spread into the core `createSynqux` config |
| `localStorageSnapshotStore()` | Default browser persistence for standalone mode. Pass to `localSnapshots` to use or replace explicitly |
| `synquxReducer` | Internal slice reducer mounted at the reserved key `state.synqux` (for the primitive wiring style) |
| `synquxRestored` | Internal snapshot-restore action. Match it in a primitive-style rootReducer to swap in the full synced state (**never dispatch from a consumer**) |
| `SYNQUX_VERSION` / `SYNQUX_SCHEMA_VERSION` | Package version / wire format (envelope) schema version |

Reducer helpers (game-developer layer; identical with or without sync):

| export | description |
| --- | --- |
| `defineSynqux({ syncedKey }).withTypes<{ synced, message? }>()` | The definition phase (call once per app; `syncedKey` tells it — once — where the synced state mounts, and the root type is derived at wiring). Returns typed helpers plus the creator registry: `createSyncedSlice` (a `createSlice` whose actions are all synced actions) and `createSyncedAction` (a `createAction` for standalone / cross-slice actions) — both stamp `hash` (ulid) / `dispatched` at creation time, type `meta` as required, and register the type (the only ways to define synced actions, ADR-0024 / ADR-0026) — plus pre-bound matchers, result helpers, and the wiring factory `createSynqux({ transport, synced, locals, ... })` |
| `generateActionHash()` | Issues a synced-action hash (ulid) directly (rarely needed; creators stamp automatically) |
| `createSyncedActionMatchers({ isSyncedAction, selectSynced })` | Returns type guards (`isSucceededAction` / `isMySucceededAction`) for locals reducers to check "did the applied action succeed / was it my request". The definition returns these guards directly, fully pre-bound. Forbidden inside synced reducers |
| `isDeliveredSyncedAction(action)` | Checks whether an action carries the complete request/response delivery metadata. Combine with the consumer's synced-domain matcher when needed |
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
| `SyncedActionMeta` / `SyncedAction` / `SyncedActionHash` | Consumer-facing action vocabulary: meta with required `hash` / `dispatched` as seen by synced reducers (ADR-0024) |
| `LocalAction` | Annotation type for locals slice reducers (replaces `PayloadAction` there; carries `meta.root` and an app meta extension slot) |
| `SynquxActionMeta` | Wire-level (all-optional) metadata vocabulary for envelopes / diagnostics / adapter authors. Response fields are diagnostics only; synced reducers must not branch game state on them |
| `Peer` / `PeerRole` | Connected device and role (`player` / `dedicated` / `guest`). Guests can also issue requests |
| `SynquxHealth` / `SynquxPhase` | Sync health / subscription phase |
| `Synqux` / `CreateSynquxConfig` / `SynquxSubscribeOptions` | `createSynqux` return value / config / `subscribe` options |
| `SynquxAutomation` | Rule type for the `automations` config (host-driven auto dispatch, ADR-0015) |
| `SynquxListener` | Rule type for `listeners`; `scope: 'all'` opts into local actions (live-only, ADR-0017 / ADR-0020) |
| `SynquxRootState` / `SynquxState` / `PendingRequest` | Composed rootReducer state / internal slice state and pending request |
| `SynquxTransport` / `RequestEnvelope` | Transport abstraction and request envelope (contract for adapter authors) |
| `SnapshotStore` / `SnapshotFence` / `SnapshotEnvelope` | Snapshot persistence contract (fenced conditional writes) |
| `Unsubscribe` | Unsubscribe function |

### `synqux/react`

| export | description |
| --- | --- |
| `useSynquxSubscription(synqux, options)` | Canonical subscription entry for React consumers. Gets the store from `useStore()` and prevents double subscription via phase |

This is the only export — reading is done by passing the core selectors (`selectIsHost` / `selectPeers` / `selectSyncHealth` ...) to your typed `useAppSelector`, and the latest result comes from a typed selector over your own synced state (`isResultForPeer` + `selectSelfId`, see Quick start). `SynquxProvider` and the read-hook wrappers were removed in ADR-0022 / ADR-0023.

### `synqux/testing`

| export | description |
| --- | --- |
| `createMemoryHub()` | Deterministic in-memory transport hub with fault injection (duplicate / delay / drop / subscription cutoff), for consumer simulation tests |
| `assertActionIdempotency(...)` / `verifyActionIdempotency(...)` | Action idempotency harness with mode declarations (`idempotent` / `rejects-repeat` / `repeatable`) — assert / report variants |
| `createTestRootState(locals, synqux?)` | Root-state fixture builder with the reserved `state.synqux` slice pre-filled |
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
│ ├ react/      … subscription hook (synqux/react)
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

## Release
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
