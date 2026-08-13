import type { Action, Reducer } from '@reduxjs/toolkit'
import { stateWithError, type SynquxSynced } from 'synqux'

/**
 * Synced slice for the demo (counter)
 *
 * A regular reducer that follows the synqux conventions:
 * - Implements SynquxSynced (has a result)
 * - On validation failure, uses stateWithError to set the result without changing state
 * - Prefer set-style actions that do not depend on the current value (Design Guideline 1)
 */
export type CounterAction = Action<`counter/${string}`> & {
  payload?: number
  meta?: { requestedBy?: string }
}

export type CounterState = SynquxSynced<CounterAction> & {
  count: number
}

export const counterInitialState: CounterState = { result: null, count: 0 }

export const isCounterAction = (action: Action): action is CounterAction =>
  action.type.startsWith('counter/')

const MAX = 100
const MIN = 0

export const counterReducer: Reducer<CounterState> = (
  state = counterInitialState,
  action,
) => {
  if (!isCounterAction(action)) {
    return state
  }

  switch (action.type) {
    // Increment-style = an intentional infinitely repeatable action (one of the three
    // categories in Design Guideline 1). Each operation is added for easy visual checks.
    case 'counter/add': {
      const next = state.count + (action.payload ?? 1)

      // Validation lives in the reducer. The host reads this result to reject the
      // request; only the requester gets notified.
      if (next > MAX || next < MIN) {
        return stateWithError({ ...state }, action, {
          message: {
            text: `count must stay between ${String(MIN)} and ${String(MAX)}`,
          },
        })
      }

      return { ...state, count: next }
    }

    case 'counter/set':
      return { ...state, count: action.payload ?? 0 }

    default:
      return state
  }
}
