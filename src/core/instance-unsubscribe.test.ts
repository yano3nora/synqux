import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  createClient,
  createHubClient,
  settle,
  subscribeSettled,
} from './test-fixtures.js'
import type { SynquxTransport } from './types.js'

const GROUP_ID = 'group-instance-unsubscribe'

const createObservedTransport = (options?: {
  requestCleanupFailureOnce?: Error
}) => {
  const hub = createMemoryHub()
  const base = hub.createTransport()
  const unsubscribePeers = vi.fn()
  const unsubscribeRequests = vi.fn()
  let requestCleanupFailure = options?.requestCleanupFailureOnce

  const transport: SynquxTransport = {
    ...base,
    disconnect: vi.fn(() => base.disconnect()),
    subscribePeers: vi.fn((handlers) => {
      const unsubscribe = base.subscribePeers(handlers)
      return () => {
        unsubscribePeers()
        unsubscribe()
      }
    }),
    subscribeRequests: vi.fn((options, handlers) => {
      const unsubscribe = base.subscribeRequests(options, handlers)
      return () => {
        unsubscribeRequests()
        unsubscribe()
        if (requestCleanupFailure) {
          const error = requestCleanupFailure
          requestCleanupFailure = undefined
          throw error
        }
      }
    }),
  }

  return {
    hub,
    transport,
    disconnect: vi.mocked(transport.disconnect),
    subscribeRequests: vi.mocked(transport.subscribeRequests),
    unsubscribePeers,
    unsubscribeRequests,
  }
}

/** disconnect に手動 gate を置き、session=null 後の teardown 窓を決定的に作る。 */
const createPendingDisconnectTransport = () => {
  const hub = createMemoryHub()
  const base = hub.createTransport()
  let notifyDisconnectStarted!: () => void
  let releaseDisconnect!: () => void
  const disconnectStarted = new Promise<void>((resolve) => {
    notifyDisconnectStarted = resolve
  })
  const disconnectGate = new Promise<void>((resolve) => {
    releaseDisconnect = resolve
  })

  const transport: SynquxTransport = {
    ...base,
    connect: vi.fn((options) => base.connect(options)),
    disconnect: vi.fn(async () => {
      notifyDisconnectStarted()
      await disconnectGate
      await base.disconnect()
    }),
  }

  return {
    hub,
    transport,
    connect: vi.mocked(transport.connect),
    disconnect: vi.mocked(transport.disconnect),
    disconnectStarted,
    releaseDisconnect,
  }
}

describe('instance unsubscribe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('instance method で presence・transport 購読を破棄し phase を idle へ戻す', async () => {
    const observed = createObservedTransport()
    const client = createClient(observed.transport)

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    expect(client.store.getState().synqux.phase).toBe('live')
    expect(observed.hub.inspect.peers(GROUP_ID)).toHaveLength(1)

    await client.sync.unsubscribe()

    expect(observed.disconnect).toHaveBeenCalledOnce()
    expect(observed.unsubscribePeers).toHaveBeenCalledOnce()
    expect(observed.unsubscribeRequests).toHaveBeenCalledOnce()
    expect(observed.hub.inspect.peers(GROUP_ID)).toEqual([])
    expect(client.store.getState().synqux.phase).toBe('idle')

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(observed.hub.inspect.requests(GROUP_ID)).toEqual([])
  })

  it('未 subscribe の unsubscribe は no-op で resolve する', async () => {
    const client = createHubClient(createMemoryHub())

    await expect(client.sync.unsubscribe()).resolves.toBeUndefined()
    expect(client.store.getState().synqux.phase).toBe('idle')
  })

  it('subscribe 初期化中の unsubscribe は signal による中断を案内して reject する', async () => {
    const hub = createMemoryHub()
    const base = hub.createTransport()
    let releaseConnect!: () => void
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    const transport: SynquxTransport = {
      ...base,
      async connect(options) {
        await connectGate
        return base.connect(options)
      },
    }
    const client = createClient(transport)

    const subscribing = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    await expect(client.sync.unsubscribe()).rejects.toThrow(
      /subscribe options signal/i,
    )

    releaseConnect()
    const unsubscribe = await subscribing
    await unsubscribe()
  })

  it('並行 unsubscribe は同じ teardown Promise を共有して cleanup を一度だけ行う', async () => {
    const observed = createObservedTransport()
    const client = createClient(observed.transport)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    const first = client.sync.unsubscribe()
    const second = client.sync.unsubscribe()

    expect(first).toBe(second)
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
    expect(observed.disconnect).toHaveBeenCalledOnce()
    expect(observed.unsubscribePeers).toHaveBeenCalledOnce()
    expect(observed.unsubscribeRequests).toHaveBeenCalledOnce()
  })

  it('重複・stale closure は no-op となり、新しい session を破棄しない', async () => {
    const observed = createObservedTransport()
    const client = createClient(observed.transport)
    const oldUnsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    const firstTeardown = oldUnsubscribe()
    await firstTeardown
    expect(oldUnsubscribe()).toBe(firstTeardown)
    await oldUnsubscribe()
    expect(observed.disconnect).toHaveBeenCalledOnce()
    expect(observed.unsubscribeRequests).toHaveBeenCalledOnce()

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await oldUnsubscribe()

    expect(observed.hub.inspect.peers(GROUP_ID)).toHaveLength(1)
    expect(observed.subscribeRequests).toHaveBeenCalledTimes(2)
    expect(observed.unsubscribeRequests).toHaveBeenCalledOnce()
    expect(client.store.getState().synqux.phase).toBe('live')

    client.store.dispatch({ type: 'game/increment', payload: 2 })
    await settle()
    expect(observed.hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    await client.sync.unsubscribe()
  })

  it('instance method だけで synced → tutorial → synced の正史復帰を完走する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()
    expect(a.store.getState().game.count).toBe(10)

    await a.sync.unsubscribe()
    await a.sync.subscribe({
      store: a.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })
    a.store.dispatch({ type: 'game/increment', payload: 5 })
    expect(a.store.getState().game.count).toBe(15)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    await a.sync.unsubscribe()
    await subscribeSettled(a, { groupId: GROUP_ID })
    await settle()

    expect(a.store.getState().game.count).toBe(10)
    expect(a.store.getState().game.log).toEqual(['increment:10'])

    await a.sync.unsubscribe()
    await b.sync.unsubscribe()
  })

  it('session 終了後も進行中の unsubscribe は同じ teardown の完了を待つ', async () => {
    const controlled = createPendingDisconnectTransport()
    const client = createClient(controlled.transport)
    const closure = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    const teardown = closure()
    await controlled.disconnectStarted
    const instanceTeardown = client.sync.unsubscribe()
    let settled = false
    void instanceTeardown.then(() => {
      settled = true
    })

    expect(instanceTeardown).toBe(teardown)
    await Promise.resolve()
    expect(settled).toBe(false)

    controlled.releaseDisconnect()
    await expect(Promise.all([teardown, instanceTeardown])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })

  it('session 終了後も teardown 進行中の subscribe を拒否する', async () => {
    const controlled = createPendingDisconnectTransport()
    const client = createClient(controlled.transport)
    const closure = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    const teardown = closure()
    await controlled.disconnectStarted

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow(/await unsubscribe completion/i)
    expect(controlled.connect).toHaveBeenCalledOnce()

    controlled.releaseDisconnect()
    await teardown
  })

  it('返り値 closure と instance method の同期呼び出しも cleanup を一度だけ行う', async () => {
    const observed = createObservedTransport()
    const client = createClient(observed.transport)
    const closure = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    const closureTeardown = closure()
    const instanceTeardown = client.sync.unsubscribe()

    expect(instanceTeardown).toBe(closureTeardown)
    await expect(
      Promise.all([closureTeardown, instanceTeardown]),
    ).resolves.toEqual([undefined, undefined])
    expect(observed.disconnect).toHaveBeenCalledOnce()
    expect(observed.unsubscribePeers).toHaveBeenCalledOnce()
    expect(observed.unsubscribeRequests).toHaveBeenCalledOnce()
  })

  it('cleanup 失敗を共有しつつ残りを完遂し、再 subscribe 可能にする', async () => {
    const cleanupError = new Error('request cleanup failed')
    const observed = createObservedTransport({
      requestCleanupFailureOnce: cleanupError,
    })
    const client = createClient(observed.transport)
    const closure = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const closureTeardown = closure()
    const instanceTeardown = client.sync.unsubscribe()

    expect(instanceTeardown).toBe(closureTeardown)
    await expect(closureTeardown).rejects.toBe(cleanupError)
    await expect(instanceTeardown).rejects.toBe(cleanupError)
    expect(consoleError).toHaveBeenCalledWith(cleanupError)
    expect(observed.disconnect).toHaveBeenCalledOnce()
    expect(observed.unsubscribePeers).toHaveBeenCalledOnce()
    expect(client.store.getState().synqux.phase).toBe('idle')
    expect(observed.hub.inspect.peers(GROUP_ID)).toEqual([])

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).resolves.toBeTypeOf('function')
    expect(client.store.getState().synqux.phase).toBe('live')
    await client.sync.unsubscribe()

    consoleError.mockRestore()
  })
})
