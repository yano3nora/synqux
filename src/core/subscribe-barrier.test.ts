import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  createClient,
  createHubClient,
  settle,
  withoutOnReady,
} from './test-fixtures.js'

const GROUP_ID = 'group-barrier'

/**
 * 初回購読 barrier (ADR-0021 Decision 1): onReady 到達と backlog 適用完了の
 * 両方を待ってから live へ遷移し、engine (automations 等) も barrier の後ろで起動する
 */
describe('subscribe barrier (ADR-0021 Decision 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('live 遷移の時点で backlog の裁定列は適用済みになっている', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    // snapshot restore ではなく backlog 適用で追いつく状況にする
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    first.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()

    let countAtLive = -1
    let readCount: () => number = () => -1
    const late = createClient(hub.createTransport(), {
      onPhaseChanged: (phase) => {
        if (phase === 'live') {
          countAtLive = readCount()
        }
      },
    })
    readCount = () => late.store.getState().game.count

    const subscribing = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await subscribing

    expect(countAtLive).toBe(11)
  })

  it('automations は catch-up 途中の state を評価しない (barrier 後に起動する)', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // catch-up 途中 (count === 0) を live と誤認すると発行されてしまう rule。
    // barrier 通過後の初回評価では count === 1 のため発行されない
    const late = createHubClient(hub, {
      automations: [
        {
          id: 'fire-on-initial-state',
          when: (synced) => synced.count === 0,
          action: () => ({ type: 'game/increment', payload: 100 }),
        },
      ],
    })
    const subscribing = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await subscribing
    await settle(20)

    expect(late.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
  })

  it('onReady を呼ばない旧 adapter では timeout 経由で live へ縮退する', async () => {
    const hub = createMemoryHub()
    const client = createClient(withoutOnReady(hub.createTransport()))

    let resolved = false
    const subscribing = client.sync
      .subscribe({ store: client.store, groupId: GROUP_ID })
      .then((unsubscribe) => {
        resolved = true
        return unsubscribe
      })

    await vi.advanceTimersByTimeAsync(9_000)
    expect(resolved).toBe(false)
    expect(client.store.getState().synqux.phase).toBe('subscribing')

    await vi.advanceTimersByTimeAsync(1_500)
    expect(resolved).toBe(true)
    expect(client.store.getState().synqux.phase).toBe('live')
    await subscribing
  })

  it('barrier 待機中の abort は subscribe を reject し、session を残さない', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const client = createClient(withoutOnReady(hub.createTransport()))
    const controller = new AbortController()

    const subscribing = client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      signal: controller.signal,
    })
    // reject は timer 進行中に完了するため、観測を先に張って unhandled にしない
    let rejection: unknown = null
    subscribing.catch((error: unknown) => {
      rejection = error
    })
    await vi.advanceTimersByTimeAsync(2_000)
    controller.abort(new Error('boot cancelled'))
    await vi.advanceTimersByTimeAsync(1_500)

    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe('boot cancelled')
    expect(client.store.getState().synqux.phase).toBe('idle')
    expect(hub.inspect.peers(GROUP_ID)).toEqual([])
  })
})
