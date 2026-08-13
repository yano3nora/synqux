import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  selectIsSyncUnrecoverable,
  selectSelfId,
  selectSyncHealth,
} from './selectors.js'
import { createHubClient, settle } from './test-fixtures.js'

/**
 * transport 失敗系の simulation (ADR-0012)
 * - 購読の回復不能な打ち切り (permission denied 相当) → unrecoverable health
 * - subscribe の AbortSignal 中断 → presence を残さず rollback
 */

const GROUP_ID = 'group-a'

describe('transport 購読の打ち切り (契約 8)', () => {
  let consoleErrorSpy: MockInstance

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
    consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('購読を打ち切られた端末は unrecoverable になり、heartbeat で ok へ巻き戻されない', async () => {
    const hub = createMemoryHub()
    const onUnrecoverable = vi.fn()
    const a = createHubClient(hub, { onUnrecoverable })
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')

    hub.faults.cancelSubscriptions(selectSelfId(a.store.getState())!)
    await settle()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(selectIsSyncUnrecoverable(a.store.getState())).toBe(true)
    expect(onUnrecoverable).toHaveBeenCalledTimes(1)

    // gap なし (maxSeen <= applied) でも health heartbeat が ok へ戻さないこと
    await settle(30)
    expect(selectIsSyncUnrecoverable(a.store.getState())).toBe(true)
    expect(onUnrecoverable).toHaveBeenCalledTimes(1)

    // 健全な端末は影響を受けず、同期を継続できる
    expect(selectSyncHealth(b.store.getState()).phase).toBe('ok')
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(b.store.getState().game.count).toBe(1)
  })

  it('打ち切り後、unsubscribe → 再 subscribe で回復できる', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)

    const unsubscribe = await a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
    })
    await settle()

    hub.faults.cancelSubscriptions(selectSelfId(a.store.getState())!)
    await settle()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(selectIsSyncUnrecoverable(a.store.getState())).toBe(true)

    await unsubscribe()
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle()

    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(a.store.getState().game.count).toBe(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })
})

describe('subscribe の AbortSignal 中断', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
    // abort による subscribe 失敗で onSubscribeFailed 未設定の警告
    // (仕様通りの出力) がテストの stderr に漏れないよう握りつぶす
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('abort 済み signal での subscribe は即座に reject され、presence を残さない', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const controller = new AbortController()
    controller.abort(new Error('boot cancelled'))

    await expect(
      a.sync.subscribe({
        store: a.store,
        groupId: GROUP_ID,
        signal: controller.signal,
      }),
    ).rejects.toThrow('boot cancelled')

    expect(hub.inspect.peers(GROUP_ID)).toHaveLength(0)
  })

  it('初期化中の abort は rollback され、同じ instance で再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const controller = new AbortController()

    const pending = a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
      signal: controller.signal,
    })
    // connect の同期完了後・初期化の await 中に abort する
    controller.abort(new Error('boot cancelled'))

    await expect(pending).rejects.toThrow('boot cancelled')
    await settle()
    expect(hub.inspect.peers(GROUP_ID)).toHaveLength(0)
    expect(selectSelfId(a.store.getState())).toBeNull()

    // rollback 済みなので signal なしで subscribe し直せる
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle()
    expect(hub.inspect.peers(GROUP_ID)).toHaveLength(1)
  })
})
