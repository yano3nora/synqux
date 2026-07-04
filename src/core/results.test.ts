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
    const result = generateResult({ action, type: 'success', message: '' })
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
      message: '',
    })
    expect(result.targets).toEqual([])
  })

  it('action.meta.root は undefined 化される (JSON 直列化時に消える)', () => {
    // key 削除ではなく undefined 代入。key 自体は残るが、封筒の JSON.stringify で
    // 消えるため永続化データには含まれない、という 2 段構えで成立している
    const result = generateResult({ action, type: 'success', message: '' })
    expect(result.action.meta?.root).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('"root"')
    expect(result.action.meta?.hash).toBe('hash-1')
  })
})

describe('stateWithError', () => {
  type State = SynquxSynced<TestAction>
  const plainAction: TestAction = {
    type: 'game/test',
    payload: null,
    meta: { hash: 'hash-1', dispatched: 1 },
  }

  it('message 省略時は action.type を message とし console 通知になる', () => {
    const state = stateWithError({ result: null } as State, plainAction)
    expect(state.result?.type).toBe('error')
    expect(state.result?.message).toBe('game/test')
    expect(state.result?.console).toBe(true)
  })

  it('message 指定時は console にならず画面通知になる', () => {
    const state = stateWithError({ result: null } as State, plainAction, {
      message: 'NG',
    })
    expect(state.result?.message).toBe('NG')
    expect(state.result?.console).toBeUndefined()
  })
})
