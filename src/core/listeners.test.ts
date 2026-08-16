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
      {
        synced: b.store.getState().game,
        self: expect.objectContaining({
          id: b.store.getState().synqux.connections.selfId,
        }),
      },
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
    // snapshot load 中 (session 確定前) の注入は適用自体を行わない — 適用は
    // 「entity を所有する session が存在する」ことを前提とする (SPEC-0001
    // 「engine 状態の所有権」。teardown / 初期化窓での listener 誤発火の防止)
    late.store.dispatch(synquxActions.requestChanged({ request: replay }))
    await settle()

    expect(late.store.getState().game.count).toBe(0)
    expect(hostOnly).not.toHaveBeenCalled()
    expect(everyone).not.toHaveBeenCalled()

    releaseLoad()
    // 初回購読 barrier (ADR-0021) は backlog 適用を待つため settle を併走させる
    await settle()
    await subscribing
    await settle()

    // 残存 envelope は購読の全量再配送 (replay 印つき) で適用され、発火しない
    expect(late.store.getState().game.count).toBe(1)
    expect(hostOnly).not.toHaveBeenCalled()
    expect(everyone).not.toHaveBeenCalled()

    late.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(late.store.getState().game.count).toBe(2)
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

  it("scope 'all' + everyone は local action を dispatch した端末だけで発火する", async () => {
    const hub = createMemoryHub()
    const aEffect = vi.fn()
    const bEffect = vi.fn()
    const a = createHubClient(hub, {
      listeners: [
        {
          id: 'local-a',
          mode: 'everyone',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect: aEffect,
        },
      ],
    })
    const b = createHubClient(hub, {
      listeners: [
        {
          id: 'local-b',
          mode: 'everyone',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect: bEffect,
        },
      ],
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(5)

    a.store.dispatch({ type: 'ui/opened' })

    expect(aEffect).toHaveBeenCalledTimes(1)
    expect(aEffect).toHaveBeenCalledWith(
      { type: 'ui/opened' },
      {
        synced: a.store.getState().game,
        self: expect.objectContaining({
          id: a.store.getState().synqux.connections.selfId,
        }),
      },
    )
    expect(bEffect).not.toHaveBeenCalled()
  })

  it("scope 'all' + host-only は guest の local action を除外し host では発火する", async () => {
    const hub = createMemoryHub()
    const guestEffect = vi.fn()
    const hostEffect = vi.fn()
    const guest = createHubClient(hub, {
      listeners: [
        {
          id: 'guest-local',
          mode: 'host-only',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect: guestEffect,
        },
      ],
    })
    const host = createHubClient(hub, {
      listeners: [
        {
          id: 'host-local',
          mode: 'host-only',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect: hostEffect,
        },
      ],
    })

    await guest.sync.subscribe({ store: guest.store, groupId: GROUP_ID })
    await host.sync.subscribe({ store: host.store, groupId: GROUP_ID })
    await settle(5)
    expect(selectIsHost(guest.store.getState())).toBe(false)
    expect(selectIsHost(host.store.getState())).toBe(true)

    guest.store.dispatch({ type: 'ui/opened' })
    host.store.dispatch({ type: 'ui/opened' })

    expect(guestEffect).not.toHaveBeenCalled()
    expect(hostEffect).toHaveBeenCalledTimes(1)
  })

  it("scope 省略では local action を評価せず、scope 'all' は synced action も評価する", async () => {
    const defaultMatch = vi.fn(() => true)
    const defaultEffect = vi.fn()
    const allEffect = vi.fn()
    const client = createHubClient(createMemoryHub(), {
      listeners: [
        {
          id: 'default-synced-only',
          mode: 'everyone',
          match: defaultMatch,
          effect: defaultEffect,
        },
        {
          id: 'all-increment',
          mode: 'everyone',
          scope: 'all',
          match: (action) => action.type === 'game/increment',
          effect: allEffect,
        },
      ],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.store.dispatch({ type: 'ui/opened' })
    expect(defaultMatch).not.toHaveBeenCalled()
    expect(defaultEffect).not.toHaveBeenCalled()

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(defaultEffect).toHaveBeenCalledTimes(1)
    expect(allEffect).toHaveBeenCalledTimes(1)
  })

  it("scope 'all' でも synqux 内部 action を match に渡さない", async () => {
    const match = vi.fn(() => false)
    const client = createHubClient(createMemoryHub(), {
      listeners: [
        {
          id: 'exclude-internal',
          mode: 'everyone',
          scope: 'all',
          match,
          effect: vi.fn(),
        },
      ],
    })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    match.mockClear()

    client.store.dispatch({ type: 'synqux/test-internal' })

    expect(match).not.toHaveBeenCalled()
  })

  it("subscribe 完了前の local action では scope 'all' も発火しない", async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const loadSnapshot = transport.loadSnapshot.bind(transport)
    let notifyLoadStarted!: () => void
    let releaseLoad!: () => void
    const loadStarted = new Promise<void>((resolve) => {
      notifyLoadStarted = resolve
    })
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    transport.loadSnapshot = async (key) => {
      notifyLoadStarted()
      await loadGate
      return loadSnapshot(key)
    }
    const effect = vi.fn()
    const client = createClient(transport, {
      listeners: [
        {
          id: 'subscribing-local',
          mode: 'everyone',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect,
        },
      ],
    })

    const subscribing = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await loadStarted
    client.store.dispatch({ type: 'ui/opened' })

    expect(effect).not.toHaveBeenCalled()
    releaseLoad()
    await subscribing
  })

  it("standalone session では scope 'all' + host-only が local action で発火する", async () => {
    const effect = vi.fn()
    const client = createClient(createMemoryHub().createTransport(), {
      mode: 'standalone',
      listeners: [
        {
          id: 'standalone-local',
          mode: 'host-only',
          scope: 'all',
          match: (action) => action.type === 'ui/opened',
          effect,
        },
      ],
    })
    await client.sync.subscribe({ store: client.store, groupId: 'standalone' })

    client.store.dispatch({ type: 'ui/opened' })

    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('effect は ctx.self から自端末の presence peer (role) を読める', async () => {
    const effect = vi.fn()
    const client = createHubClient(createMemoryHub(), {
      listeners: [incrementListener('read-self', 'everyone', effect)],
    })
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      role: 'player',
    })
    await settle()

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    const state = client.store.getState()
    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'game/increment' }),
      {
        synced: state.game,
        self: expect.objectContaining({
          id: state.synqux.connections.selfId,
          role: 'player',
        }),
      },
    )
  })

  it('id 重複と不正な mode / scope は createSynqux が同期的に throw する', () => {
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

    expect(() =>
      createHubClient(createMemoryHub(), {
        listeners: [
          {
            ...listener,
            id: 'invalid-scope',
            scope: 'invalid',
          } as unknown as SynquxListener<GameState, GameAction>,
        ],
      }),
    ).toThrow('Invalid SynquxListener scope: invalid')
  })
})
