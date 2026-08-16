import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { buildSnapshotPayload } from './snapshot.js'
import {
  createClient,
  createHubClient,
  settle,
  subscribeSettled,
} from './test-fixtures.js'
import type { SnapshotEnvelope } from './types.js'
import type { GameState } from './test-fixtures.js'

const GROUP_ID = 'group-snapshot-fencing'

const readSnapshot = (
  hub: ReturnType<typeof createMemoryHub>,
): SnapshotEnvelope<GameState> => {
  const payload = hub.inspect.snapshot(GROUP_ID)
  expect(payload).not.toBeNull()
  return JSON.parse(payload!) as SnapshotEnvelope<GameState>
}

describe('snapshot fencing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('旧 host の遅延 snapshot を棄却し、migration 後の snapshot を巻き戻さない', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    const c = createHubClient(hub)

    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(10)

    const delayedOldHostSnapshots = hub.faults.holdSnapshot('peer-3')
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    c.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)

    hub.faults.disconnect('peer-3')
    await settle(10)

    c.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(20)
    const afterMigration = readSnapshot(hub)
    expect(afterMigration.ordering.appliedSeq).toBe(3)

    delayedOldHostSnapshots.release()
    await settle(20)

    const afterDelayedWrite = readSnapshot(hub)
    expect(afterDelayedWrite.ordering.appliedSeq).toBe(
      afterMigration.ordering.appliedSeq,
    )
    expect(afterDelayedWrite.ordering.epoch).toBe(afterMigration.ordering.epoch)

    const d = createHubClient(hub)
    await subscribeSettled(d, { groupId: GROUP_ID })
    await settle(20)
    expect(d.store.getState().game).toMatchObject({
      count: c.store.getState().game.count,
      log: c.store.getState().game.log,
    })
    // restore は transient な result を null へ落とす既存契約を維持する
    expect(d.store.getState().game.result).toBeNull()
  })

  it('fenced-out になった snapshot の後処理では prune しない', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const pruneRequests = vi.spyOn(transport, 'pruneRequests')
    transport.loadSnapshot = async () =>
      buildSnapshotPayload({
        synced: { result: null, count: 201, log: [] },
        ordering: { epoch: 1, appliedSeq: 201, applied: {} },
      })
    transport.saveSnapshot = vi.fn(async () => false)
    const client = createClient(transport, { devDeterminismCheck: false })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle(10)

    // appliedSeq 202 なら prune 線は 2 となり、snapshot=true なら呼ばれる。
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(20)

    expect(transport.saveSnapshot).toHaveBeenCalledTimes(1)
    expect(pruneRequests).not.toHaveBeenCalled()
  })
})
