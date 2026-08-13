import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { synquxActions, type PendingRequest } from './slice.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SynquxListener } from './create-synqux.js'
import type { Result } from './types.js'

const GROUP_ID = 'group-listeners'

const incrementListener = (
  id: string,
  mode: SynquxListener<GameState, GameAction>['mode'],
  effect: SynquxListener<GameState, GameAction>['effect'],
): SynquxListener<GameState, GameAction> => ({
  id,
  mode,
  match: (action) => action.type === 'game/increment',
  effect,
})

describe('listeners', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-13T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('host-only は host だけで 1 回発火する', async () => {
    const hub = createMemoryHub()
    const aEffect = vi.fn()
    const bEffect = vi.fn()
    const a = createHubClient(hub, {
      listeners: [incrementListener('notify', 'host-only', aEffect)],
    })
    const b = createHubClient(hub, {
      listeners: [incrementListener('notify', 'host-only', bEffect)],
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(5)
    expect(selectIsHost(a.store.getState())).toBe(false)
    expect(selectIsHost(b.store.getState())).toBe(true)

    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(aEffect).not.toHaveBeenCalled()
    expect(bEffect).toHaveBeenCalledTimes(1)
    expect(bEffect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'game/increment' }),
      { synced: b.store.getState().game },
    )
  })

  it('everyone は action を適用した全端末でそれぞれ 1 回発火する', async () => {
    const hub = createMemoryHub()
    const aEffect = vi.fn()
    const bEffect = vi.fn()
    const a = createHubClient(hub, {
      listeners: [incrementListener('render', 'everyone', aEffect)],
    })
    const b = createHubClient(hub, {
      listeners: [incrementListener('render', 'everyone', bEffect)],
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(aEffect).toHaveBeenCalledTimes(1)
    expect(bEffect).toHaveBeenCalledTimes(1)
  })

  it('restore replay では両 mode とも発火せず、live 配信から発火する', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    // snapshot 書き込みを保留し、後発端末が残存 envelope から復帰する状況を作る。
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    const hostOnly = vi.fn()
    const everyone = vi.fn()
    const replayTransport = hub.createTransport()
    const loadSnapshot = replayTransport.loadSnapshot.bind(replayTransport)
    let notifyLoadStarted!: () => void
    let releaseLoad!: () => void
    const loadStarted = new Promise<void>((resolve) => {
      notifyLoadStarted = resolve
    })
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    replayTransport.loadSnapshot = async (key) => {
      notifyLoadStarted()
      await loadGate
      return loadSnapshot(key)
    }
    const late = createClient(replayTransport, {
      listeners: [
        incrementListener('notify', 'host-only', hostOnly),
        incrementListener('render', 'everyone', everyone),
      ],
    })
    const subscribing = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await loadStarted

    const envelope = hub.inspect.requests(GROUP_ID)[0]!
    const replay: PendingRequest = {
      ...envelope,
      action: {
        ...envelope.action,
        payload:
          envelope.action.payload === undefined
            ? undefined
            : JSON.parse(envelope.action.payload),
      },
      result:
        envelope.result === undefined
          ? undefined
          : (JSON.parse(envelope.result) as Result),
    }
    // snapshot load 中は phase=subscribing。残存 envelope の responseListener 再適用を
    // 注入し、live へ移る前の replay では listener が沈黙することを固定する。
    late.store.dispatch(synquxActions.requestChanged({ request: replay }))
    await settle()

    expect(late.store.getState().game.count).toBe(1)
    expect(hostOnly).not.toHaveBeenCalled()
    expect(everyone).not.toHaveBeenCalled()

    releaseLoad()
    await subscribing
    await settle()

    late.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(hostOnly).toHaveBeenCalledTimes(1)
    expect(everyone).toHaveBeenCalledTimes(1)
  })

  it('reducer が拒否した request では発火しない', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()
    const client = createHubClient(hub, {
      listeners: [
        {
          id: 'rejected',
          mode: 'everyone',
          match: (action) => action.type === 'game/forbidden',
          effect,
        },
      ],
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    client.store.dispatch({ type: 'game/forbidden' })
    await settle()

    expect(effect).not.toHaveBeenCalled()
    expect(client.store.getState().game.count).toBe(0)
  })

  it('host migration 後は新 host が以後の action だけで host-only を発火する', async () => {
    const hub = createMemoryHub()
    const aEffect = vi.fn()
    const bEffect = vi.fn()
    const a = createHubClient(hub, {
      listeners: [incrementListener('notify', 'host-only', aEffect)],
    })
    const b = createHubClient(hub, {
      listeners: [incrementListener('notify', 'host-only', bEffect)],
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    b.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(bEffect).toHaveBeenCalledTimes(1)

    hub.faults.disconnect('peer-2')
    await settle(10)
    expect(selectIsHost(a.store.getState())).toBe(true)
    expect(aEffect).not.toHaveBeenCalled()

    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(aEffect).toHaveBeenCalledTimes(1)
    expect(bEffect).toHaveBeenCalledTimes(1)
  })

  it('match / effect の失敗を握りつぶし、後続 rule と後続 action を止めない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const syncThrow = vi.fn(() => {
      throw new Error('sync failure')
    })
    const rejection = vi.fn(() => Promise.reject(new Error('async failure')))
    const healthy = vi.fn()
    const client = createHubClient(hub, {
      listeners: [
        {
          id: 'broken-match',
          mode: 'everyone',
          match: () => {
            throw new Error('match failure')
          },
          effect: vi.fn(),
        },
        incrementListener('sync-throw', 'everyone', syncThrow),
        incrementListener('rejection', 'everyone', rejection),
        incrementListener('healthy', 'everyone', healthy),
      ],
    })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(syncThrow).toHaveBeenCalledTimes(2)
    expect(rejection).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(client.store.getState().game.count).toBe(2)
  })

  it('instance / session 指定の standalone の local 適用で発火する', async () => {
    const standaloneEffect = vi.fn()
    const standalone = createClient(createMemoryHub().createTransport(), {
      mode: 'standalone',
      listeners: [
        incrementListener('standalone', 'host-only', standaloneEffect),
      ],
    })
    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone',
    })
    standalone.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(standaloneEffect).toHaveBeenCalledTimes(1)

    const hub = createMemoryHub()
    const localEffect = vi.fn()
    const local = createHubClient(hub, {
      listeners: [incrementListener('local', 'host-only', localEffect)],
    })
    const unsubscribe = await local.sync.subscribe({
      store: local.store,
      groupId: 'local',
      mode: 'standalone',
    })
    local.store.dispatch({ type: 'game/increment', payload: 1 })

    expect(localEffect).toHaveBeenCalledTimes(1)
    expect(hub.inspect.requests('local')).toEqual([])
    await unsubscribe()
  })

  it('id 重複と不正な mode は createSynqux が同期的に throw する', () => {
    const listener = incrementListener('duplicate', 'everyone', vi.fn())

    expect(() =>
      createHubClient(createMemoryHub(), { listeners: [listener, listener] }),
    ).toThrow('Duplicate SynquxListener id: duplicate')

    expect(() =>
      createHubClient(createMemoryHub(), {
        listeners: [
          {
            ...listener,
            id: 'invalid',
            mode: 'invalid' as SynquxListener<GameState, GameAction>['mode'],
          },
        ],
      }),
    ).toThrow('Invalid SynquxListener mode: invalid')
  })
})
