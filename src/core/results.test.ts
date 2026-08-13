import { createReducer } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import {
  generateResult,
  isResultForPeer,
  stateWithDefaultResult,
  stateWithError,
  stateWithResult,
  stateWithTransaction,
} from './results.js'
import type { SynquxSynced } from './types.js'

/**
 * Phase 0 characterization (移植元 constants/requests.test.ts) の
 * generateResult / stateWithError 相当シナリオの新 API 移植
 */

type TestAction = {
  type: string
  payload?: number | null
  meta?: {
    hash?: string
    dispatched?: number
    requestedBy?: string
    root?: unknown
  }
}

const action: TestAction = {
  type: 'game/test',
  payload: null,
  meta: {
    hash: 'hash-1',
    dispatched: 1,
    requestedBy: 'peer-1',
    root: { game: {} }, // 永続化前に除去されるべき重たい meta
  },
}

describe('generateResult', () => {
  it('targets 未指定時は requestedBy 宛てになる', () => {
    const result = generateResult({ action, type: 'success' })
    expect(result.targets).toEqual(['peer-1'])
  })

  it('requestedBy がなければ targets は空 (standalone 扱い) になる', () => {
    const noRequester = {
      ...action,
      meta: { ...action.meta, requestedBy: undefined },
    }
    const result = generateResult({
      action: noRequester,
      type: 'success',
    })
    expect(result.targets).toEqual([])
  })

  it('action.meta.root は undefined 化される (JSON 直列化時に消える)', () => {
    // key 削除ではなく undefined 代入。key 自体は残るが、封筒の JSON.stringify で
    // 消えるため永続化データには含まれない、という 2 段構えで成立している
    const result = generateResult({ action, type: 'success' })
    expect(result.action.meta?.root).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('"root"')
    expect(result.action.meta?.hash).toBe('hash-1')
  })

  it('message 拡張は generics で型付けできる (ADR-0008)', () => {
    const result = generateResult<
      TestAction,
      { text: string; duration: number }
    >({
      action,
      type: 'success',
      message: { text: 'ok', duration: 3000 },
    })
    expect(result.message?.duration).toBe(3000)
  })
})

describe('isResultForPeer', () => {
  it.each([
    { result: null, peerId: 'peer-1', expected: false },
    { result: { targets: [] }, peerId: null, expected: true },
    { result: { targets: ['peer-1'] }, peerId: 'peer-1', expected: true },
    { result: { targets: ['peer-2'] }, peerId: 'peer-1', expected: false },
    { result: { targets: ['peer-1'] }, peerId: null, expected: false },
  ])(
    'targets と peerId の組から $expected を返す',
    ({ result, peerId, expected }) => {
      expect(isResultForPeer(result, peerId)).toBe(expected)
    },
  )
})

describe('stateWithError', () => {
  type State = SynquxSynced<TestAction>
  const plainAction: TestAction = {
    type: 'game/test',
    payload: null,
    meta: { hash: 'hash-1', dispatched: 1 },
  }

  it('message 省略時は action.type を log とした log 専用の拒否になる', () => {
    const state = stateWithError({ result: null } as State, plainAction)
    expect(state.result?.type).toBe('error')
    expect(state.result?.message).toBeUndefined()
    expect(state.result?.log).toBe('game/test')
  })

  it('message 指定時は UI 表示データが積まれ、log は付与されない', () => {
    const state = stateWithError({ result: null } as State, plainAction, {
      message: { text: 'NG' },
    })
    expect(state.result?.message).toEqual({ text: 'NG' })
    expect(state.result?.log).toBeUndefined()
  })

  it('message と log の併用は両チャネルに積まれる', () => {
    const state = stateWithError({ result: null } as State, plainAction, {
      message: { text: 'NG' },
      log: 'rejected: game/test',
    })
    expect(state.result?.message).toEqual({ text: 'NG' })
    expect(state.result?.log).toBe('rejected: game/test')
  })
})

describe('stateWithDefaultResult', () => {
  it('state を変更せず action 自身の silent success result を持つ新オブジェクトを返す', () => {
    const state: SynquxSynced<TestAction> & { count: number } = {
      result: null,
      count: 1,
    }
    const next = stateWithDefaultResult(state, action)

    expect(next).not.toBe(state)
    expect(state.result).toBeNull()
    expect(next.result).toMatchObject({
      type: 'success',
      action: { type: action.type, meta: { hash: action.meta?.hash } },
    })
    expect(next.result?.message).toBeUndefined()
    expect(next.result?.log).toBeUndefined()
  })
})

describe('stateWithTransaction', () => {
  type TransactionState = SynquxSynced<TestAction> & {
    count: number
    items: string[]
  }

  const transactionAction: TestAction = {
    type: 'game/transaction',
    meta: { hash: 'transaction-hash', requestedBy: 'peer-1' },
  }

  const stampedState = (): TransactionState =>
    stateWithDefaultResult(
      { result: null, count: 1, items: ['before'] },
      transactionAction,
    )

  it('success では複数 mutation を採用し、事前の default success stamp を保持する', () => {
    const base = stampedState()
    const next = stateWithTransaction(base, (draft) => {
      draft.count += 2
      draft.items.push('after')
    })

    expect(next).toEqual({
      ...base,
      count: 3,
      items: ['before', 'after'],
    })
    expect(next.result).toBe(base.result)
  })

  it('mutate 内の stateWithResult が success message を上書きして保持する', () => {
    const base = stampedState()
    const next = stateWithTransaction(base, (draft) => {
      draft.count += 1
      stateWithResult(draft, {
        action: transactionAction,
        type: 'success',
        message: { text: 'committed' },
      })
    })

    expect(next.count).toBe(2)
    expect(next.result).toMatchObject({
      type: 'success',
      message: { text: 'committed' },
    })
  })

  it('mutate 途中の error では全 domain mutation を巻き戻し、error result だけを載せる', () => {
    const base = stampedState()
    const next = stateWithTransaction(base, (draft) => {
      draft.count = 99
      draft.items.push('rolled-back')
      stateWithError(draft, transactionAction, {
        message: { text: 'rollback' },
      })
    })

    expect(next.count).toBe(base.count)
    expect(next.items).toEqual(base.items)
    expect(next.result).toMatchObject({
      type: 'error',
      message: { text: 'rollback' },
    })
  })

  it('RTK createReducer の immer producer 内で success / error の両経路が動く', () => {
    const reducer = createReducer(stampedState(), (builder) => {
      builder
        .addCase('transaction/success', (state) =>
          stateWithTransaction(state as TransactionState, (draft) => {
            draft.count += 1
            draft.items.push('committed')
          }),
        )
        .addCase('transaction/error', (state) =>
          stateWithTransaction(state as TransactionState, (draft) => {
            draft.count = 999
            draft.items.push('rolled-back')
            stateWithError(draft, transactionAction)
          }),
        )
    })

    const success = reducer(undefined, { type: 'transaction/success' })
    const error = reducer(undefined, { type: 'transaction/error' })

    expect(success).toMatchObject({ count: 2, items: ['before', 'committed'] })
    expect(error).toMatchObject({ count: 1, items: ['before'] })
    expect(error.result?.type).toBe('error')
  })

  it('plain object でも success / error の両経路が動く', () => {
    const successBase = stampedState()
    const success = stateWithTransaction(successBase, (draft) => {
      draft.count = 2
    })
    const errorBase = stampedState()
    const error = stateWithTransaction(errorBase, (draft) => {
      draft.count = 999
      stateWithError(draft, transactionAction)
    })

    expect(success.count).toBe(2)
    expect(successBase.count).toBe(1)
    expect(error.count).toBe(1)
    expect(error.result?.type).toBe('error')
    expect(errorBase.result?.type).toBe('success')
  })

  it('producer 内で外側 draft を先に変更してから呼ぶ契約違反は throw する', () => {
    const reducer = createReducer(stampedState(), (builder) => {
      builder.addCase('transaction/invalid', (state) => {
        state.count += 1
        return stateWithTransaction(state as TransactionState, (draft) => {
          draft.items.push('invalid')
        })
      })
    })

    expect(() => reducer(undefined, { type: 'transaction/invalid' })).toThrow(
      /returned a new value/,
    )
  })
})
