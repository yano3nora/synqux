import { defineSynqux, type SyncedAction, type SynquxSynced } from 'synqux'

/**
 * Setup-layer definition file (call defineSynqux exactly once per app).
 *
 * Actions defined via this definition's createSyncedSlice / createSyncedAction
 * are registered as synced actions, so isSyncedAction needs no hand-written
 * predicate. Creators and the wiring factory (createSynqux) must come from the
 * same definition. The root state is derived at the wiring phase (main.ts), so
 * there is no hand-written root type here.
 */

export type DemoAction = SyncedAction

export type DemoState = SynquxSynced<DemoAction> & {
  count: number
  /** Ordering showcase: folds appends into a running hash (see slice.ts) */
  ledger: {
    count: number
    hash: string
    locked: boolean
  }
}

export const { createSyncedSlice, createSynqux, stateWithError } = defineSynqux(
  {
    // Where the synced state mounts in the root (naming the key is the
    // consumer's choice; told once, here).
    syncedKey: 'demo',
  },
).withTypes<{ synced: DemoState }>()
