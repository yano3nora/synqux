import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SynquxListener } from './create-synqux.js'
import type { SnapshotStore } from './types.js'

const GROUP_ID = 'group-persisted'

const persistedListener = (
  id: string,
  effect: SynquxListener<GameState, GameAction>['effect'],
): SynquxListener<GameState, GameAction> => ({
  id,
  mode: 'everyone',
  fire: 'persisted',
  match: (action) => action.type === 'game/increment',
  effect,
})

/**
 * `fire: 'persisted'` (ADR-0021 Decision 3): effect の実行を「裁定印 (epoch, seq)
 * 以上の snapshot 耐久化 (persisted watermark)」まで遅延する
 */
describe("fire: 'persisted' (ADR-0021 Decision 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('host 端末では自分の persistSnapshot が commit するまで effect を保留する (情報源 a)', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()
    const host = createHubClient(hub, {
      listeners: [persistedListener('reset', effect)],
    })
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })

    const heldSnapshots = hub.faults.holdSnapshot('peer-1')
    host.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // 適用は済むが、耐久化が済んでいないため発火しない
    expect(host.store.getState().game.count).toBe(1)
    expect(effect).not.toHaveBeenCalled()

    heldSnapshots.release()
    await settle()

    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'game/increment' }),
      expect.objectContaining({ synced: host.store.getState().game }),
    )
  })

  it('非 host 端末では fence 購読で watermark が届いてから発火する (情報源 b)', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()
    // b を先に接続し (peer-1)、後続接続の a (peer-2) を host にする
    const b = createHubClient(hub, {
      listeners: [persistedListener('reset', effect)],
    })
    const a = createHubClient(hub)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(5)

    const heldSnapshots = hub.faults.holdSnapshot('peer-2')
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(b.store.getState().game.count).toBe(1)
    expect(effect).not.toHaveBeenCalled()

    // host の保存が server 確定した事実だけが fence 購読で配送される
    heldSnapshots.release()
    await settle()

    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('watermark 未達のまま上限を超えたら warn して発火しない (timeout drop)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const effect = vi.fn()
    const host = createHubClient(hub, {
      listeners: [persistedListener('reset', effect)],
    })
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })

    hub.faults.failSnapshot({ times: Number.POSITIVE_INFINITY })
    host.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(host.store.getState().game.count).toBe(1)

    await vi.advanceTimersByTimeAsync(31_000)

    expect(effect).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining("fire: 'persisted'"),
    )
  })

  it('unsubscribe は待機中の persisted effect と timeout timer を破棄する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const effect = vi.fn()
    const host = createHubClient(hub, {
      listeners: [persistedListener('reset', effect)],
    })
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })

    hub.faults.failSnapshot({ times: Number.POSITIVE_INFINITY })
    host.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(effect).not.toHaveBeenCalled()

    // session 破棄後は effect も timeout warn も発生しない (queue は session と
    // 運命を共にし、timer は teardown で資源として畳まれる)
    await host.sync.unsubscribe()
    await vi.advanceTimersByTimeAsync(31_000)

    expect(effect).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it('match / ctx の評価は適用直後に固定され、遅延するのは effect の実行だけ', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()
    const host = createHubClient(hub, {
      listeners: [persistedListener('reset', effect)],
    })
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })

    const heldSnapshots = hub.faults.holdSnapshot('peer-1')
    host.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    host.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()
    expect(effect).not.toHaveBeenCalled()

    heldSnapshots.release()
    await settle()

    // 各 effect の ctx.synced は「その適用直後」の state を保持している
    expect(effect).toHaveBeenCalledTimes(2)
    const contexts = effect.mock.calls.map(
      (call) => call[1] as { synced: GameState },
    )
    expect(contexts[0]!.synced.count).toBe(1)
    expect(contexts[1]!.synced.count).toBe(11)
  })

  it('standalone は local save の試行 settle 後に実行し、localSnapshots 無効なら適用直後に実行する', async () => {
    let resolveSave!: () => void
    const savePromise = new Promise<void>((resolve) => {
      resolveSave = resolve
    })
    const localSnapshots: SnapshotStore = {
      saveSnapshot: async () => {
        await savePromise
        return true
      },
      loadSnapshot: () => null,
    }
    const effect = vi.fn()
    const standalone = createClient(createMemoryHub().createTransport(), {
      mode: 'standalone',
      localSnapshots,
      listeners: [persistedListener('reset', effect)],
    })
    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone-persisted',
    })

    standalone.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(effect).not.toHaveBeenCalled()

    resolveSave()
    await vi.advanceTimersByTimeAsync(0)
    expect(effect).toHaveBeenCalledTimes(1)

    // localSnapshots 無効の session は永続化対象がなく適用直後に実行する
    const immediateEffect = vi.fn()
    const noStore = createClient(createMemoryHub().createTransport(), {
      mode: 'standalone',
      localSnapshots: false,
      listeners: [persistedListener('immediate', immediateEffect)],
    })
    await noStore.sync.subscribe({
      store: noStore.store,
      groupId: 'standalone-immediate',
    })

    noStore.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(immediateEffect).toHaveBeenCalledTimes(1)
  })

  it("local action (scope 'all') では 'applied' と同義で適用直後に実行する", async () => {
    const effect = vi.fn()
    const client = createHubClient(createMemoryHub(), {
      listeners: [
        {
          id: 'local-persisted',
          mode: 'everyone',
          scope: 'all',
          fire: 'persisted',
          match: (action) => action.type === 'ui/opened',
          effect,
        },
      ],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.store.dispatch({ type: 'ui/opened' })

    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('不正な fire 値は createSynqux が同期的に throw する', () => {
    expect(() =>
      createHubClient(createMemoryHub(), {
        listeners: [
          {
            id: 'invalid-fire',
            mode: 'everyone',
            fire: 'invalid' as SynquxListener<GameState, GameAction>['fire'],
            match: () => true,
            effect: vi.fn(),
          },
        ],
      }),
    ).toThrow('Invalid SynquxListener fire: invalid')
  })
})
