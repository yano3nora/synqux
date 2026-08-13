import type { Action, Reducer, UnknownAction } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import {
  createSyncedActionMatchers,
  isDeliveredSyncedAction,
  isSynquxAction,
} from './matchers.js'
import { stateWithError } from './results.js'
import { createSynquxRootReducer } from './root-reducer.js'
import { synquxActions, synquxRestored } from './slice.js'
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

  const startSession = (
    mode: 'synced' | 'standalone',
    selfId: string | null,
  ) => {
    dispatch(synquxActions.sessionStarted({ mode, selfId }))
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
    startSession('standalone', null)
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
    startSession('standalone', null)
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
      startSession('synced', selfId)
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

describe('isSynquxAction', () => {
  it('内部 action を判定し consumer action を除外する', () => {
    expect(
      isSynquxAction(
        synquxActions.sessionStarted({ selfId: null, mode: 'standalone' }),
      ),
    ).toBe(true)
    expect(isSynquxAction(synquxRestored({ synced: {} }))).toBe(true)
    expect(isSynquxAction({ type: 'game/foo' })).toBe(false)
  })
})

describe('isDeliveredSyncedAction', () => {
  const deliveredMeta = {
    requestedBy: 'peer-1',
    dispatched: 1,
    responsedBy: 'peer-host',
    responsed: 2,
    epoch: 1,
    seq: 3,
  }

  it('request / response の同期情報が揃えば配達済み action と判定する', () => {
    const action = {
      type: 'game/foo',
      meta: deliveredMeta,
    }

    expect(isDeliveredSyncedAction(action)).toBe(true)
  })

  it.each([
    'requestedBy',
    'dispatched',
    'responsedBy',
    'responsed',
    'epoch',
    'seq',
  ] as const)('%s がなければ false', (missing) => {
    const action: UnknownAction = {
      type: 'game/foo',
      meta: { ...deliveredMeta, [missing]: undefined },
    }

    expect(isDeliveredSyncedAction(action)).toBe(false)
  })

  it('type guard として request / response meta を必須へ絞り込む', () => {
    const action: UnknownAction = {
      type: 'game/foo',
      meta: deliveredMeta,
    }

    const delivery = isDeliveredSyncedAction(action)
      ? [
          action.meta.requestedBy,
          action.meta.dispatched,
          action.meta.responsedBy,
          action.meta.seq,
        ]
      : null

    expect(delivery).toEqual(['peer-1', 1, 'peer-host', 3])
  })
})
