import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { APPLIED_WINDOW_SIZE } from './ordering.js'
import { selectSyncHealth } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import { createHubClient, settle, type GameState } from './test-fixtures.js'

const GROUP_ID = 'group-retention'
const STALL_AFTER_MS = 5_000

const dispatchSequentially = async (
  client: ReturnType<typeof createHubClient>,
  count: number,
): Promise<void> => {
  for (let index = 1; index <= count; index += 1) {
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(5)
  }
}

const arrangePrunedHistory = async () => {
  const hub = createMemoryHub()
  const a = createHubClient(hub, {
    stallAfterMs: STALL_AFTER_MS,
    devDeterminismCheck: false,
  })
  const b = createHubClient(hub, {
    stallAfterMs: STALL_AFTER_MS,
    devDeterminismCheck: false,
  })
  await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
  await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
  await settle(10)

  const total = APPLIED_WINDOW_SIZE + 5
  await dispatchSequentially(a, total)
  await settle(20)
  return { hub, a, b, total }
}

describe('requests retention', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('snapshot ack 後、適用窓の外側だけを transport から prune する', async () => {
    const { hub, a, b, total } = await arrangePrunedHistory()
    const beforeSeq = total - APPLIED_WINDOW_SIZE
    const requests = hub.inspect.requests(GROUP_ID)

    expect(requests).toHaveLength(APPLIED_WINDOW_SIZE + 1)
    expect(requests.map(({ seq }) => seq)).toEqual(
      Array.from(
        { length: APPLIED_WINDOW_SIZE + 1 },
        (_, index) => beforeSeq + index,
      ),
    )
    expect(a.store.getState().game.count).toBe(total)
    expect(b.store.getState().game.count).toBe(total)

    const snapshot = parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
    expect(snapshot.ordering.appliedSeq).toBe(total)
    expect((snapshot.synced as GameState).count).toBe(total)
  })

  it('prune 後の途中参加端末が snapshot と残存 requests だけで収束する', async () => {
    const { hub, a, b, total } = await arrangePrunedHistory()
    const c = createHubClient(hub, {
      stallAfterMs: STALL_AFTER_MS,
      devDeterminismCheck: false,
    })

    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(30)

    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(total)
      expect(client.store.getState().game.log).toHaveLength(total)
      expect(selectSyncHealth(client.store.getState()).phase).toBe('ok')
    }

    // restore した ordering が同じ位置なら、新 host の c も次の seq を継続できる。
    c.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(20)
    expect(hub.inspect.requests(GROUP_ID).at(-1)?.seq).toBe(total + 1)
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(total + 10)
    }
  })

  it('prune 稼働後も窓内 gap を再購読で回復できる', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, {
      stallAfterMs: STALL_AFTER_MS,
      devDeterminismCheck: false,
    })
    const b = createHubClient(hub, {
      stallAfterMs: STALL_AFTER_MS,
      devDeterminismCheck: false,
    })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(10)

    await dispatchSequentially(a, APPLIED_WINDOW_SIZE + 2)
    const missingId = (APPLIED_WINDOW_SIZE + 3).toString().padStart(12, '0')
    hub.faults.drop({
      requestId: missingId,
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(10)

    expect(
      hub.inspect.requests(GROUP_ID).some(({ id }) => id === missingId),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 2_000)
    await settle(20)

    const expected = APPLIED_WINDOW_SIZE + 2 + 10 + 100
    expect(a.store.getState().game.count).toBe(expected)
    expect(b.store.getState().game.count).toBe(expected)
    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')
  })
})
