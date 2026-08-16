import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import { synquxActions } from './slice.js'
import { createHubClient, settle, subscribeSettled } from './test-fixtures.js'

/**
 * host migration 境界の必須カバレッジ (ADR-0001 Decision 4)
 *
 * 移植元の既知の問題は全て migration / 離脱境界で発生しており、firebase 相手では
 * 再現が運任せだった。dual-host 窓・未応答 request の引き継ぎ・昇格待機中の滞留を
 * memory hub で決定的に再現する
 */

const GROUP_ID = 'group-migration'

describe('host migration 境界', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('host が未応答 request を残して切断しても、次点の端末が昇格して引き継ぎ処理する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    const { selfId: bId } = { selfId: 'peer-2' } // hub の採番規則 (接続順)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()
    expect(selectIsHost(b.store.getState())).toBe(true)

    // host (b) には request が届かない状況 (= 応答されないまま滞留) を作る
    hub.faults.drop({ requestId: '000000000001', to: bId, event: 'added' })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(20)

    // 誰も応答していないので適用されない
    expect(a.store.getState().game.count).toBe(0)

    // host 離脱 → a が昇格し、滞留していた request の fork が処理を引き継ぐ
    hub.faults.disconnect(bId)
    await settle(30)

    expect(selectIsHost(a.store.getState())).toBe(true)
    expect(a.store.getState().game.count).toBe(1)

    const requests = hub.inspect.requests(GROUP_ID)
    expect(requests[0]?.responsedBy).toBe('peer-1') // 引き継いだ a が裁定した
  })

  it('dual-host 窓: 2 端末が同時に host を自認して同一 request に応答しても、適用は全端末 1 回で収束する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    const c = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle()
    expect(selectIsHost(c.store.getState())).toBe(true)

    // presence イベントの遅延を模擬: b の端末ローカルでは c の離脱が観測され、
    // b も自分を host と信じている (実際には c は生きていて host のまま)
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(selectIsHost(c.store.getState())).toBe(true) // dual-host 窓の成立

    // 非冪等 action (toggle) で二重適用が起きれば検出できる
    a.store.dispatch({ type: 'game/toggle' })
    await settle(60)

    // b と c の両方が respond する (envelope は last-write-wins) が、
    // 各端末の適用は処理中ガード + 処理済みリストで高々 1 回に収束する
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.log).toEqual(['toggle'])
      expect(client.store.getState().game.count).toBe(1)
    }

    // snapshot の順序状態にも二重記録は残らない (seq 1 に勝者 1 件のみ)
    const snapshot = parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
    expect(snapshot.ordering.appliedSeq).toBe(1)
    expect(snapshot.ordering.applied[1]).toBe(
      hub.inspect.requests(GROUP_ID)[0]?.id,
    )
  })

  it('host 不在で滞留した request は、dedicated の参加 (昇格) を待って処理される', async () => {
    const hub = createMemoryHub()
    const guest = createHubClient(hub)

    // guest しかいない = 昇格可能な端末がいない
    await guest.sync.subscribe({
      store: guest.store,
      groupId: GROUP_ID,
      role: 'guest',
    })
    await settle()
    expect(selectIsHost(guest.store.getState())).toBe(false)

    guest.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(20)

    // host 不在のため request は滞留する (取りこぼしはしない)
    expect(guest.store.getState().game.count).toBe(0)

    // dedicated (常駐プロセス) が参加すると host になり、
    // 購読開始時の一括配送で滞留 request を受け取って処理する
    const dedicated = createHubClient(hub)
    await subscribeSettled(dedicated, { groupId: GROUP_ID, role: 'dedicated' })
    await settle(30)

    expect(selectIsHost(dedicated.store.getState())).toBe(true)
    expect(guest.store.getState().game.count).toBe(1)
    expect(dedicated.store.getState().game.count).toBe(1)
  })

  it('guest が player へ切り替わると host に昇格し、滞留 request を裁定する', async () => {
    const hub = createMemoryHub()
    const guest = createHubClient(hub)

    await guest.sync.subscribe({
      store: guest.store,
      groupId: GROUP_ID,
      role: 'guest',
    })
    await settle()
    expect(selectIsHost(guest.store.getState())).toBe(false)

    guest.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(20)
    expect(guest.store.getState().game.count).toBe(0)

    await guest.sync.setRole('player')
    await settle(30)

    expect(selectIsHost(guest.store.getState())).toBe(true)
    expect(guest.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)[0]?.responsedBy).toBe('peer-1')
  })

  it('host が guest へ切り替わると次点 player へ移譲し、滞留 request を裁定する', async () => {
    const hub = createMemoryHub()
    const b = createHubClient(hub)
    const a = createHubClient(hub)

    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle()
    expect(selectIsHost(a.store.getState())).toBe(true)

    // a への request 配送を落とし、降格後に b が引き継ぐ経路だけで裁定させる。
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'added',
    })
    const requested = a.store.dispatch({
      type: 'game/increment',
      payload: 1,
    })
    await a.sync.setRole('guest')
    await requested
    await settle(30)

    expect(selectIsHost(a.store.getState())).toBe(false)
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(a.store.getState().game.count).toBe(1)
    expect(b.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)[0]?.responsedBy).toBe('peer-1')
  })

  it('role 切替では自 peer の id と connected を変更しない', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)

    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      role: 'guest',
    })
    await settle()
    const before = hub.inspect.peers(GROUP_ID)[0]!

    await client.sync.setRole('player')
    await settle()
    const after = hub.inspect.peers(GROUP_ID)[0]!

    expect(after).toMatchObject({
      id: before.id,
      connected: before.connected,
      role: 'player',
    })
  })
})
