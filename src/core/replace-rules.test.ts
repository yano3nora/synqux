import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { SynquxAutomation, SynquxListener } from './create-synqux.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'

/**
 * replaceRules (TASK-260905): instance と session を生かしたまま automations /
 * listeners を差し替える口 (dev の HMR 用)
 */

const GROUP_ID = 'group-replace-rules'
const START = new Date('2026-09-05T00:00:00.000Z').getTime()

/** 常時 announce を発行する rule (log に 'announce' が積まれる) */
const announceAlways = (
  overrides?: Partial<SynquxAutomation<GameState, GameAction>>,
): SynquxAutomation<GameState, GameAction> => ({
  id: 'announce',
  retryMs: 100,
  when: () => true,
  action: () => ({ type: 'game/announce' }),
  ...overrides,
})

/** count が上限未満の間 increment を発行する rule */
const incrementUntil = (
  limit: number,
  overrides?: Partial<SynquxAutomation<GameState, GameAction>>,
): SynquxAutomation<GameState, GameAction> => ({
  id: 'increment',
  retryMs: 100,
  when: (synced) => synced.count < limit,
  action: () => ({ type: 'game/increment', payload: 1 }),
  ...overrides,
})

const incrementListener = (
  id: string,
  effect: SynquxListener<GameState, GameAction>['effect'],
): SynquxListener<GameState, GameAction> => ({
  id,
  mode: 'everyone',
  match: (action) => action.type === 'game/increment',
  effect,
})

const announces = (log: string[]): number =>
  log.filter((entry) => entry === 'announce').length

describe('replaceRules', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    // announce の result.log は console 出力されるため黙らせる
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('automations を差し替えると旧 rule は以後発行されず、新 rule が発行される', async () => {
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
      automations: [announceAlways()],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(350)
    const announcedBefore = announces(client.store.getState().game.log)
    expect(announcedBefore).toBeGreaterThan(0)
    expect(client.store.getState().game.count).toBe(0)

    client.sync.replaceRules({ automations: [incrementUntil(3)] })
    await vi.advanceTimersByTimeAsync(1000)

    expect(client.store.getState().game.count).toBe(3)
    expect(announces(client.store.getState().game.log)).toBe(announcedBefore)
  })

  it('差し替え時に rule id ごとの発行時刻を引き継ぎ、retryMs 内は再発行しない', async () => {
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
      automations: [incrementUntil(10, { retryMs: 1000 })],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    // 初回 tick (retryMs) で 1 回発行
    await vi.advanceTimersByTimeAsync(1000)
    expect(client.store.getState().game.count).toBe(1)

    // 同 id の rule へ差し替え (engine 再起動)。発行直後なので即時再発行しない
    await vi.advanceTimersByTimeAsync(100)
    client.sync.replaceRules({
      automations: [incrementUntil(10, { retryMs: 1000 })],
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(client.store.getState().game.count).toBe(1)

    // retryMs 経過後は新 engine が発行する
    await vi.advanceTimersByTimeAsync(600)
    expect(client.store.getState().game.count).toBe(2)
  })

  it('初期 automations が 0 件でも、差し替え後の rule が評価・発行される', async () => {
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(300)
    expect(client.store.getState().game.count).toBe(0)

    client.sync.replaceRules({ automations: [incrementUntil(2)] })
    await vi.advanceTimersByTimeAsync(500)

    expect(client.store.getState().game.count).toBe(2)
  })

  it('validation 失敗 (id 重複) は throw し、既存の rule を据え置く', async () => {
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
      automations: [incrementUntil(2)],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    expect(() =>
      client.sync.replaceRules({
        automations: [announceAlways(), announceAlways()],
        listeners: [],
      }),
    ).toThrow('Duplicate SynquxAutomation id: announce')

    await vi.advanceTimersByTimeAsync(500)
    expect(client.store.getState().game.count).toBe(2)
    expect(announces(client.store.getState().game.log)).toBe(0)
  })

  it('serverNow 待ち中に差し替えても旧 engine は発行しない', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    let releaseNow: (now: number) => void = () => undefined
    let gate = false
    const serverNow = vi.spyOn(transport, 'serverNow')
    const client = createClient(transport, {
      // gate が閉じている間は発行しない (差し替え前の in-flight request を作らない)
      automations: [announceAlways({ when: () => gate })],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle(5)

    // gate を開けた直後の evaluate を serverNow の await で止める
    gate = true
    serverNow.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          releaseNow = resolve
        }),
    )
    await vi.advanceTimersByTimeAsync(100)
    expect(announces(client.store.getState().game.log)).toBe(0)

    client.sync.replaceRules({ automations: [incrementUntil(1)] })
    releaseNow(Date.now())
    await settle()

    // 旧 engine の evaluate は active 検査で発行を止め、新 rule だけが動く
    expect(announces(client.store.getState().game.log)).toBe(0)
    expect(client.store.getState().game.count).toBe(1)
  })

  it('listeners を差し替えると旧 listener は発火せず、新 listener が発火する', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
      listeners: [incrementListener('first', first)],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(first).toHaveBeenCalledTimes(1)

    client.sync.replaceRules({
      listeners: [incrementListener('second', second)],
    })
    client.store.dispatch({ type: 'game/increment', payload: 1 })

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('scope: all の listener を後付けすると local action でも発火する', async () => {
    const effect = vi.fn()
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.store.dispatch({ type: 'local/probe' })
    expect(effect).not.toHaveBeenCalled()

    client.sync.replaceRules({
      listeners: [
        {
          id: 'local',
          mode: 'everyone',
          scope: 'all',
          match: (action) => action.type === 'local/probe',
          effect,
        },
      ],
    })
    client.store.dispatch({ type: 'local/probe' })

    expect(effect).toHaveBeenCalledTimes(1)
  })
})
