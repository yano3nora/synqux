import type { Action, Reducer } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { createSyncedActionMatchers } from './matchers.js'
import { stateWithError } from './results.js'
import { createSynquxRootReducer } from './root-reducer.js'
import { synquxActions } from './slice.js'
import type { SynquxActionMeta, SynquxSynced } from './types.js'

type GameAction = Action<`game/${string}`> & {
  payload: { amount: number }
  meta?: SynquxActionMeta
}

type GameState = SynquxSynced<GameAction> & { count: number }
type LocalState = { calls: number }

const initialGame: GameState = { result: null, count: 0 }

const isGameAction = (action: Action): action is GameAction =>
  action.type.startsWith('game/')

const gameReducer: Reducer<GameState> = (state = initialGame, action) => {
  if (!isGameAction(action)) {
    return state
  }

  if (action.type === 'game/reject') {
    return stateWithError(state, action, {
      message: { text: 'rejected' },
    })
  }

  return { ...state, count: state.count + action.payload.amount }
}

const setup = () => {
  let actionSeenByLocal: Action = { type: '@@not-seen' }

  const localReducer: Reducer<LocalState> = (state = { calls: 0 }, action) => {
    actionSeenByLocal = action
    return { calls: state.calls + 1 }
  }

  const root = createSynquxRootReducer({
    isSyncedAction: isGameAction,
    synced: { game: gameReducer },
    locals: { local: localReducer },
  })
  const matchers = createSyncedActionMatchers(root)
  let state = root.rootReducer(undefined, { type: '@@INIT' })

  const dispatch = (action: Action): Action => {
    state = root.rootReducer(state, action)
    return actionSeenByLocal
  }

  const startSession = (enabled: boolean, selfId: string | null) => {
    dispatch(synquxActions.sessionStarted({ enabled, selfId }))
  }

  return { dispatch, matchers, startSession }
}

const gameAction = (
  type: `game/${string}`,
  meta?: SynquxActionMeta,
): GameAction => ({ type, payload: { amount: 1 }, meta })

describe('createSyncedActionMatchers', () => {
  it('受理された synced action の default success stamp を検知する', () => {
    const { dispatch, matchers } = setup()
    const action = dispatch(gameAction('game/increment', { hash: 'success' }))

    expect(matchers.isSucceededAction(action)).toBe(true)
  })

  it('stateWithError で拒否された synced action は成功と判定しない', () => {
    const { dispatch, matchers } = setup()
    const action = dispatch(gameAction('game/reject', { hash: 'error' }))

    expect(matchers.isSucceededAction(action)).toBe(false)
  })

  it('standalone で hash が両側 undefined でも非 synced action を成功と誤判定しない', () => {
    const { dispatch, matchers, startSession } = setup()
    startSession(false, null)
    dispatch(gameAction('game/increment'))

    const localAction = dispatch({ type: 'local/open-scene' })

    expect(matchers.isSucceededAction(localAction)).toBe(false)
  })

  it('meta.root が付いていない生の action は成功と判定しない', () => {
    const { matchers } = setup()

    expect(
      matchers.isSucceededAction(
        gameAction('game/increment', { hash: 'raw-action' }),
      ),
    ).toBe(false)
  })

  it('standalone では成功した synced action を自分の操作と判定する', () => {
    const { dispatch, matchers, startSession } = setup()
    startSession(false, null)
    const action = dispatch(gameAction('game/increment'))

    expect(matchers.isMySucceededAction(action)).toBe(true)
  })

  it.each([
    { requestedBy: 'self', selfId: 'self', expected: true },
    { requestedBy: 'other', selfId: 'self', expected: false },
    { requestedBy: 'self', selfId: null, expected: false },
  ])(
    '同期中は requestedBy=$requestedBy / selfId=$selfId で $expected',
    ({ requestedBy, selfId, expected }) => {
      const { dispatch, matchers, startSession } = setup()
      startSession(true, selfId)
      const action = dispatch(
        gameAction('game/increment', { hash: 'synced', requestedBy }),
      )

      expect(matchers.isMySucceededAction(action)).toBe(expected)
    },
  )

  it('isSucceededAction は TAction の type guard として payload を絞り込む', () => {
    const { dispatch, matchers } = setup()
    const action: Action = dispatch(
      gameAction('game/increment', { hash: 'typed' }),
    )

    const amount = matchers.isSucceededAction(action)
      ? action.payload.amount
      : null

    expect(amount).toBe(1)
  })
})
