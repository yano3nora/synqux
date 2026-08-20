import {
  createSynquxKit,
  type SyncedAction,
  type SynquxState,
  type SynquxSynced,
} from 'synqux'

/**
 * Setup-layer kit file (call createSynquxKit exactly once per app).
 *
 * Actions defined via this kit's createSyncedSlice / createSyncedAction are
 * registered as synced actions, so isSyncedAction needs no hand-written
 * predicate. Creators and isSyncedAction must come from the same kit instance.
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

export type DemoRootState = { synqux: SynquxState; demo: DemoState }

export const { createSyncedSlice, isSyncedAction, stateWithError, syncedKey } =
  createSynquxKit<{
    synced: DemoState
    root: DemoRootState
  }>({
    // Where the synced state mounts in the root (naming the key is the
    // consumer's choice; tell the kit once — matchers come pre-bound and the
    // store wiring takes the kit's syncedKey as-is).
    syncedKey: 'demo',
  })
