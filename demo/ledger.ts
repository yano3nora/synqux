import type { Action, Reducer } from '@reduxjs/toolkit'
import { stateWithError, type SynquxSynced } from 'synqux'

/**
 * Synced slice for visually checking ordering guarantees (ledger)
 *
 * Folds the append sequence into a running hash, so a different order changes the
 * hash. The reducer rejects appends while locked and leaves them out of the hash.
 */
export type LedgerAction = (
  | (Action<'ledger/append'> & { payload: { by: string; n: number } })
  | (Action<'ledger/setLocked'> & { payload: boolean })
) & {
  meta?: { requestedBy?: string }
}

export type LedgerState = SynquxSynced<LedgerAction> & {
  count: number
  hash: string
  locked: boolean
}

export const ledgerInitialState: LedgerState = {
  result: null,
  count: 0,
  hash: 'seed',
  locked: false,
}

export const isLedgerAction = (action: Action): action is LedgerAction =>
  action.type.startsWith('ledger/')

/** FNV-1a 32-bit. Uses a fixed unsigned 8-digit hex string on every device. */
export const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const ledgerReducer: Reducer<LedgerState> = (
  state = ledgerInitialState,
  action,
) => {
  if (!isLedgerAction(action)) {
    return state
  }

  switch (action.type) {
    case 'ledger/append': {
      if (state.locked) {
        return stateWithError<LedgerState, LedgerAction>({ ...state }, action, {
          message: { text: 'ledger is locked' },
        })
      }

      const { by, n } = action.payload
      return {
        ...state,
        count: state.count + 1,
        hash: fnv1a(`${state.hash}|${by}|${String(n)}`),
      }
    }

    case 'ledger/setLocked':
      return {
        ...state,
        locked: action.payload,
      }

    default:
      return state
  }
}
