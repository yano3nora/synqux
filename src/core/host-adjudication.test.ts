import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost, selectSyncHealth } from './selectors.js'
import { synquxActions } from './slice.js'
import {
  createClient,
  createHubClient,
  settle,
  subscribeSettled,
} from './test-fixtures.js'
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

  it('前 host が snapshot 前に落ち、裁定 (changed) を失った端末が昇格しても、CAS の read-back で確定済み裁定を採用する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    const c = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)
    expect(selectIsHost(c.store.getState())).toBe(true)

    // c の snapshot は着地しない (respond ack 後・checkpoint 前の死) ので、
    // b の catch-up barrier は効かず、b は #1 を未裁定として裁定に入る
    hub.faults.holdSnapshot('peer-3')
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(a.store.getState().game.count).toBe(1)
    expect(b.store.getState().game.count).toBe(0)
    const frozen = hub.inspect.requests(GROUP_ID)[0]
    expect(frozen?.responsedBy).toBe('peer-3')

    hub.faults.disconnect('peer-3')
    await settle(20)
    expect(selectIsHost(b.store.getState())).toBe(true)

    // 契約 18: b の裁定は棄却され、返ってきた確定済み裁定を適用して追いつく
    expect(hub.inspect.requests(GROUP_ID)[0]).toMatchObject({
      epoch: frozen?.epoch,
      seq: frozen?.seq,
      responsedBy: 'peer-3',
      responsed: frozen?.responsed,
    })
    expect(b.store.getState().game.count).toBe(1)

    // 以後は通常どおり次の seq で裁定する
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(20)
    expect(hub.inspect.requests(GROUP_ID)[1]).toMatchObject({
      seq: 2,
      responsedBy: 'peer-2',
    })
    expect(a.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(b.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
  })

  it('裁定 (changed) を失った端末が昇格すると、耐久化済み水位まで裁定を止め、sync health の再購読で追いついてから裁定する', async () => {
    const STALL_AFTER_MS = 2000
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const b = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(1)
    expect(b.store.getState().game.count).toBe(0)

    hub.faults.disconnect('peer-3')
    await settle(5)
    expect(selectIsHost(b.store.getState())).toBe(true)

    // 水位 (seq 1) に追いつくまで新規 request を裁定しない (再裁定も seq 再発行もしない)
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)[0]?.responsedBy).toBe('peer-3')
    expect(hub.inspect.requests(GROUP_ID)[1]?.responsedBy).toBeUndefined()
    expect(b.store.getState().game.count).toBe(0)

    // 水位が gap の証拠になり、再購読で失った裁定を取り直して追いつく
    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1000)
    await settle(30)
    expect(b.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(a.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(hub.inspect.requests(GROUP_ID)[1]?.responsedBy).toBe('peer-2')
    expect(selectSyncHealth(b.store.getState()).phase).toBe('ok')
  })

  it('fence 購読を持たない adapter でも、昇格時に snapshot を読み直して耐久化済み水位まで裁定を止める', async () => {
    const STALL_AFTER_MS = 2000
    const hub = createMemoryHub()
    const a = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    // 契約 13 (subscribeSnapshotFence) 未実装の adapter を模す
    const bTransport = hub.createTransport()
    const b = createClient(
      { ...bTransport, subscribeSnapshotFence: undefined },
      { stallAfterMs: STALL_AFTER_MS },
    )
    const c = createHubClient(hub, { stallAfterMs: STALL_AFTER_MS })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(1)
    expect(b.store.getState().game.count).toBe(0)

    hub.faults.disconnect('peer-3')
    await settle(5)
    expect(selectIsHost(b.store.getState())).toBe(true)

    // fence 配送がなくても昇格時の読み直しで水位 1 を知り、追いつくまで裁定しない
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)[0]?.responsedBy).toBe('peer-3')
    expect(hub.inspect.requests(GROUP_ID)[1]?.responsedBy).toBeUndefined()

    await vi.advanceTimersByTimeAsync(STALL_AFTER_MS + 1000)
    await settle(30)
    expect(b.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(hub.inspect.requests(GROUP_ID)[1]).toMatchObject({
      seq: 2,
      responsedBy: 'peer-2',
    })
    expect(selectSyncHealth(b.store.getState()).phase).toBe('ok')
  })

  it('ack 後は server の changed を待たずに自己反映し、次の裁定へ進む (ADR-0029 Amendment)', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(5)
    expect(selectIsHost(b.store.getState())).toBe(true)

    // host 自身への changed 配送を止めても、ack 後の自己反映で適用が進む
    const heldEcho = hub.faults.delay({
      to: 'peer-2',
      requestId: '000000000001',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(10)
    expect(b.store.getState().game.log).toEqual(['increment:1'])
    expect(a.store.getState().game.log).toEqual(['increment:1'])

    // 直列ゲートが解けているので次の request も裁定される
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(10)
    expect(b.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(hub.inspect.requests(GROUP_ID)[1]).toMatchObject({
      seq: 2,
      responsedBy: 'peer-2',
    })

    // 遅れて届いた server の changed は二重適用しない
    heldEcho.release()
    await settle(10)
    expect(b.store.getState().game.log).toEqual(['increment:1', 'increment:10'])
    expect(b.store.getState().game.count).toBe(11)
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
    await subscribeSettled(c, { groupId: GROUP_ID })
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
