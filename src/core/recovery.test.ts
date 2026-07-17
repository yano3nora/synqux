import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectSyncHealth } from './selectors.js'
import { synquxActions } from './slice.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'
import type { SynquxTransport } from './types.js'

const GROUP_ID = 'group-recovery'
const STALL_AFTER_MS = 5_000

const advanceToResubscribe = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 2_000)
}

const advanceToRestore = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1_000)
}

const createTrackedClient = (
  hub: ReturnType<typeof createMemoryHub>,
  overrides?: Partial<SynquxTransport>,
) => {
  const transport = hub.createTransport()
  Object.assign(transport, overrides)
  const loadSnapshot = vi.spyOn(transport, 'loadSnapshot')
  return {
    ...createClient(transport, { stallAfterMs: STALL_AFTER_MS }),
    transport,
    loadSnapshot,
  }
}

const arrangeMissingFirstResponse = async () => {
  const hub = createMemoryHub()
  const a = createTrackedClient(hub)
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

  return { hub, a, b, c }
}

const arrangeDualHostEarlyApply = async () => {
  const hub = createMemoryHub()
  const a = createTrackedClient(hub)
  const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
  const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })

  await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
  await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
  await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
  await settle(10)

  b.store.dispatch(synquxActions.peerRemoved('peer-3'))
  const delayedLoserToCanonicalHost = hub.faults.delay({
    requestId: '000000000001',
    to: 'peer-3',
  })
  a.store.dispatch({ type: 'game/increment', payload: 1 })
  await settle(10)

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
  delayedWinnerToA.release()
  await settle(5)

  hub.faults.drop({
    requestId: '000000000001',
    to: 'peer-2',
    event: 'changed',
  })
  delayedLoserToCanonicalHost.release()
  await settle(20)

  expect(a.store.getState().game.log).toEqual(['increment:1'])
  expect(c.store.getState().game.log).toEqual(['increment:10', 'increment:1'])
  return { hub, a, b, c }
}

describe('sync auto recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('欠落した response を再購読で取り直し、二重適用せず収束する', async () => {
    const { a, b, c } = await arrangeMissingFirstResponse()

    await advanceToResubscribe()
    await settle(20)

    for (const client of [a, b, c]) {
      expect(client.store.getState().game.log).toEqual([
        'increment:1',
        'increment:10',
      ])
      expect(selectSyncHealth(client.store.getState()).phase).toBe('ok')
    }
    // subscribe 開始時の 1 回だけで、回復段階 (b) には進んでいない。
    expect(a.loadSnapshot).toHaveBeenCalledTimes(1)
  })

  it('dual-host 早期適用は再購読では治らず、snapshot restore で正史へ収束する', async () => {
    const { a, c } = await arrangeDualHostEarlyApply()

    await advanceToResubscribe()
    await settle(10)
    expect(a.store.getState().game.log).toEqual(['increment:1'])

    await advanceToRestore()
    await settle(10)

    expect(a.store.getState().game.log).toEqual(c.store.getState().game.log)
    expect(a.store.getState().game.log).toEqual(['increment:10', 'increment:1'])
    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')
    expect(a.loadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('回復中の重複・順序入れ替えでも各 request を高々 1 回だけ適用する', async () => {
    const { hub, a, b, c } = await arrangeMissingFirstResponse()
    hub.faults.duplicate({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'added',
    })
    const delayedReplay = hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-1',
      event: 'added',
    })

    await advanceToResubscribe()
    await settle(10)
    delayedReplay.release()
    await settle(20)

    for (const client of [a, b, c]) {
      expect(client.store.getState().game.log).toEqual([
        'increment:1',
        'increment:10',
      ])
    }
  })

  it('自端末以下の snapshot を受理せず synced state を巻き戻さない', async () => {
    const hub = createMemoryHub()
    let staleSnapshot: string | null = null
    let loadCount = 0
    const a = createTrackedClient(hub, {
      async loadSnapshot() {
        loadCount += 1
        return loadCount === 1 ? null : staleSnapshot
      },
    })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(10)

    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    staleSnapshot = hub.inspect.snapshot(GROUP_ID)

    hub.faults.drop({
      requestId: '000000000002',
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(10)
    hub.faults.drop({ requestId: '000000000002', to: 'peer-1', event: 'added' })

    await advanceToResubscribe()
    await settle(10)
    await advanceToRestore()
    await settle(10)

    expect(a.store.getState().game.log).toEqual(['increment:1'])
    expect(a.store.getState().game.count).toBe(1)
    expect(a.loadSnapshot).toHaveBeenCalledTimes(2)
  })

  it('stall 端末が host に昇格した群停止を restore 後に解除する', async () => {
    const { hub, a } = await arrangeDualHostEarlyApply()
    hub.faults.disconnect('peer-2')
    hub.faults.disconnect('peer-3')
    await settle(10)

    a.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(20)
    expect(hub.inspect.requests(GROUP_ID)[2]?.responsedBy).toBeUndefined()

    await advanceToResubscribe()
    await settle(10)
    await advanceToRestore()
    await settle(30)

    expect(a.store.getState().game.log).toEqual([
      'increment:10',
      'increment:1',
      'increment:100',
    ])
    expect(hub.inspect.requests(GROUP_ID)[2]?.responsedBy).toBe('peer-1')
    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')
  })

  it('1 巡で unrecoverable になり、遅着で ok に戻っても retry loop しない', async () => {
    const hub = createMemoryHub()
    let loadCount = 0
    const a = createTrackedClient(hub, {
      async loadSnapshot() {
        loadCount += 1
        return null
      },
    })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(10)

    const delayedChanged = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    const delayedReplay = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'added',
    })

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS * 3 + 4_000)
    expect(selectSyncHealth(a.store.getState()).phase).toBe('unrecoverable')
    expect(a.loadSnapshot).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS * 2)
    expect(a.loadSnapshot).toHaveBeenCalledTimes(2)

    delayedChanged.release()
    delayedReplay.release()
    await settle(20)
    expect(a.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(selectSyncHealth(a.store.getState()).phase).toBe('ok')
  })

  it.each(['resubscribed', 'restoring'] as const)(
    '%s 中の unsubscribe で timer・購読・restore dispatch を残さない',
    async (point) => {
      const hub = createMemoryHub()
      const transport = hub.createTransport()
      let activeSubscriptions = 0
      const subscribeRequests = transport.subscribeRequests.bind(transport)
      transport.subscribeRequests = (options, handlers) => {
        activeSubscriptions += 1
        const unsubscribe = subscribeRequests(options, handlers)
        return () => {
          activeSubscriptions -= 1
          unsubscribe()
        }
      }

      const recoveryLoad: {
        resolve?: (payload: string | null) => void
      } = {}
      let loadCount = 0
      const loadSnapshot = transport.loadSnapshot.bind(transport)
      transport.loadSnapshot = async (key) => {
        loadCount += 1
        if (point === 'restoring' && loadCount === 2) {
          return new Promise((resolve) => {
            recoveryLoad.resolve = resolve
          })
        }
        return loadSnapshot(key)
      }

      const a = createClient(transport, { stallAfterMs: STALL_AFTER_MS })
      const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
      const unsubscribe = await a.sync.subscribe({
        store: a.store,
        groupId: GROUP_ID,
      })
      await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
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
      hub.faults.drop({
        requestId: '000000000001',
        to: 'peer-1',
        event: 'added',
      })

      await advanceToResubscribe()
      if (point === 'restoring') {
        await advanceToRestore()
      }

      const dispatch = vi.spyOn(a.store, 'dispatch')
      await unsubscribe()
      dispatch.mockClear()
      recoveryLoad.resolve?.(hub.inspect.snapshot(GROUP_ID))
      await vi.advanceTimersByTimeAsync(STALL_AFTER_MS * 2)

      expect(activeSubscriptions).toBe(0)
      expect(dispatch).not.toHaveBeenCalled()
    },
  )
})
