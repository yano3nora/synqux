import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { parseSnapshotPayload } from './snapshot.js'
import {
  createClient,
  createHubClient,
  settle,
  withoutOnReady,
  type GameState,
} from './test-fixtures.js'

const GROUP_ID = 'group-checkpoint'

/**
 * snapshot checkpoint (ADR-0021 Decision 4): host が persist 前に死んだ stale
 * snapshot を、barrier 通過後の host が自分の追いつき済み state で解消する
 */
describe('snapshot checkpoint (ADR-0021 Decision 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  /** 「裁定済みだが snapshot は永続化されないまま host が死んだ」状況を作る */
  const arrangeStaleSnapshot = async (
    hub: ReturnType<typeof createMemoryHub>,
  ): Promise<void> => {
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()
    hub.faults.disconnect('peer-1')
    await settle(5)
  }

  it('barrier 通過時に host なら checkpoint し、stale snapshot を解消する (トリガー a)', async () => {
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    const b = createHubClient(hub)
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    await subscribing
    await settle()

    // hosting epoch を確立してから保存するため epoch は観測最大 (1) を跨ぐ
    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 2,
      appliedSeq: 1,
    })
    const snapshot = parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
    expect((snapshot.synced as GameState).count).toBe(1)
  })

  it('barrier が timeout 縮退しても、host の replay 適用直後に checkpoint する (トリガー b)', async () => {
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    const delayedBacklog = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'added',
    })
    const b = createClient(withoutOnReady(hub.createTransport()))
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(10_500)
    await subscribing
    expect(b.store.getState().game.count).toBe(0)
    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()

    delayedBacklog.release()
    await settle()

    expect(b.store.getState().game.count).toBe(1)
    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 2,
      appliedSeq: 1,
    })
  })

  it('保存失敗は backoff retry で追い、成功したら watermark が進む', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    // 初回 + 1 回目の retry を失敗させ、2 回目の retry (計 3 試行目) で成功させる
    hub.faults.failSnapshot({ times: 2 })
    const b = createHubClient(hub)
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    await subscribing
    await settle(50)

    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 2,
      appliedSeq: 1,
    })
  })

  it('retry を使い切ったら諦める (best-effort 契約)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    // 初回 + retry 3 回 = 全 4 試行を失敗させる
    hub.faults.failSnapshot({ times: 4 })
    const b = createHubClient(hub)
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    await subscribing
    await settle(100)

    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()
  })

  it('durable fence と同値なら保存しない (epoch を無駄に進めない)', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 1,
      appliedSeq: 1,
    })
    await first.sync.unsubscribe()

    const b = createHubClient(hub)
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    await subscribing
    await settle()

    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 1,
      appliedSeq: 1,
    })
  })

  it('live 中の host 昇格でも checkpoint し、stale snapshot を解消する (migration)', async () => {
    const hub = createMemoryHub()
    // b (peer-1) を先に接続し、後続接続の a (peer-2) を host にする
    const b = createHubClient(hub)
    const a = createHubClient(hub)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(5)

    // host a の snapshot 保存を kill したまま裁定・全端末適用まで進める
    hub.faults.holdSnapshot('peer-2')
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(b.store.getState().game.count).toBe(1)
    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()

    // a のプロセス死 → live 適用済みの b が昇格する。replay 適用も barrier も
    // 再発生しないため、peer 変化での checkpoint 再評価だけが回復経路になる
    hub.faults.disconnect('peer-2')
    await settle(10)

    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 2,
      appliedSeq: 1,
    })
  })

  it('未解決の checkpoint 保存が残っても、再 subscribe 後の checkpoint はブロックされない', async () => {
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    // 次に接続する端末 (peer-2) の保存を先に hold し、checkpoint を宙吊りにする
    const held = hub.faults.holdSnapshot('peer-2')
    const b = createHubClient(hub)
    const subscribing = b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    await subscribing
    await settle()
    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()

    // 旧 session の保存が未解決のまま session を跨いでも、新 session の
    // checkpoint は走行中ガード (session 識別) に阻まれない
    await b.sync.unsubscribe()
    const resubscribing = b.sync.subscribe({
      store: b.store,
      groupId: GROUP_ID,
    })
    await settle()
    await resubscribing
    await settle()

    expect(hub.inspect.snapshotFence(GROUP_ID)).toEqual({
      epoch: 2,
      appliedSeq: 1,
    })
    held.release()
  })

  it('respondRequest の ack 待ち中に session が替わっても、旧裁定の後処理を新しい group へ持ち込まない', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    // 裁定の ack を保留する。local echo の changed は先に届き適用まで進む
    const heldAck = hub.faults.holdAck('000000000001')
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(client.store.getState().game.count).toBe(1)

    // ack 待ちの裁定 fork を残したまま session を跨ぐ (別 group は非サポートだが、
    // 壊れ方が「無関係な group への書き込み」にならないことを固定する)
    await client.sync.unsubscribe()
    await client.sync.subscribe({ store: client.store, groupId: 'group-cp-2' })
    await settle(5)

    heldAck.release()
    await settle()

    // 旧裁定の persistSnapshot も checkpoint も、新 group へは書き込まない
    expect(hub.inspect.snapshot('group-cp-2')).toBeNull()
    expect(hub.inspect.snapshot(GROUP_ID)).toBeNull()
  })

  it('host でない端末は checkpoint しない', async () => {
    const hub = createMemoryHub()
    await arrangeStaleSnapshot(hub)

    const guest = createHubClient(hub)
    const subscribing = guest.sync.subscribe({
      store: guest.store,
      groupId: GROUP_ID,
      role: 'guest',
    })
    await settle()
    await subscribing
    await settle(20)

    expect(guest.store.getState().game.count).toBe(1)
    expect(hub.inspect.snapshotFence(GROUP_ID)).toBeNull()
  })
})
