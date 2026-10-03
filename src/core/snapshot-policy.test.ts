import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { SynquxListener } from './create-synqux.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SnapshotEnvelope, SynquxTransport } from './types.js'

const GROUP_ID = 'group-snapshot-policy'
const THROTTLE_MS = 5_000

/** saveSnapshot の呼び出し回数を数える transport wrapper */
const countingTransport = (transport: SynquxTransport) => {
  let saves = 0
  const counted: SynquxTransport = {
    ...transport,
    saveSnapshot: (key, payload, fence) => {
      saves += 1
      return transport.saveSnapshot(key, payload, fence)
    },
  }
  return { transport: counted, saves: () => saves }
}

const readSnapshot = (
  hub: ReturnType<typeof createMemoryHub>,
): SnapshotEnvelope<GameState> => {
  const payload = hub.inspect.snapshot(GROUP_ID)
  expect(payload).not.toBeNull()
  return JSON.parse(payload!) as SnapshotEnvelope<GameState>
}

/**
 * snapshot 保存 policy (ADR-0030)。host は最後に subscribe した端末 (a)。
 * dispatch は client (b) から行い、host の裁定ごとの保存回数を数える
 */
describe('snapshot policy (ADR-0030)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const arrange = async (
    options?: Parameters<typeof createClient>[1],
    hostListeners?: SynquxListener<GameState, GameAction>[],
  ) => {
    const hub = createMemoryHub()
    const b = createHubClient(hub)
    const counted = countingTransport(hub.createTransport())
    const a = createClient(counted.transport, {
      ...options,
      listeners: hostListeners,
    })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(10)
    return { hub, a, b, saves: counted.saves }
  }

  const dispatchIncrements = async (
    client: ReturnType<typeof createHubClient>,
    count: number,
  ) => {
    for (let index = 0; index < count; index += 1) {
      client.store.dispatch({ type: 'game/increment', payload: 1 })
      await settle(2)
    }
  }

  it('既定 (throttleMs 0) は裁定ごとに保存する', async () => {
    const { hub, b, saves } = await arrange()

    await dispatchIncrements(b, 3)

    expect(saves()).toBe(3)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(3)
    expect(readSnapshot(hub).synced.count).toBe(3)
  })

  it('throttleMs: 先頭は即時保存し、window 内の後続は最後の state だけを window 終了時に保存する', async () => {
    const { hub, b, saves } = await arrange({
      snapshot: { throttleMs: THROTTLE_MS },
    })

    await dispatchIncrements(b, 5)

    // 全端末の適用は間引きの影響を受けない (snapshot は復帰点にすぎない)
    expect(b.store.getState().game.count).toBe(5)
    expect(saves()).toBe(1)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(1)

    await vi.advanceTimersByTimeAsync(THROTTLE_MS)
    await settle(2)

    expect(saves()).toBe(2)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(5)
    expect(readSnapshot(hub).synced.count).toBe(5)
  })

  it('flushOn の action は間引き中でも即時保存する', async () => {
    const { hub, b, saves } = await arrange({
      snapshot: {
        throttleMs: THROTTLE_MS,
        flushOn: (action) => action.type === 'game/announce',
      },
    })

    await dispatchIncrements(b, 2)
    expect(saves()).toBe(1)

    b.store.dispatch({ type: 'game/announce' })
    await settle(2)

    expect(saves()).toBe(2)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(3)
  })

  it('unsubscribe は保留中の snapshot の書き込みを依頼してから切断する', async () => {
    const { hub, a, b, saves } = await arrange({
      snapshot: { throttleMs: THROTTLE_MS },
    })

    await dispatchIncrements(b, 3)
    expect(saves()).toBe(1)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(1)

    await a.sync.unsubscribe()

    expect(saves()).toBe(2)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(3)
    expect(readSnapshot(hub).synced.count).toBe(3)
  })

  it("trailing 保存の commit で watermark が進み、fire: 'persisted' の listener が発火する", async () => {
    const effect = vi.fn()
    const { b } = await arrange({ snapshot: { throttleMs: THROTTLE_MS } }, [
      {
        id: 'persisted-increment',
        mode: 'everyone',
        fire: 'persisted',
        match: (action) => action.type === 'game/increment',
        effect,
      },
    ])

    await dispatchIncrements(b, 2)
    // seq 1 は leading 保存で耐久化済み。seq 2 は保留中で未発火
    expect(effect).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(THROTTLE_MS)
    await settle(2)

    expect(effect).toHaveBeenCalledTimes(2)
  })

  it('throttleMs は [0, persisted drop 上限の半分) の有限数に限る', () => {
    const hub = createMemoryHub()

    expect(() =>
      createHubClient(hub, { snapshot: { throttleMs: -1 } }),
    ).toThrow(/snapshot\.throttleMs/)
    expect(() =>
      createHubClient(hub, { snapshot: { throttleMs: 15_000 } }),
    ).toThrow(/snapshot\.throttleMs/)
    expect(() =>
      createHubClient(hub, { snapshot: { throttleMs: Number.NaN } }),
    ).toThrow(/snapshot\.throttleMs/)
    expect(() =>
      createHubClient(hub, { snapshot: { throttleMs: 14_999 } }),
    ).not.toThrow()
  })
})
