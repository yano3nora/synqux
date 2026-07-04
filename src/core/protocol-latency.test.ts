import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { createHubClient } from './test-fixtures.js'

/**
 * プロトコルレイテンシの baseline 計測 (Phase 3 / SPEC 改善ロードマップ 4)
 *
 * fake timers 上の「simulation 時間」で、dispatch から全端末収束までの時間を測る。
 * 現行実装は prev チェーン待機・host 昇格監視が 100ms / 1000ms のポーリングで、
 * このコストがプロトコル時間として直接現れる。イベント駆動化 (Phase 3) の
 * 前後比較のため、上限 assert を回帰ガードとして固定する
 *
 * NOTE 上限値は「現行実装で観測した値 + 余裕」。イベント駆動化で大幅に縮む想定で、
 * そのときはこの上限を新実装の観測値に合わせて締め直すこと
 */

const GROUP_ID = 'group-latency'
const STEP_MS = 10
const TIMEOUT_MS = 60_000

/** predicate が真になるまで simulation 時間を進め、経過 ms を返す */
const measureUntil = async (predicate: () => boolean): Promise<number> => {
  let elapsed = 0

  while (!predicate()) {
    if (elapsed >= TIMEOUT_MS) {
      throw new Error(
        `did not converge within ${String(TIMEOUT_MS)}ms (simulated)`,
      )
    }

    await vi.advanceTimersByTimeAsync(STEP_MS)
    elapsed += STEP_MS
  }

  return elapsed
}

describe('protocol latency baseline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('単発 request: host 端末自身の dispatch は 1 tick 以内に適用される', async () => {
    const hub = createMemoryHub()
    const host = createHubClient(hub)
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(100)

    host.store.dispatch({ type: 'game/increment', payload: 1 })
    const elapsed = await measureUntil(
      () => host.store.getState().game.count === 1,
    )

    console.log(`[baseline] single request (self=host): ${String(elapsed)}ms`)
    expect(elapsed).toBeLessThanOrEqual(200)
  })

  it('直列 burst: 非 host 端末からの連続 20 requests の全端末収束', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub) // 最新接続 = host
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(200)

    const COUNT = 20
    for (let i = 0; i < COUNT; i += 1) {
      a.store.dispatch({ type: 'game/increment', payload: 1 })
    }

    const elapsed = await measureUntil(
      () =>
        a.store.getState().game.count === COUNT &&
        b.store.getState().game.count === COUNT,
    )

    console.log(
      `[baseline] serial burst ${String(COUNT)} requests: ${String(elapsed)}ms total, ${String(elapsed / COUNT)}ms/req`,
    )
    // prev チェーン直列処理 × 100ms ポーリングの積み上がり。現行の観測値 + 余裕
    expect(elapsed).toBeLessThanOrEqual(COUNT * 300)
  })

  it('交錯 dispatch: 3 端末 × 10 requests の全端末収束', async () => {
    const hub = createMemoryHub()
    const clients = [
      createHubClient(hub),
      createHubClient(hub),
      createHubClient(hub),
    ]
    for (const client of clients) {
      await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    }
    await vi.advanceTimersByTimeAsync(200)

    const PER_CLIENT = 10
    const TOTAL = PER_CLIENT * clients.length
    for (let i = 0; i < PER_CLIENT; i += 1) {
      for (const client of clients) {
        client.store.dispatch({ type: 'game/increment', payload: 1 })
      }
    }

    const elapsed = await measureUntil(() =>
      clients.every((c) => c.store.getState().game.count === TOTAL),
    )

    const logs = clients.map((c) => c.store.getState().game.log)
    expect(logs[1]).toEqual(logs[0])
    expect(logs[2]).toEqual(logs[0])

    console.log(
      `[baseline] interleaved ${String(TOTAL)} requests (3 clients): ${String(elapsed)}ms total, ${String(elapsed / TOTAL)}ms/req`,
    )
    expect(elapsed).toBeLessThanOrEqual(TOTAL * 300)
  })

  it('host migration 回復: host 離脱から滞留 request の適用まで', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub) // host
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(200)

    // host (b) に届かない request を作って滞留させる
    hub.faults.drop({ requestId: '000000000001', to: 'peer-2', event: 'added' })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await vi.advanceTimersByTimeAsync(500)
    expect(a.store.getState().game.count).toBe(0)

    // 離脱 → a の昇格検知 (1000ms ポーリング) → 滞留 request の処理
    hub.faults.disconnect('peer-2')
    const elapsed = await measureUntil(
      () =>
        selectIsHost(a.store.getState()) && a.store.getState().game.count === 1,
    )

    console.log(`[baseline] host migration recovery: ${String(elapsed)}ms`)
    // 支配項は host 昇格監視の 1000ms sleep。現行の観測値 + 余裕
    expect(elapsed).toBeLessThanOrEqual(2500)
  })
})
