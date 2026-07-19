import type { Action, Reducer } from '@reduxjs/toolkit'
import { stateWithError, type SynquxSynced } from 'synqux'

/**
 * 順序保証を目視検証する同期対象 slice (ledger)
 *
 * append の適用列を running hash に畳み込み、同じ action 群でも順序が違えば
 * hash が変わるようにする。lock 中の append は reducer で拒否し、hash に含めない。
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

/** FNV-1a 32bit。符号なし 8 桁 hex に固定し、端末差のない文字列表現にする。 */
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
        result: null,
        count: state.count + 1,
        hash: fnv1a(`${state.hash}|${by}|${String(n)}`),
      }
    }

    case 'ledger/setLocked':
      return {
        ...state,
        result: null,
        locked: action.payload,
      }

    default:
      return state
  }
}
