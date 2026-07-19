import { describe, expect, it } from 'vitest'
import { generateResult, stateWithError } from './results.js'
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
