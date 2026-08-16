import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  createClient,
  createHubClient,
  settle,
  withoutOnReady,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SynquxListener } from './create-synqux.js'

const GROUP_ID = 'group-replay'

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

/**
 * ADR-0021 Decision 2 の再現テスト: stale snapshot + 全量再配送 (restore replay)
 * では listener を発火させない。reset reload 無限ループのインシデント機構の固定
 */
describe('replay suppression (ADR-0021 Decision 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('stale snapshot からの再購読で再配達された既裁定 envelope では発火せず、live の新裁定では発火する', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })

    // snapshot 永続化を kill し、「裁定は済んだが snapshot が進んでいない」
    // インシデントの前提状況 (listener effect の reload が保存を殺した状態) を作る
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // リロード相当: stale (不在) snapshot から新 client が全量再配送で追いつく
    const effect = vi.fn()
    const late = createClient(hub.createTransport(), {
      listeners: [incrementListener('render', 'everyone', effect)],
    })
    const subscribing = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await subscribing
    await settle()

    // 適用はされる (同期は成立) が、replay では発火しない
    expect(late.store.getState().game.count).toBe(1)
    expect(effect).not.toHaveBeenCalled()

    // 対照: 購読後の新しい裁定 (live) では発火する
    late.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(late.store.getState().game.count).toBe(2)
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it('recovery 再購読の再配送で追いついた適用でも発火しない', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()
    // b を先に接続し (peer-1)、後続接続の a (peer-2) を host にする
    const b = createHubClient(hub, {
      stallAfterMs: 2_000,
      listeners: [incrementListener('render', 'everyone', effect)],
    })
    const a = createHubClient(hub)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(5)

    // b は最初の request を丸ごと取り逃し、2 件目の観測で seq gap になる
    hub.faults.drop({ requestId: '000000000001', to: 'peer-1', event: 'added' })
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(5)
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(5)
    expect(b.store.getState().game.count).toBe(0)

    // 自動回復 (再購読) の全量再配送で追いつく。丸ごと取り逃した req1 は
    // 「既裁定のまま added」= replay として発火しない。live の changed で裁定を
    // 観測済みだった req2 は適用が gap で遅れただけの live 発火として扱われる
    // (再配送の replay 印より先に、既存 fork が適用へ到達する)
    await settle(60)

    expect(b.store.getState().game.count).toBe(11)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(effect).toHaveBeenCalledWith(
      expect.objectContaining({ payload: 10 }),
      expect.anything(),
    )

    // 回復後の live の新裁定でも発火する
    a.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle()

    expect(b.store.getState().game.count).toBe(111)
    expect(effect).toHaveBeenCalledTimes(2)
  })

  it('session 終了後は、teardown の微小窓 (entities / phase 残存) に届いた裁定でも適用も発火もしない', async () => {
    const hub = createMemoryHub()
    const effect = vi.fn()

    // requests 購読の解除 cleanup を gate で止め、逆順 cleanup の
    // 「session は消えたが entities / phase の破棄が済んでいない」窓を決定的に開く
    const transport = hub.createTransport()
    let releaseUnsubscribe!: () => void
    const unsubscribeGate = new Promise<void>((resolve) => {
      releaseUnsubscribe = resolve
    })
    const gated: typeof transport = {
      ...transport,
      subscribeRequests: (options, handlers) => {
        const unsubscribe = transport.subscribeRequests(options, handlers)
        return () => unsubscribeGate.then(unsubscribe)
      },
    }

    // b (peer-1) を先に接続し、後続接続の a (peer-2) を host にする
    const b = createClient(gated, {
      listeners: [incrementListener('render', 'everyone', effect)],
    })
    const a = createHubClient(hub)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(5)

    // b は seq 1 の added を取り逃し、changed は保留。seq 2 は届くが seq 1 待ちで
    // 適用できず、entity と fork が残ったままになる
    hub.faults.drop({ requestId: '000000000001', to: 'peer-1', event: 'added' })
    const delayedSeq1 = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'changed',
    })
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle(5)
    a.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle(5)
    expect(b.store.getState().game.count).toBe(0)

    // teardown を開始し、gate で「session = null・entities / phase 残存」の窓を開く
    const closing = b.sync.unsubscribe()
    await settle(2)
    expect(b.store.getState().synqux.phase).toBe('live')
    expect(
      Object.keys(b.store.getState().synqux.requests.entities),
    ).not.toEqual([])

    // 窓の中へ seq 1 の裁定を届ける。ガードがなければ live 扱いで適用され、
    // listener (reload 型 effect 相当) が発火してしまう
    delayedSeq1.release()
    await settle(20)

    expect(b.store.getState().game.count).toBe(0)
    expect(effect).not.toHaveBeenCalled()

    releaseUnsubscribe()
    await settle(5)
    await closing
    expect(effect).not.toHaveBeenCalled()
  })

  it('onReady を呼ばない旧 adapter で barrier が timeout 縮退しても、live 中の replay 適用では発火しない', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub)
    await first.sync.subscribe({ store: first.store, groupId: GROUP_ID })
    hub.faults.holdSnapshot('peer-1')
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // backlog の配送自体を遅延させ、「live 遷移後に届く replay」を作る
    const delayedBacklog = hub.faults.delay({
      requestId: '000000000001',
      to: 'peer-2',
      event: 'added',
    })
    const effect = vi.fn()
    const late = createClient(withoutOnReady(hub.createTransport()), {
      listeners: [incrementListener('render', 'everyone', effect)],
    })
    const subscribing = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })

    // onReady が来ないため barrier は timeout (10s) で live へ縮退する
    await vi.advanceTimersByTimeAsync(10_500)
    await subscribing
    expect(late.store.getState().synqux.phase).toBe('live')
    expect(late.store.getState().game.count).toBe(0)

    // phase は既に live だが、replay 印により発火しない (Decision 2 が正で
    // phase ゲートは防衛線、の検証)
    delayedBacklog.release()
    await settle()

    expect(late.store.getState().game.count).toBe(1)
    expect(effect).not.toHaveBeenCalled()
  })
})
