import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createSyncedAction,
  generateActionHash,
  type SyncedAction,
  type SyncedActionMeta,
} from './action.js'
import { synquxKit } from './kit.js'
import type { SynquxState } from './slice.js'
import type { Result, SynquxSynced } from './types.js'

// ulid: 26 文字 Crockford base32 (I, L, O, U を含まない)
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

describe('generateActionHash', () => {
  it('ulid 形式 (26 文字 Crockford base32) で採番する', () => {
    expect(generateActionHash()).toMatch(ULID_PATTERN)
  })

  it('同一端末内の生成順で辞書順単調 (monotonic)', () => {
    const hashes = Array.from({ length: 100 }, () => generateActionHash())

    expect([...hashes].sort()).toEqual(hashes)
    expect(new Set(hashes).size).toBe(100)
  })
})

describe('createSyncedAction', () => {
  it('生成時に hash (ulid) / dispatched を付与する', () => {
    const increment = createSyncedAction<number>('game/increment')
    const before = Date.now()
    const action = increment(3)

    expect(action.type).toBe('game/increment')
    expect(action.payload).toBe(3)
    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expect(action.meta.dispatched).toBeGreaterThanOrEqual(before)
  })

  it('同じ creator でも呼び出しごとに別 hash (1 生成 = 1 意図)', () => {
    const increment = createSyncedAction<number>('game/increment')

    expect(increment(1).meta.hash).not.toBe(increment(1).meta.hash)
  })

  it('prepare callback の payload / meta を維持したまま stamp を合成する', () => {
    const launch = createSyncedAction(
      'game/launch',
      (phase: string, count: number) => ({
        payload: { phase, count },
        meta: { source: 'test' },
      }),
    )
    const action = launch('1-development', 2)

    expect(action.payload).toEqual({ phase: '1-development', count: 2 })
    expect(action.meta.source).toBe('test')
    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expect(typeof action.meta.dispatched).toBe('number')
  })

  it('prepare が焼き込んだ hash / dispatched を尊重する (result 照合テスト用)', () => {
    const launch = createSyncedAction('game/launch', () => ({
      payload: undefined,
      meta: { hash: '01HFIXED000000000000000000', dispatched: 1_000 },
    }))
    const action = launch()

    expect(action.meta.hash).toBe('01HFIXED000000000000000000')
    expect(action.meta.dispatched).toBe(1_000)
  })

  it('prepare が meta を返さなくても stamp され、型からも meta が消えない', () => {
    const noMeta = createSyncedAction('game/no-meta', () => ({
      payload: 1,
      meta: undefined,
    }))
    const action = noMeta()

    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expectTypeOf(action.meta.hash).toBeString()
  })

  it('予約 field へ型を欺いた不正値が来ても typeof 検証で正しい採番へ倒す', () => {
    const invalid = createSyncedAction('game/invalid', () => ({
      payload: 1,
      meta: { hash: 123, dispatched: 'bad' } as unknown as {
        hash: string
        dispatched: number
      },
    }))
    const action = invalid()

    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expect(typeof action.meta.dispatched).toBe('number')
  })

  it('undefined を含む payload は引数省略で呼べる (RTK createAction 追従)', () => {
    const optional = createSyncedAction<string | undefined>('game/optional')

    expect(optional().payload).toBeUndefined()
    expect(optional('x').payload).toBe('x')
  })

  it('meta が required で型推論される (reducer 側の注釈を不要にする)', () => {
    const increment = createSyncedAction<number>('game/increment')
    const action = increment(1)

    expectTypeOf(action.meta).toMatchTypeOf<SyncedActionMeta>()
    expectTypeOf(action.meta.hash).toBeString()
    expectTypeOf(action.meta.dispatched).toBeNumber()
  })
})

describe('synquxKit.withTypes', () => {
  type GameMessage = { text: string; duration?: number | null }
  type GameState = SynquxSynced<SyncedAction, GameMessage> & { count: number }
  type RootState = { synqux: SynquxState; game: GameState }

  const kit = synquxKit.withTypes<{
    synced: GameState
    root: RootState
    message: GameMessage
  }>()

  it('束縛済み stateWithError が domain 型のまま error result を積む', () => {
    const increment = kit.createSyncedAction<number>('game/increment')
    const state: GameState = { result: null, count: 10 }
    const next = kit.stateWithError({ ...state }, increment(1), {
      message: { text: '10までです。', duration: null },
    })

    expect(next.count).toBe(10)
    expect(next.result?.type).toBe('error')
    expect(next.result?.message?.duration).toBeNull()
  })

  it('束縛済み generateResult の message が拡張型で推論される', () => {
    const increment = kit.createSyncedAction<number>('game/increment')
    const result = kit.generateResult({
      action: increment(1),
      type: 'success',
      message: { text: 'ok', duration: 2500 },
    })

    expectTypeOf(result).toMatchTypeOf<Result>()
    expect(result.message?.duration).toBe(2500)
  })
})
