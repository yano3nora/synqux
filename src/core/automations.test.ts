import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { synquxActions } from './slice.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SynquxAutomation } from './create-synqux.js'

const GROUP_ID = 'group-automations'
const START = new Date('2026-08-11T00:00:00.000Z').getTime()

const incrementOnce = (
  overrides?: Partial<SynquxAutomation<GameState, GameAction>>,
): SynquxAutomation<GameState, GameAction> => ({
  id: 'increment-once',
  retryMs: 100,
  when: (synced) => synced.count === 0,
  action: () => ({ type: 'game/increment-once' }),
  ...overrides,
})

describe('automations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('サーバ時刻が閾値を超えると発行し、適用後 when=false なら再発行しない', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const serverNow = vi.spyOn(transport, 'serverNow')
    const client = createClient(transport, {
      automations: [
        incrementOnce({
          when: (synced, { now }) => synced.count === 0 && now >= START + 1000,
        }),
      ],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(999)
    expect(client.store.getState().game.count).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await settle(20)
    expect(client.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    const callsBeforeIdle = serverNow.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    // tick は止まらず、各 evaluation path が serverNow を 1 回だけ読む。
    expect(serverNow.mock.calls.length).toBeGreaterThan(callsBeforeIdle)

    await unsubscribe()
    const callsAfterUnsubscribe = serverNow.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(serverNow).toHaveBeenCalledTimes(callsAfterUnsubscribe)
  })

  it('最初の request 配送が drop されても retryMs 後に再発行して適用する', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub, { automations: [incrementOnce()] })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(0)
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'added',
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    expect(client.store.getState().game.count).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    await settle(20)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)
    expect(client.store.getState().game.count).toBe(1)
  })

  it('非 host は発行せず、host migration 後の新 host が state だけから発行する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { automations: [incrementOnce()] })
    const b = createHubClient(hub, {
      automations: [incrementOnce()],
      canRequest: () => false,
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(5)

    expect(selectIsHost(a.store.getState())).toBe(false)
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(hub.inspect.requests(GROUP_ID)).toEqual([])

    hub.faults.disconnect('peer-2')
    await settle(10)

    expect(selectIsHost(a.store.getState())).toBe(true)
    expect(a.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    expect(hub.inspect.requests(GROUP_ID)[0]?.requestedBy).toBe('peer-1')
  })

  it('dual-host 相当の二重発行も rejects-repeat reducer により 1 回適用へ収束する', async () => {
    const hub = createMemoryHub()
    const automation = incrementOnce({ retryMs: 10_000 })
    const a = createHubClient(hub, { automations: [automation] })
    const b = createHubClient(hub, { automations: [automation] })
    const c = createHubClient(hub, { automations: [automation] })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    // b だけが c の presence を失った観測窓を作り、b/c が同時に host を自認する。
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(selectIsHost(c.store.getState())).toBe(true)

    await vi.advanceTimersByTimeAsync(9500)
    await settle(40)

    expect(hub.inspect.requests(GROUP_ID).length).toBeGreaterThanOrEqual(2)
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(1)
      expect(client.store.getState().game.log).toEqual(['increment-once'])
    }
  })

  it('standalone と runtime setEnabled(false) のどちらでも評価を続け local 適用する', async () => {
    const standaloneHub = createMemoryHub()
    const standaloneTransport = standaloneHub.createTransport()
    const standaloneServerNow = vi.spyOn(standaloneTransport, 'serverNow')
    const standalone = createClient(standaloneTransport, {
      enabled: false,
      automations: [incrementOnce()],
    })

    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone',
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(standalone.store.getState().game.count).toBe(1)
    expect(standaloneServerNow).not.toHaveBeenCalled()
    expect(standaloneHub.inspect.requests('standalone')).toEqual([])

    const syncedHub = createMemoryHub()
    const synced = createHubClient(syncedHub, {
      automations: [incrementOnce()],
    })
    await synced.sync.subscribe({
      store: synced.store,
      groupId: 'runtime-disabled',
    })
    await vi.advanceTimersByTimeAsync(0)
    synced.store.dispatch(synced.sync.actions.setEnabled(false))

    await vi.advanceTimersByTimeAsync(100)
    expect(synced.store.getState().game.count).toBe(1)
    expect(syncedHub.inspect.requests('runtime-disabled')).toEqual([])
  })

  it('when が throw する rule を記録して skip し、他 rule は動かし続ける', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const thrown = new Error('broken predicate')
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      automations: [
        incrementOnce({
          id: 'broken',
          when: () => {
            throw thrown
          },
        }),
        incrementOnce({ id: 'healthy' }),
      ],
    })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(100)
    await settle(20)

    expect(consoleError).toHaveBeenCalledWith(thrown)
    expect(client.store.getState().game.count).toBe(1)
  })

  it('automation id が重複していれば createSynqux が同期的に throw する', () => {
    const hub = createMemoryHub()

    expect(() =>
      createHubClient(hub, {
        automations: [incrementOnce(), incrementOnce()],
      }),
    ).toThrow('Duplicate SynquxAutomation id: increment-once')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'retryMs=%s は正の有限数でないため createSynqux が同期的に throw する',
    (retryMs) => {
      const hub = createMemoryHub()

      expect(() =>
        createHubClient(hub, {
          automations: [incrementOnce({ retryMs })],
        }),
      ).toThrow('SynquxAutomation retryMs must be a positive finite number')
    },
  )
})
