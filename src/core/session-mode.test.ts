import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'
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
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
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
