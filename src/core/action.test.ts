import type { Action } from '@reduxjs/toolkit'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  createSyncedAction,
  generateActionHash,
  type SyncedAction,
  type SyncedActionMeta,
} from './action.js'
import { createSynquxKit } from './kit.js'
import { createSynquxRootReducer } from './root-reducer.js'
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

describe('createSynquxKit', () => {
  type GameMessage = { text: string; duration?: number | null }
  type GameState = SynquxSynced<SyncedAction, GameMessage> & { count: number }
  type RootState = { synqux: SynquxState; game: GameState }

  const kit = createSynquxKit<{
    synced: GameState
    root: RootState
    message: GameMessage
  }>({
    syncedKey: 'game',
  })

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

  it('createSyncedAction が type を registry へ登録し isSyncedAction が判定する', () => {
    const own = createSynquxKit<{ synced: GameState; root: RootState }>({
      syncedKey: 'game',
    })
    const increment = own.createSyncedAction<number>('game/increment')

    expect(own.isSyncedAction(increment(1))).toBe(true)
    // 配達 action は封筒から再構築されるため、type 文字列だけでも判定できること
    expect(own.isSyncedAction({ type: 'game/increment' })).toBe(true)
    expect(own.isSyncedAction({ type: 'game/unregistered' })).toBe(false)
    expect(own.isSyncedAction({ type: 'synqux/restored' })).toBe(false)
  })

  it('synqux/ 予約 prefix の type は定義時に throw する (内部 action の registry 汚染防止)', () => {
    const own = createSynquxKit<{ synced: GameState; root: RootState }>({
      syncedKey: 'game',
    })

    expect(() => own.createSyncedAction('synqux/restored')).toThrow(
      /reserved "synqux\/" prefix/,
    )
    expect(own.isSyncedAction({ type: 'synqux/restored' })).toBe(false)
  })

  it('isSyncedAction は synced state から推論した domain action union へ narrow する', () => {
    type CountAction = Action<'game/increment'> & {
      payload: number
      meta: SyncedActionMeta
    }
    type CountState = SynquxSynced<CountAction> & { count: number }
    const own = createSynquxKit<{
      synced: CountState
      root: { synqux: SynquxState; game: CountState }
    }>({
      syncedKey: 'game',
    })
    const increment = own.createSyncedAction<number>('game/increment')

    // narrow の正しさは「登録 creator の action ⊆ union」の宣言整合に依存する
    // (手書き predicate と同じ契約)。ここでは整合した creator で branch を実走させる
    const action: Action = increment(1)
    expect(own.isSyncedAction(action)).toBe(true)
    if (own.isSyncedAction(action)) {
      expectTypeOf(action).toEqualTypeOf<CountAction>()
    }
  })

  it('registry は kit ごとに独立する (creator と述語は同じ kit から取る契約)', () => {
    const kitA = createSynquxKit<{ synced: GameState; root: RootState }>({
      syncedKey: 'game',
    })
    const kitB = createSynquxKit<{ synced: GameState; root: RootState }>({
      syncedKey: 'game',
    })
    const fromA = kitA.createSyncedAction('game/from-a')

    expect(kitA.isSyncedAction(fromA())).toBe(true)
    expect(kitB.isSyncedAction(fromA())).toBe(false)
  })

  it('matchers は registry / kit config から全束縛済みで、そのまま使える', () => {
    type TestRoot = { synqux: SynquxState; game: GameState; local: number }
    const own = createSynquxKit<{ synced: GameState; root: TestRoot }>({
      syncedKey: 'game',
    })
    const increment = own.createSyncedAction<number>('game/increment')

    // rootReducer 経由で default success result の stamp と meta.root の付与を
    // 実際に通し、locals reducer が受けた action で判定する (実配線と同じ経路)
    let seenByLocal: Action = { type: '@@none' }
    const root = createSynquxRootReducer({
      isSyncedAction: own.isSyncedAction,
      syncedKey: own.syncedKey,
      synced: (state: GameState = { result: null, count: 0 }, action) =>
        own.isSyncedAction(action)
          ? { ...state, count: state.count + 1 }
          : state,
      locals: {
        local: (state: number = 0, action: Action) => {
          seenByLocal = action
          return state + 1
        },
      },
    })

    const initial = root.rootReducer(undefined, { type: '@@INIT' })
    root.rootReducer(initial, increment(1))

    expect(own.isSucceededAction(seenByLocal)).toBe(true)
    expect(own.isSucceededAction({ type: 'game/unregistered' })).toBe(false)
  })
})
