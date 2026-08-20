import type { SyncedAction } from 'synqux'
import { createSyncedSlice, stateWithError, type DemoState } from './synqux'

/**
 * Synced slice for the demo, defined with createSyncedSlice: every case here
 * is a synced action (creation-time hash / dispatched stamping + registry).
 *
 * Follows the synqux conventions:
 * - The state carries a `result` (SynquxSynced)
 * - On validation failure, stateWithError sets the result without changing state
 * - Prefer set-style actions that do not depend on the current value where
 *   possible (Design Guideline 1); `add` is an intentionally repeatable action
 */

export const demoInitialState: DemoState = {
  result: null,
  count: 0,
  ledger: { count: 0, hash: 'seed', locked: false },
}

/** FNV-1a 32-bit. Uses a fixed unsigned 8-digit hex string on every device. */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

const MAX = 100
const MIN = 0

export const demoSlice = createSyncedSlice({
  name: 'demo',
  initialState: demoInitialState,
  reducers: {
    add: (state, action: SyncedAction<number>) => {
      const next = state.count + action.payload

      // Validation lives in the reducer. The host reads this result to reject
      // the request; only the requester gets notified.
      if (next > MAX || next < MIN) {
        return stateWithError({ ...state }, action, {
          message: {
            text: `count must stay between ${String(MIN)} and ${String(MAX)}`,
          },
        })
      }

      state.count = next
    },

    set: (state, action: SyncedAction<number>) => {
      state.count = action.payload
    },

    // The ledger folds the append sequence into a running hash, so a different
    // apply order changes the hash — a visual check of ordering guarantees.
    append: (state, action: SyncedAction<{ by: string; n: number }>) => {
      if (state.ledger.locked) {
        return stateWithError({ ...state }, action, {
          message: { text: 'ledger is locked' },
        })
      }

      const { by, n } = action.payload
      state.ledger.count += 1
      state.ledger.hash = fnv1a(`${state.ledger.hash}|${by}|${String(n)}`)
    },

    setLocked: (state, action: SyncedAction<boolean>) => {
      state.ledger.locked = action.payload
    },
  },
})

export const { add, append, set, setLocked } = demoSlice.actions
