import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { Synqux } from './create-synqux.js'
import { selectIsHost } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import {
  createClient,
  createHubClient,
  settle,
  subscribeSettled,
  type GameAction,
  type GameState,
  type RootState,
} from './test-fixtures.js'
import type { SnapshotStore, SynquxTransport } from './types.js'

const GROUP_ID = 'group-session-mode'

describe('session mode', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('instance 既定の standalone は local 即時適用し localSnapshots へ保存する', async () => {
    const saveSnapshot = vi.fn()
    const localSnapshots: SnapshotStore = {
      saveSnapshot,
      loadSnapshot: () => null,
    }
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      mode: 'standalone',
      localSnapshots,
    })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    client.store.dispatch({ type: 'game/increment', payload: 5 })

    expect(client.store.getState().game.count).toBe(5)
    expect(hub.inspect.requests(GROUP_ID)).toEqual([])
    expect(saveSnapshot).toHaveBeenCalledOnce()
  })

  it('seedSynced は standalone session の synced subtree を全量差し替え、result を除去する', async () => {
    const client = createHubClient(createMemoryHub())

    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
      seedSynced: {
        result: {
          action: { type: 'game/increment' as const, payload: 1 },
          type: 'success' as const,
          targets: [],
        },
        count: 9,
        log: ['seeded'],
      },
    })

    // restore 経路に合流するため result は除去される (過去 toast の再生防止)
    expect(client.store.getState().game).toEqual({
      result: null,
      count: 9,
      log: ['seeded'],
    })

    // seed 起点の使い捨て session でも通常の standalone として動作する
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(client.store.getState().game.count).toBe(10)
  })

  it('seedSynced 指定時は localSnapshots を load しない (明示 > 永続)', async () => {
    const localSnapshots: SnapshotStore = {
      saveSnapshot: vi.fn(),
      loadSnapshot: vi.fn(),
    }
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots,
    })

    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      seedSynced: { result: null, count: 3, log: [] },
    })

    expect(localSnapshots.loadSnapshot).not.toHaveBeenCalled()
    expect(client.store.getState().game.count).toBe(3)

    // localSnapshots 有効との併用は「seed 起点の新規セーブ開始」になる
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(localSnapshots.saveSnapshot).toHaveBeenCalledOnce()
  })

  it('seedSynced は前 session の ordering を引き継がない (適用側の新規化)', async () => {
    const saveSnapshot = vi.fn().mockResolvedValue(true)
    const localSnapshots: SnapshotStore = {
      saveSnapshot,
      loadSnapshot: () => null,
    }
    const hub = createMemoryHub()
    const client = createHubClient(hub, { localSnapshots })

    // synced session で ordering を進める (単独端末 = host が自己裁定)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(client.store.getState().game.count).toBe(1)
    await client.sync.unsubscribe()

    // 同一 instance で seed 起点の standalone を開始。localSnapshots 有効の
    // 「新規セーブ開始」で保存される snapshot に古い ordering が焼かれないこと
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      seedSynced: { result: null, count: 50, log: [] },
    })
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(client.store.getState().game.count).toBe(51)

    const payload = saveSnapshot.mock.lastCall?.[1] as string
    const envelope = parseSnapshotPayload(payload)
    expect(envelope.ordering.appliedSeq).toBe(0)
    expect(envelope.ordering.applied).toEqual({})
  })

  it('seed session 後の synced 復帰は、snapshot 欠損でも backlog replay を受け直せる', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)

    // 裁定は成立するが snapshot 保存が失敗し続ける縮退 (保存失敗 / 欠損の模擬)
    hub.faults.failSnapshot({ times: 100 })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(client.store.getState().game.count).toBe(1)
    expect(hub.inspect.snapshot(GROUP_ID)).toBeNull()
    await client.sync.unsubscribe()

    // tutorial 相当の seed session を挟む
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
      seedSynced: { result: null, count: 50, log: [] },
    })
    await client.sync.unsubscribe()

    // seed は session-scoped: teardown で reducer の初期 state へ戻る
    // (残すと以降の synced 復帰で seed が正史へ暗黙マージされる)
    expect(client.store.getState().game.count).toBe(0)

    // snapshot 欠損の synced 復帰では裁定済み request が added で再配達される。
    // 前 session の added guard / 適用済み判定が ordering に残っていると
    // 破棄され、履歴を replay できないまま収束しない (reset で受け直せること)。
    // 初期 state からの replay なので正史 (initial + backlog) が再構築される
    const pending = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await settle()
    await pending

    expect(client.store.getState().game.log).toEqual(['increment:1'])
    expect(client.store.getState().game.count).toBe(1)
  })

  it('synced mode + seedSynced は subscribe を reject する (正史は transport snapshot)', async () => {
    const client = createHubClient(createMemoryHub())

    await expect(
      client.sync.subscribe({
        store: client.store,
        groupId: GROUP_ID,
        mode: 'synced',
        seedSynced: { result: null, count: 1, log: [] },
      }),
    ).rejects.toThrow(/standalone-only/)
  })

  it('Synqux の TSynced generic は default (never) で既存の 2 引数注釈と互換', () => {
    const client = createClient(createMemoryHub().createTransport())

    // 既存 consumer の型注釈 (TSynced なし) がそのまま通ること (variance 互換)
    expectTypeOf(client.sync).toMatchTypeOf<Synqux<RootState, GameAction>>()
    // seedSynced は createSynqux の TSynced で型付けされること
    expectTypeOf(client.sync.subscribe)
      .parameter(0)
      .toHaveProperty('seedSynced')
      .toEqualTypeOf<GameState | undefined>()
  })

  it('localSnapshots: false の standalone session は既存 save key を read / write しない', async () => {
    const localSnapshots: SnapshotStore = {
      saveSnapshot: vi.fn(),
      loadSnapshot: vi.fn(),
    }
    const client = createHubClient(createMemoryHub(), { localSnapshots })

    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })
    client.store.dispatch({ type: 'game/increment', payload: 1 })

    expect(localSnapshots.loadSnapshot).not.toHaveBeenCalled()
    expect(localSnapshots.saveSnapshot).not.toHaveBeenCalled()
  })

  it('synced instance の standalone session は transport に触れず local 完結する', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const connect = vi.spyOn(transport, 'connect')
    const pushRequest = vi.spyOn(transport, 'pushRequest')
    const client = createHubClient(hub)
    // fixture が生成した transport ではなく、spy 対象で session 経路を検証する。
    const direct = createHubClientFromTransport(transport)

    await direct.sync.subscribe({
      store: direct.store,
      groupId: GROUP_ID,
      mode: 'standalone',
    })
    direct.store.dispatch({ type: 'game/increment', payload: 3 })

    expect(direct.store.getState().game.count).toBe(3)
    expect(connect).not.toHaveBeenCalled()
    expect(pushRequest).not.toHaveBeenCalled()
    expect(hub.inspect.peers(GROUP_ID)).toEqual([])
    expect(client.store.getState().game.count).toBe(0)
  })

  it('tutorial session 後は synced の再 subscribe で snapshot の正史へ復帰する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    let unsubscribeA = await a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
    })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()
    expect(a.store.getState().game.count).toBe(10)

    await unsubscribeA()
    unsubscribeA = await a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })
    a.store.dispatch({ type: 'game/increment', payload: 5 })
    expect(a.store.getState().game.count).toBe(15)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    await unsubscribeA()
    await subscribeSettled(a, { groupId: GROUP_ID })
    await settle()

    expect(a.store.getState().game.count).toBe(10)
    expect(a.store.getState().game.log).toEqual(['increment:10'])
  })

  it('standalone session 中の selectIsHost は true', async () => {
    const client = createHubClient(createMemoryHub())
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })

    expect(selectIsHost(client.store.getState())).toBe(true)
  })
})

// transport method の非呼び出しを観測するため、hub wrapper を経由せず組み立てる。
const createHubClientFromTransport = (transport: SynquxTransport) =>
  createClient(transport)
