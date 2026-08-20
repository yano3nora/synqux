import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'

const GROUP_ID = 'group-dispatch-and-wait'

describe('dispatchAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('host の success 裁定を自端末で適用した後に resolve する', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    let resolved = false
    const resultPromise = client.sync
      .dispatchAndWait({ type: 'game/increment', payload: 2 })
      .then((result) => {
        resolved = true
        return result
      })
    expect(resolved).toBe(false)

    await settle()
    const result = await resultPromise
    expect(result.type).toBe('success')
    expect(client.store.getState().game.count).toBe(2)
    expect(result.action.meta?.hash).toBeTruthy()
  })

  it('同一 hash の待機中再発行は明示的に reject する (再 dispatch 禁止の検出)', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    // createSyncedAction 相当: 生成時に hash が焼かれた action を 2 回渡す誤用
    const action = {
      type: 'game/increment' as const,
      payload: 1,
      meta: { hash: '01HSAMEHASH000000000000000', dispatched: 1_000 },
    }
    const first = client.sync.dispatchAndWait(action)
    const duplicated = client.sync.dispatchAndWait(action)

    await expect(duplicated).rejects.toThrow('already pending for hash')

    // 先発は上書きされず正常に resolve する
    await settle()
    await expect(first).resolves.toMatchObject({ type: 'success' })
  })

  it('message あり error result も reject せず resolve する', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    const resultPromise = client.sync.dispatchAndWait({
      type: 'game/message-forbidden',
    })
    await settle()

    await expect(resultPromise).resolves.toMatchObject({
      type: 'error',
      message: { text: 'forbidden' },
    })
  })

  it('dispatch を省略する log 専用 error result でも resolve する', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    const resultPromise = client.sync.dispatchAndWait({
      type: 'game/forbidden',
    })
    await settle()

    await expect(resultPromise).resolves.toMatchObject({
      type: 'error',
      log: 'forbidden',
    })
    expect(client.store.getState().game.result).toBeNull()
  })

  it('裁定配送が delay されている間は待機し、release 後に resolve する', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    const delayed = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })

    let resolved = false
    const resultPromise = client.sync
      .dispatchAndWait({ type: 'game/increment' })
      .then((result) => {
        resolved = true
        return result
      })
    await settle(10)
    expect(resolved).toBe(false)

    delayed.release()
    await settle()
    await expect(resultPromise).resolves.toMatchObject({ type: 'success' })
  })

  it('signal abort と unsubscribe は pending を reject する', async () => {
    const hub = createMemoryHub()
    const aborting = createHubClient(hub)
    const unsubscribeAborting = await aborting.sync.subscribe({
      store: aborting.store,
      groupId: 'abort',
    })
    const delayedAbort = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    const controller = new AbortController()
    const aborted = aborting.sync.dispatchAndWait(
      { type: 'game/increment' },
      { signal: controller.signal },
    )
    await settle(5)
    controller.abort(new Error('consumer aborted'))
    await expect(aborted).rejects.toThrow('consumer aborted')
    delayedAbort.release()
    await settle()
    await unsubscribeAborting()

    const unsubscribing = createHubClient(hub)
    const unsubscribe = await unsubscribing.sync.subscribe({
      store: unsubscribing.store,
      groupId: 'unsubscribe',
    })
    hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-2',
      event: 'changed',
    })
    const pending = unsubscribing.sync.dispatchAndWait({
      type: 'game/increment',
    })
    await settle(5)
    await unsubscribe()

    await expect(pending).rejects.toThrow(
      'synqux was unsubscribed before dispatch completed',
    )
  })

  it('instance / session 指定の standalone は local 適用結果で即 resolve する', async () => {
    const standaloneHub = createMemoryHub()
    const standalone = createClient(standaloneHub.createTransport(), {
      mode: 'standalone',
    })
    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone',
    })

    await expect(
      standalone.sync.dispatchAndWait({ type: 'game/increment' }),
    ).resolves.toMatchObject({ type: 'success' })
    expect(standalone.store.getState().game.count).toBe(1)
    expect(standaloneHub.inspect.requests('standalone')).toEqual([])

    const sessionHub = createMemoryHub()
    const sessionStandalone = createHubClient(sessionHub)
    await sessionStandalone.sync.subscribe({
      store: sessionStandalone.store,
      groupId: 'session-standalone',
      mode: 'standalone',
    })
    await expect(
      sessionStandalone.sync.dispatchAndWait({ type: 'game/increment' }),
    ).resolves.toMatchObject({ type: 'success' })
    expect(sessionHub.inspect.requests('session-standalone')).toEqual([])
  })

  it('未 subscribe は throw、非 synced action と canRequest=false は即 reject する', async () => {
    const hub = createMemoryHub()
    const unsubscribed = createHubClient(hub)
    expect(() =>
      unsubscribed.sync.dispatchAndWait({ type: 'game/increment' }),
    ).toThrow('synqux is not subscribed')

    const client = createHubClient(hub, { canRequest: () => false })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    await expect(
      client.sync.dispatchAndWait({ type: 'local/action' } as never),
    ).rejects.toThrow('requires a synced action')
    await expect(
      client.sync.dispatchAndWait({ type: 'game/increment' }),
    ).rejects.toThrow('canRequest is false')
    expect(hub.inspect.requests(GROUP_ID)).toEqual([])
  })
})
