import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { synquxActions } from './slice.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'
import type { RequestEnvelope } from './types.js'

const GROUP_ID = 'group-host-adjudication'
const WAKE_FALLBACK_MS = 1000

const resultType = (envelope: RequestEnvelope): string | undefined =>
  envelope.result === undefined
    ? undefined
    : (JSON.parse(envelope.result) as { type?: string }).type

describe('host 裁定 lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T00:00:00.000Z'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // announce は result envelope の検証用で、result.log の console 出力
    // (announce applied) はここでは対象外のため黙らせる
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('message 付き error の残留後も、result を書かない次 request を受理して全端末へ適用する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch({ type: 'game/message-forbidden' })
    await settle()

    expect(resultType(hub.inspect.requests(GROUP_ID)[0]!)).toBe('error')
    expect(a.store.getState().game.result).toMatchObject({
      type: 'error',
      message: { text: 'forbidden' },
    })

    a.store.dispatch({ type: 'game/increment', payload: 2 })
    await settle()

    expect(resultType(hub.inspect.requests(GROUP_ID)[1]!)).toBe('success')
    for (const client of [a, b]) {
      expect(client.store.getState().game.count).toBe(2)
      expect(client.store.getState().game.result).toMatchObject({
        type: 'success',
        action: { type: 'game/increment' },
      })
    }
  })

  it('snapshot 失敗が確定済み success response を error で上書きしない', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    hub.faults.failSnapshot()
    a.store.dispatch({ type: 'game/announce' })
    await settle()

    const first = hub.inspect.requests(GROUP_ID)[0]!
    expect(resultType(first)).toBe('success')
    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])

    a.store.dispatch({ type: 'game/increment', payload: 2 })
    await settle()
    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(hub.inspect.requests(GROUP_ID)[1]?.seq).toBe(2)
  })

  it('ack 喪失時も凍結済み success response だけを再送して全端末が収束する', async () => {
    const hub = createMemoryHub()
    const aTransport = hub.createTransport()
    const bTransport = hub.createTransport()
    const a = createClient(aTransport)
    const b = createClient(bTransport)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    const deliveredResultTypes: (string | undefined)[] = []
    bTransport.subscribeRequests(
      {},
      {
        onAdded: () => undefined,
        onChanged: (envelope) =>
          deliveredResultTypes.push(resultType(envelope)),
      },
    )
    hub.faults.loseAck('000000000001')
    a.store.dispatch({ type: 'game/announce' })
    await settle(40)

    expect(deliveredResultTypes.length).toBeGreaterThanOrEqual(2)
    expect(new Set(deliveredResultTypes)).toEqual(new Set(['success']))
    expect(resultType(hub.inspect.requests(GROUP_ID)[0]!)).toBe('success')
    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])
  })

  it('respond の連続失敗後も同一裁定を ack まで再送し、未裁定 request を残さない', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    hub.faults.failRespond('000000000001', { times: 3 })
    a.store.dispatch({ type: 'game/announce' })
    await vi.advanceTimersByTimeAsync(0)

    for (let retry = 0; retry < 2; retry += 1) {
      expect(hub.inspect.requests(GROUP_ID)[0]?.seq).toBeUndefined()
      await vi.advanceTimersByTimeAsync(WAKE_FALLBACK_MS)
    }
    expect(hub.inspect.requests(GROUP_ID)[0]?.seq).toBeUndefined()

    await vi.advanceTimersByTimeAsync(WAKE_FALLBACK_MS)
    await settle()

    expect(resultType(hub.inspect.requests(GROUP_ID)[0]!)).toBe('success')
    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])
  })

  it('response 再送中に host が交代すると旧 fork が退場し、新 host の裁定で収束する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    expect(selectIsHost(b.store.getState())).toBe(true)

    hub.faults.failRespond('000000000001', { times: 3 })
    a.store.dispatch({ type: 'game/announce' })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(WAKE_FALLBACK_MS)
    expect(hub.inspect.requests(GROUP_ID)[0]?.seq).toBeUndefined()

    const c = createHubClient(hub)
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(50)

    expect(selectIsHost(b.store.getState())).toBe(false)
    expect(selectIsHost(c.store.getState())).toBe(true)
    expect(hub.inspect.requests(GROUP_ID)[0]).toMatchObject({
      responsedBy: 'peer-3',
      seq: 1,
    })
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.log).toEqual(['announce'])
    }
  })

  it('ack 前 local echo 中に敗者化した request を元の host fork が再裁定する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    const c = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle()

    // b だけ c の presence を失った dual-host 窓を作る。peer id の大きい c が
    // 同 epoch の tiebreak で勝つため、b の request を決定的に敗者化できる。
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(selectIsHost(c.store.getState())).toBe(true)

    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-3',
      event: 'added',
    })
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-3',
      event: 'changed',
    })
    const delayedFirstChangedToB = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'changed',
    })
    const heldFirstAck = hub.faults.holdAck('000000000001')
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)[0]).toMatchObject({
      responsedBy: 'peer-2',
      seq: 1,
    })

    hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-2',
      event: 'added',
    })
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)[1]).toMatchObject({
      responsedBy: 'peer-3',
      seq: 1,
    })

    // winner を先に適用後、b の local echo を ack pending のまま届ける。
    // requestChanged 起点の fork は active set に抑止されるため、元 fork が
    // 生存していなければ loser は seq 1 のまま永久滞留する。
    delayedFirstChangedToB.release()
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)[0]?.seq).toBe(1)

    heldFirstAck.release()
    await settle(40)

    expect(hub.inspect.requests(GROUP_ID)[0]).toMatchObject({
      responsedBy: 'peer-2',
      seq: 2,
    })
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.log).toEqual([
        'increment:10',
        'increment:1',
      ])
      expect(client.store.getState().game.count).toBe(11)
    }
  })
})
