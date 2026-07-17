import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsSyncStalled, selectSyncHealth } from './selectors.js'
import { synquxActions } from './slice.js'
import { createHubClient, settle } from './test-fixtures.js'

const GROUP_ID = 'group-health'
const STALL_AFTER_MS = 5_000

describe('sync health', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('1 端末だけ response が欠落して後続 seq を観測すると回復を開始する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(10)

    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1_000)

    const health = selectSyncHealth(a.store.getState())
    expect(health).toMatchObject({
      phase: 'recovering',
      expectedSeq: 1,
      maxSeenSeq: 2,
    })
    expect(health.gapSince).not.toBeNull()
    expect(Date.now() - health.gapSince!).toBeGreaterThanOrEqual(STALL_AFTER_MS)
    expect(selectIsSyncStalled(a.store.getState())).toBe(true)
    expect(selectSyncHealth(b.store.getState()).phase).toBe('ok')
    expect(selectSyncHealth(c.store.getState()).phase).toBe('ok')
  })

  it('stallAfterMs 未満の遅配は stalled を通知せず、全端末が収束する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(10)

    let sawStalled = false
    a.store.subscribe(() => {
      sawStalled ||= selectIsSyncStalled(a.store.getState())
    })

    const delayed = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS - 2_000)
    delayed.release()
    await settle(20)

    expect(sawStalled).toBe(false)
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(11)
      expect(selectSyncHealth(client.store.getState()).phase).toBe('ok')
    }
  })

  it('stalled 後に欠落 response が遅着すると二重適用せず ok に戻る', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(10)

    const delayed = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1_000)
    expect(selectIsSyncStalled(a.store.getState())).toBe(true)

    delayed.release()
    await settle(20)

    expect(a.store.getState().game.count).toBe(11)
    expect(a.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(selectSyncHealth(a.store.getState())).toEqual({
      phase: 'ok',
      expectedSeq: null,
      maxSeenSeq: null,
      gapSince: null,
    })
  })

  it('dual-host 敗者を先に適用した端末は再裁定 seq を破棄して回復を開始する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(10)

    // b だけが c の presence を失った視界を作り、b/c の dual-host 窓にする。
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))

    // request 1 は b だけに裁定させ、a は敗者となる action を seq 1 で早期適用。
    // c への added/changed は後でまとめて解放し、正史確定後の敗者救済に回す。
    const delayedLoserToCanonicalHost = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-3',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(a.store.getState().game.log).toEqual(['increment:1'])
    expect(c.store.getState().game.log).toEqual([])

    // request 2 は c だけに同じ seq 1 で裁定させる。a への勝者配送を遅らせ、
    // b は裁定にも正史適用にも参加させない。
    hub.faults.drop({
      requestId: '000000000002',
      to: 'peer-2',
      event: 'added',
    })
    hub.faults.drop({
      requestId: '000000000002',
      to: 'peer-2',
      event: 'changed',
    })
    const delayedWinnerToA = hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-1',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    expect(c.store.getState().game.log).toEqual(['increment:10'])

    // a は勝者を seq 1 stale として適用できず、敗者の表示のままになる。
    delayedWinnerToA.release()
    await settle(5)
    expect(a.store.getState().game.log).toEqual(['increment:1'])

    // c が遅着した敗者を seq 2 で再裁定する。a は同じ request id を適用済み
    // とみなして破棄するため appliedSeq=1 のまま maxSeenSeq=2 だけが進む。
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'changed',
    })
    delayedLoserToCanonicalHost.release()
    await settle(20)

    expect(c.store.getState().game.log).toEqual(['increment:10', 'increment:1'])
    expect(a.store.getState().game.log).toEqual(['increment:1'])

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1_000)
    expect(selectSyncHealth(a.store.getState())).toMatchObject({
      phase: 'recovering',
      expectedSeq: 2,
      maxSeenSeq: 2,
    })
  })

  it('unsubscribe で heartbeat を止め、standalone では起動しない', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const unsubscribe = await a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
    })

    const dispatch = vi.spyOn(a.store, 'dispatch')
    await unsubscribe()
    dispatch.mockClear()
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 2_000)
    expect(dispatch).not.toHaveBeenCalled()

    const timersBeforeStandalone = vi.getTimerCount()
    const standalone = createHubClient(hub, {
      enabled: false,
      stallAfterMs: STALL_AFTER_MS,
    })
    const unsubscribeStandalone = await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone-health',
    })
    expect(vi.getTimerCount()).toBe(timersBeforeStandalone)
    expect(selectIsSyncStalled(standalone.store.getState())).toBe(false)
    await unsubscribeStandalone()
  })
})
