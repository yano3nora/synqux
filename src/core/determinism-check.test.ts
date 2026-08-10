import {
  configureStore,
  isAction,
  type Action,
  type Reducer,
} from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createSynqux } from './create-synqux.js'
import { synquxReducer, synquxRestored, type SynquxState } from './slice.js'
import { createHubClient, settle } from './test-fixtures.js'
import type { Result, SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * 決定性検出網 (ADR-0001 Decision 8 / D4) の検証
 *
 * 純粋性契約 (synced reducer は payload と決定的 meta しか読めない) でも
 * 防げない Date.now / Math.random 等の残余クラスを、「host の試し実行結果 vs
 * 実適用後 state」の比較で dev モードに検出できることを確認する
 */

const GROUP_ID = 'group-determinism'

describe('devDeterminismCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('非決定な reducer (Math.random) は host 端末で検出され console.error される', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub) // 単独接続 = 自分が host = 試し実行と実適用が同一端末

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/random' })
    await settle()

    expect(client.store.getState().game.log).toEqual(['random'])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Determinism check failed'),
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('diverged at "count"'),
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringMatching(/diverged at "count": expected .+, actual .+/),
    )

    consoleError.mockRestore()
  })

  it('entity 消滅待ち poll より速く後続 request が適用されても false positive にならない', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub)

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    // 1 つ目の適用直後、entity 消滅待ち poll (WAKE_FALLBACK_MS = 1000ms) の
    // 初回判定が走る前に 2 つ目を適用させる。照合をこの poll の後に行うと
    // 「2 つ目適用後の state」を 1 つ目の期待値と比較してしまい誤検知する
    // (実機で 1 秒未満の間隔の連続操作により毎回発生した回帰の再現)
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(5) // 500ms: 配送・裁定・適用は進むが poll の初回判定はまだ
    client.store.dispatch({ type: 'game/increment', payload: 2 })
    await settle()

    expect(client.store.getState().game.count).toBe(3)
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('決定的な reducer では何も報告されない (対照)', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub)

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(client.store.getState().game.count).toBe(1)
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('封筒 meta を result.action に保持する決定的な consumer reducer では報告されない', async () => {
    type GameAction = Action<'game/increment'> & {
      payload: number
      meta?: SynquxActionMeta
    }
    type GameState = SynquxSynced<GameAction> & { count: number }
    type RootState = { synqux: SynquxState; game: GameState }

    const initialGame: GameState = { result: null, count: 0 }
    const isGameAction = (action: Action): action is GameAction =>
      action.type === 'game/increment'
    const gameReducer: Reducer<GameState> = (state = initialGame, action) => {
      if (!isAction(action) || !isGameAction(action)) {
        return state
      }

      // consumer の matcher 相当: transport が付けた封筒 meta を含む action
      // 自体を result に保存しても、試し実行と実適用は一致する必要がある。
      const result: Result<GameAction> = {
        action,
        type: 'success',
        targets: [],
      }
      return { result, count: state.count + action.payload }
    }
    const rootReducer: Reducer<RootState> = (state, action) => {
      if (synquxRestored.match(action)) {
        return {
          synqux: synquxReducer(state?.synqux, action),
          game: action.payload.synced as GameState,
        }
      }

      return {
        synqux: synquxReducer(state?.synqux, action),
        game: gameReducer(state?.game, action),
      }
    }

    const hub = createMemoryHub()
    const sync = createSynqux<RootState, GameState, GameAction>({
      transport: hub.createTransport(),
      isSyncedAction: isGameAction,
      rootReducer,
      selectSynced: (root) => root.game,
    })
    const store = configureStore({
      reducer: rootReducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().prepend(...sync.middlewares),
    })
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    await sync.subscribe({ store, groupId: GROUP_ID })
    await settle()

    store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(store.getState().game.count).toBe(1)
    expect(store.getState().game.result?.action.meta).toMatchObject({
      hash: expect.any(String),
      requestedBy: expect.any(String),
      dispatched: expect.any(Number),
    })
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('devDeterminismCheck: false で無効化できる (production 相当)', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub, { devDeterminismCheck: false })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/random' })
    await settle()

    expect(client.store.getState().game.log).toEqual(['random'])
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
