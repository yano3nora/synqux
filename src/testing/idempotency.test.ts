import type { Action, Reducer } from '@reduxjs/toolkit'
import { describe, expect, it, vi } from 'vitest'
import { stateWithError, stateWithResult } from '../core/results.js'
import type { SynquxSynced } from '../core/types.js'
import {
  gameInitialState,
  gameReducer,
  type GameAction,
  type GameState,
} from '../core/test-fixtures.js'
import {
  assertActionIdempotency,
  verifyActionIdempotency,
} from './idempotency.js'

type ContractAction = Action<`contract/${string}`> & { payload?: number }
type ContractState = SynquxSynced<ContractAction> & {
  count: number
  log: string[]
}

const initialState: ContractState = { result: null, count: 0, log: [] }

const success = (state: ContractState, action: ContractAction): ContractState =>
  stateWithResult(
    { ...state },
    {
      action,
      type: 'success',
      // as string: template literal 型のまま TMessage が推論されるのを防ぐ
      message: { text: action.type as string },
    },
  )

describe('verifyActionIdempotency', () => {
  it('result の変化を除外し、domain state の冪等性だけを報告する', () => {
    const action: ContractAction = { type: 'contract/execute-once' }
    const reducer: Reducer<ContractState> = (state = initialState) => {
      if (state.count === 0) {
        return success({ ...state, count: 1 }, action)
      }

      return stateWithError({ ...state }, action)
    }

    const report = verifyActionIdempotency({
      reducer,
      state: initialState,
      action,
    })

    expect(report.idempotent).toBe(true)
    expect(report.single.result?.type).toBe('success')
    expect(report.double.result?.type).toBe('error')
  })

  it('toggle 系は domain state の非冪等を引き続き検出する', () => {
    const report = verifyActionIdempotency({
      reducer: gameReducer,
      state: gameInitialState,
      action: { type: 'game/toggle' },
    })

    expect(report.idempotent).toBe(false)
  })
})

describe('assertActionIdempotency', () => {
  it("set 型は 'idempotent' で pass する", () => {
    const action: ContractAction = { type: 'contract/set', payload: 1 }
    const reducer: Reducer<ContractState> = (state = initialState) =>
      success({ ...state, count: action.payload ?? 0 }, action)

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: initialState,
        action,
        mode: 'idempotent',
      }),
    ).not.toThrow()
  })

  it("toggle 型は 'idempotent' で fail する", () => {
    expect(() =>
      assertActionIdempotency({
        reducer: gameReducer,
        state: gameInitialState,
        action: { type: 'game/toggle' },
        mode: 'idempotent',
      }),
    ).toThrow('not idempotent in domain state')
  })

  it("execute-once 型は 'rejects-repeat' で pass する", () => {
    const action: ContractAction = { type: 'contract/execute-once' }
    const reducer: Reducer<ContractState> = (state = initialState) => {
      if (state.count === 0) {
        return success({ ...state, count: 1 }, action)
      }

      return stateWithError({ ...state }, action)
    }

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: initialState,
        action,
        mode: 'rejects-repeat',
      }),
    ).not.toThrow()
  })

  it("'rejects-repeat' は 1 回目から error なら fail する", () => {
    const action: ContractAction = { type: 'contract/always-reject' }
    const reducer: Reducer<ContractState> = (state = initialState) =>
      stateWithError({ ...state }, action)

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: initialState,
        action,
        mode: 'rejects-repeat',
      }),
    ).toThrow('first application was rejected')
  })

  it("'rejects-repeat' は 2 回目に domain state が変わるなら fail する", () => {
    const action: ContractAction = { type: 'contract/reject-after-change' }
    const reducer: Reducer<ContractState> = (state = initialState) => {
      if (state.count === 0) {
        return success({ ...state, count: 1 }, action)
      }

      return stateWithError({ ...state, count: state.count + 1 }, action)
    }

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: initialState,
        action,
        mode: 'rejects-repeat',
      }),
    ).toThrow('repeat changed domain state')
  })

  it("'rejects-repeat' は 2 回目を黙って受理するなら fail する", () => {
    const action: ContractAction = { type: 'contract/silent-repeat' }
    const reducer: Reducer<ContractState> = (state = initialState) =>
      success({ ...state, count: 1 }, action)

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: initialState,
        action,
        mode: 'rejects-repeat',
      }),
    ).toThrow('repeat was not rejected')
  })

  it("'repeatable' は増分型を明示的に検査除外する", () => {
    const reducer = vi.fn<Reducer<GameState>>(gameReducer)
    const action: GameAction = { type: 'game/increment', payload: 1 }

    expect(() =>
      assertActionIdempotency({
        reducer,
        state: gameInitialState,
        action,
        mode: 'repeatable',
      }),
    ).not.toThrow()
    expect(reducer).not.toHaveBeenCalled()
  })

  it("mode 省略時は 'idempotent' として後方互換に検査する", () => {
    expect(() =>
      assertActionIdempotency({
        reducer: gameReducer,
        state: gameInitialState,
        action: { type: 'game/toggle' },
      }),
    ).toThrow('not idempotent in domain state')
  })
})
