import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { deriveHostId } from './host.js'
import { selectIsHost } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'

const GROUP_ID = 'group-host-liveness'
const HEARTBEAT_INTERVAL_MS = 1_000
const STALE_THRESHOLD_MS = 5_000
const HOST_LIVENESS = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  staleThresholdMs: STALE_THRESHOLD_MS,
} as const

const peerRole = (hub: ReturnType<typeof createMemoryHub>, peerId: string) =>
  hub.inspect.peers(GROUP_ID).find((peer) => peer.id === peerId)?.role

describe('host liveness heartbeat + observer demote', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-12T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('停止再現→回復: observer が凍結 host を demote し、昇格後に滞留 request を裁定・適用する', async () => {
    const hub = createMemoryHub()
    const observer = createHubClient(hub, { hostLiveness: HOST_LIVENESS })

    await observer.sync.subscribe({ store: observer.store, groupId: GROUP_ID })
    await settle(5)

    // 素 transport だけを接続し、presence は生きているが engine は止まった host を作る。
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)
    expect(selectIsHost(observer.store.getState())).toBe(false)

    observer.store.dispatch({ type: 'game/increment', payload: 3 })
    await settle(10)
    expect(observer.store.getState().game.count).toBe(0)

    await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS)
    await settle(20)

    expect(peerRole(hub, 'peer-2')).toBe('guest')
    expect(selectIsHost(observer.store.getState())).toBe(true)
    expect(observer.store.getState().game.count).toBe(3)
    expect(hub.inspect.requests(GROUP_ID)[0]).toMatchObject({
      requestedBy: 'peer-1',
      responsedBy: 'peer-1',
    })
  })

  it('閾値内は demote しない: 観測開始から staleThresholdMs 未満では role を維持する', async () => {
    const hub = createMemoryHub()
    const observer = createHubClient(hub, { hostLiveness: HOST_LIVENESS })

    await observer.sync.subscribe({ store: observer.store, groupId: GROUP_ID })
    await settle(5)
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)

    await vi.advanceTimersByTimeAsync(
      STALE_THRESHOLD_MS - HEARTBEAT_INTERVAL_MS,
    )

    expect(peerRole(hub, 'peer-2')).toBe('player')
    expect(selectIsHost(observer.store.getState())).toBe(false)
  })

  it('connected 起点: 新 host を直後に demote せず、生きている host は lastSeenAt を更新し続ける', async () => {
    const hub = createMemoryHub()
    const observer = createHubClient(hub, { hostLiveness: HOST_LIVENESS })

    await observer.sync.subscribe({ store: observer.store, groupId: GROUP_ID })
    await settle(15)
    const firstHeartbeat = hub.inspect
      .peers(GROUP_ID)
      .find((peer) => peer.id === 'peer-1')?.lastSeenAt
    expect(firstHeartbeat).toBeTypeOf('number')

    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    const nextHeartbeat = hub.inspect
      .peers(GROUP_ID)
      .find((peer) => peer.id === 'peer-1')?.lastSeenAt
    expect(nextHeartbeat).toBeGreaterThan(firstHeartbeat!)

    // lastSeenAt がまだ無い新 host は connected を鮮度の起点として扱う。
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)
    await vi.advanceTimersByTimeAsync(
      STALE_THRESHOLD_MS - HEARTBEAT_INTERVAL_MS,
    )

    const frozenPeer = hub.inspect
      .peers(GROUP_ID)
      .find((peer) => peer.id === 'peer-2')
    expect(frozenPeer).toMatchObject({ role: 'player' })
    expect(frozenPeer?.lastSeenAt).toBeUndefined()
  })

  it('同時 demote の冪等収束: 複数 observer が降格しても role と導出 host が一意に収束する', async () => {
    const hub = createMemoryHub()
    const bTransport = hub.createTransport()
    const cTransport = hub.createTransport()
    const bDemote = vi.spyOn(bTransport, 'demotePeer')
    const cDemote = vi.spyOn(cTransport, 'demotePeer')
    const b = createClient(bTransport, { hostLiveness: HOST_LIVENESS })
    const c = createClient(cTransport, { hostLiveness: HOST_LIVENESS })

    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)

    await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS)
    await settle(20)

    const peers = hub.inspect.peers(GROUP_ID)
    expect(bDemote).toHaveBeenCalledWith('peer-3')
    expect(cDemote).toHaveBeenCalledWith('peer-3')
    expect(peers.filter((peer) => peer.id === 'peer-3')).toEqual([
      expect.objectContaining({ role: 'guest' }),
    ])
    const bHost = deriveHostId(
      Object.values(b.store.getState().synqux.connections.entities),
    )
    const cHost = deriveHostId(
      Object.values(c.store.getState().synqux.connections.entities),
    )
    expect(bHost).toBe('peer-2')
    expect(cHost).toBe(bHost)
    expect(selectIsHost(c.store.getState())).toBe(true)
  })

  it('候補不在ガード: demote 後に host 候補が残らない場合は凍結 host を維持する', async () => {
    const hub = createMemoryHub()
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    const observer = createHubClient(hub, { hostLiveness: HOST_LIVENESS })
    await observer.sync.subscribe({
      store: observer.store,
      groupId: GROUP_ID,
      role: 'guest',
    })
    await settle(10)

    await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS)
    await settle(10)

    expect(peerRole(hub, 'peer-1')).toBe('player')
    expect(selectIsHost(observer.store.getState())).toBe(false)
  })

  it('ゾンビ fencing: migration 後の新しい fence は旧 host の saveSnapshot を棄却する', async () => {
    const hub = createMemoryHub()
    const observer = createHubClient(hub, { hostLiveness: HOST_LIVENESS })

    await observer.sync.subscribe({ store: observer.store, groupId: GROUP_ID })
    await settle(5)
    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)
    observer.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)

    await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS)
    await settle(20)

    const persisted = parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
    expect(persisted.ordering).toMatchObject({ appliedSeq: 1 })
    expect(persisted.ordering.epoch).toBeGreaterThan(0)

    const accepted = await frozenHost.saveSnapshot(GROUP_ID, 'zombie', {
      epoch: persisted.ordering.epoch - 1,
      appliedSeq: Number.MAX_SAFE_INTEGER,
    })
    expect(accepted).toBe(false)
    expect(hub.inspect.snapshot(GROUP_ID)).not.toBe('zombie')
  })

  it('hostLiveness: false: 凍結 host を demote せず、自分が host の間も heartbeat を書かない', async () => {
    const hub = createMemoryHub()
    const observer = createHubClient(hub, { hostLiveness: false })

    await observer.sync.subscribe({ store: observer.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(31_000)
    expect(
      hub.inspect.peers(GROUP_ID).find((peer) => peer.id === 'peer-1')
        ?.lastSeenAt,
    ).toBeUndefined()

    const frozenHost = hub.createTransport()
    await frozenHost.connect({ groupId: GROUP_ID, role: 'player' })
    await settle(5)
    await vi.advanceTimersByTimeAsync(181_000)
    await settle(5)

    expect(peerRole(hub, 'peer-2')).toBe('player')
    expect(selectIsHost(observer.store.getState())).toBe(false)
  })

  it.each([
    {
      staleThresholdMs: HEARTBEAT_INTERVAL_MS * 2 - 1,
      message:
        'hostLiveness.staleThresholdMs must be at least twice heartbeatIntervalMs',
    },
    {
      staleThresholdMs: 0,
      message: 'hostLiveness.staleThresholdMs must be a positive finite number',
    },
    {
      staleThresholdMs: Number.NaN,
      message: 'hostLiveness.staleThresholdMs must be a positive finite number',
    },
  ])(
    'config validation: staleThresholdMs=$staleThresholdMs は createSynqux が同期的に拒否する',
    ({ staleThresholdMs, message }) => {
      const hub = createMemoryHub()

      expect(() =>
        createHubClient(hub, {
          hostLiveness: {
            heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
            staleThresholdMs,
          },
        }),
      ).toThrow(message)
    },
  )
})
