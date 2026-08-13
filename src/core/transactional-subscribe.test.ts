import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { buildSnapshotPayload } from './snapshot.js'
import { selectSyncPhase } from './selectors.js'
import {
  createClient,
  createHubClient,
  gameInitialState,
  settle,
} from './test-fixtures.js'
import type { SnapshotStore, SynquxTransport } from './types.js'

const GROUP_ID = 'transactional-subscribe'

type FailableMethod =
  | 'connect'
  | 'subscribePeers'
  | 'loadSnapshot'
  | 'subscribeRequests'

/** 指定した transport メソッドだけを初回に失敗させ、再試行は実装本体へ通す。 */
const failOnce = (
  transport: SynquxTransport,
  method: FailableMethod,
): SynquxTransport => {
  let shouldFail = true

  return new Proxy(transport, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)

      if (property !== method || typeof value !== 'function') {
        return value
      }

      return (...args: unknown[]) => {
        if (shouldFail) {
          shouldFail = false
          throw new Error(`Injected ${method} failure`)
        }

        return Reflect.apply(value, target, args)
      }
    },
  })
}

/** rollback 後に同じ instance/transport で再購読・通常同期できることを確認する。 */
const expectRetrySynchronizes = async (
  client: ReturnType<typeof createClient>,
): Promise<void> => {
  await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
  client.store.dispatch({ type: 'game/increment', payload: 1 })
  await settle()
  expect(client.store.getState().game.count).toBe(1)
}

describe('subscribe initialization transaction', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connect 失敗では state を変更せず、再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const client = createClient(failOnce(hub.createTransport(), 'connect'))
    const stateBefore = client.store.getState()

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected connect failure')
    expect(client.store.getState()).toEqual(stateBefore)

    await expectRetrySynchronizes(client)
  })

  it('idle → subscribing → live → idle の購読 lifecycle を公開する', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const connect = transport.connect.bind(transport)
    let releaseConnect!: () => void
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    transport.connect = async (options) => {
      await connectGate
      return connect(options)
    }
    const client = createClient(transport)

    expect(selectSyncPhase(client.store.getState())).toBe('idle')
    const subscribing = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    expect(selectSyncPhase(client.store.getState())).toBe('subscribing')

    releaseConnect()
    const unsubscribe = await subscribing
    expect(selectSyncPhase(client.store.getState())).toBe('live')

    await unsubscribe()
    expect(selectSyncPhase(client.store.getState())).toBe('idle')
  })

  it('connect reject 後は phase を idle へ戻す', async () => {
    const client = createClient(
      failOnce(createMemoryHub().createTransport(), 'connect'),
    )

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected connect failure')
    expect(selectSyncPhase(client.store.getState())).toBe('idle')
  })

  it('standalone も subscribe 完了後は live になる', async () => {
    const client = createHubClient(createMemoryHub(), { enabled: false })
    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    expect(selectSyncPhase(client.store.getState())).toBe('live')
    await unsubscribe()
    expect(selectSyncPhase(client.store.getState())).toBe('idle')
  })

  it('subscribePeers 失敗では presence を解除し、再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const baselineClient = createHubClient(hub)
    await baselineClient.sync.subscribe({
      store: baselineClient.store,
      groupId: GROUP_ID,
    })

    const client = createClient(
      failOnce(hub.createTransport(), 'subscribePeers'),
    )
    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected subscribePeers failure')
    await settle()

    expect(
      Object.keys(baselineClient.store.getState().synqux.connections.entities),
    ).toHaveLength(1)
    const probe = hub.createTransport()
    await probe.connect({ groupId: GROUP_ID })
    await settle()
    expect(client.store.getState().synqux.connections.entities).toEqual({})
    await probe.disconnect()
    await expectRetrySynchronizes(client)
  })

  it('loadSnapshot reject では peers/session/presence を戻し、再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const baselineClient = createHubClient(hub)
    await baselineClient.sync.subscribe({
      store: baselineClient.store,
      groupId: GROUP_ID,
    })

    const client = createClient(failOnce(hub.createTransport(), 'loadSnapshot'))
    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected loadSnapshot failure')
    await settle()

    expect(client.store.getState().synqux.connections.selfId).toBeNull()
    expect(client.store.getState().synqux.connections.entities).toEqual({})
    expect(
      Object.keys(baselineClient.store.getState().synqux.connections.entities),
    ).toHaveLength(1)
    const probe = hub.createTransport()
    await probe.connect({ groupId: GROUP_ID })
    await settle()
    expect(client.store.getState().synqux.connections.entities).toEqual({})
    await probe.disconnect()
    await expectRetrySynchronizes(client)
  })

  it('壊れた snapshot は peers/session/presence を戻し、再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const baselineClient = createHubClient(hub)
    await baselineClient.sync.subscribe({
      store: baselineClient.store,
      groupId: GROUP_ID,
    })

    const transport = hub.createTransport()
    const loadSnapshot = transport.loadSnapshot.bind(transport)
    let returnBrokenSnapshot = true
    transport.loadSnapshot = (key) => {
      if (returnBrokenSnapshot) {
        returnBrokenSnapshot = false
        return '{}'
      }
      return loadSnapshot(key)
    }
    const client = createClient(transport)

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Unsupported snapshot schema version')
    await settle()

    expect(client.store.getState().synqux.connections.selfId).toBeNull()
    expect(client.store.getState().synqux.connections.entities).toEqual({})
    expect(
      Object.keys(baselineClient.store.getState().synqux.connections.entities),
    ).toHaveLength(1)
    const probe = hub.createTransport()
    await probe.connect({ groupId: GROUP_ID })
    await settle()
    expect(client.store.getState().synqux.connections.entities).toEqual({})
    await probe.disconnect()
    await expectRetrySynchronizes(client)
  })

  it('subscribeRequests 失敗では購読を残さず、再 subscribe できる', async () => {
    const hub = createMemoryHub()
    const baselineClient = createHubClient(hub)
    await baselineClient.sync.subscribe({
      store: baselineClient.store,
      groupId: GROUP_ID,
    })

    const client = createClient(
      failOnce(hub.createTransport(), 'subscribeRequests'),
    )
    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected subscribeRequests failure')

    baselineClient.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()
    expect(client.store.getState().game.count).toBe(0)
    expect(client.store.getState().synqux.connections.selfId).toBeNull()

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()
    expect(client.store.getState().game.count).toBe(10)
  })

  it('standalone の loadSnapshot reject では session を解放して再 subscribe できる', async () => {
    let shouldFail = true
    const localSnapshots: SnapshotStore = {
      saveSnapshot: () => true,
      loadSnapshot: () => {
        if (shouldFail) {
          shouldFail = false
          throw new Error('Injected local loadSnapshot failure')
        }

        return buildSnapshotPayload({
          synced: { ...gameInitialState, count: 4 },
          ordering: { epoch: 0, appliedSeq: 0, applied: {} },
        })
      },
    }
    const client = createHubClient(createMemoryHub(), {
      enabled: false,
      localSnapshots,
    })

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected local loadSnapshot failure')
    expect(client.store.getState().synqux.connections.selfId).toBeNull()

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    expect(client.store.getState().game.count).toBe(4)
  })

  it('並行 subscribe は最初の await 前のガードで二重 connect を防ぐ', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const connect = transport.connect.bind(transport)
    let releaseConnect!: () => void
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    let connectCalls = 0
    transport.connect = async (options) => {
      connectCalls += 1
      await connectGate
      return connect(options)
    }
    const client = createClient(transport)

    const first = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    const second = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })

    await expect(second).rejects.toThrow('synqux is already subscribed')
    expect(connectCalls).toBe(1)
    releaseConnect()
    await first
  })

  it('rollback cleanup が失敗しても初期化時の元 error を維持する', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const transport = failOnce(hub.createTransport(), 'loadSnapshot')
    transport.disconnect = async () => {
      throw new Error('Injected disconnect failure')
    }
    const client = createClient(transport)

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow('Injected loadSnapshot failure')
    expect(client.store.getState().synqux.connections.selfId).toBeNull()
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Injected disconnect failure' }),
    )

    consoleError.mockRestore()
  })
})
