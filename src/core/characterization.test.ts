import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSnapshotPayload } from './snapshot.js'
import { synquxActions, type PendingRequest } from './slice.js'
import {
  createClient,
  type GameAction,
  type RootState,
} from './test-fixtures.js'
import type {
  RequestEnvelope,
  Result,
  SnapshotFence,
  SynquxTransport,
} from './types.js'

/**
 * requests 同期ステートマシンの仕様テスト
 *
 * Phase 0 characterization (移植元の middlewares.test.ts) を起点に、
 * ADR-0002 (host 採番 seq / fencing) の仕様へ改訂したもの。transport を stub し、
 * 受信イベントは synquxActions.requestAdded / requestChanged の直接 dispatch で
 * 再現する (= 受信ルーティングより内側の middleware レイヤを対象にしている)
 *
 * v1 からの意図的な仕様変更:
 * - 既知の問題② (辞書順過去 id の暗黙ドロップ) は機構ごと消滅 → 反転テストで固定
 * - prev チェーン待機 → seq 直列 + in-flight 裁定ゲート
 * - dual-host 窓の同一 seq 衝突は決定的 tiebreak + 敗者の再裁定で収束
 */

const SELF = 'peer-self'
const GROUP_ID = 'group-test'

/** transport の書き込み系を全て mock した stub。受信は直接 dispatch で行う */
const createStubTransport = () => {
  const respondRequest = vi.fn(
    async (
      _id: string,
      _patch: {
        epoch: number
        seq: number
        responsedBy: string
        responsed: number
        result: string | null
      },
    ) => undefined,
  )
  const saveSnapshot = vi.fn(
    async (_key: string, _payload: string, _fence: SnapshotFence) => true,
  )
  const pushRequest = vi.fn(async (_envelope: Omit<RequestEnvelope, 'id'>) => ({
    id: 'pushed-id',
  }))

  const transport: SynquxTransport = {
    connect: async () => ({ selfId: SELF }),
    disconnect: async () => undefined,
    serverNow: async () => Date.now(),
    subscribePeers: () => () => undefined,
    pushRequest,
    respondRequest,
    subscribeRequests: () => () => undefined,
    saveSnapshot,
    loadSnapshot: () => null,
  }

  return { transport, respondRequest, saveSnapshot, pushRequest }
}

let n = 0
const makeRequest = (
  action: { type: GameAction['type']; payload?: number },
  over: Partial<PendingRequest> = {},
): PendingRequest => {
  n += 1
  return {
    id: `req-${String(n).padStart(3, '0')}`,
    requested: 1700000000000 + n,
    requestedBy: SELF,
    action: {
      ...action,
      meta: {
        requestedBy: SELF,
        hash: `hash-${n}`,
        dispatched: 1700000000000 + n,
      },
    },
    ...over,
  }
}

const successResult = (request: PendingRequest): Result => ({
  action: request.action as GameAction,
  type: 'success',
  targets: [],
})

// host による裁定済み request (changed で受信する形) を再現
const responded = (
  request: PendingRequest,
  stamp: { epoch?: number; seq: number; by?: string },
  over: Partial<PendingRequest> = {},
): PendingRequest => ({
  ...request,
  responsedBy: stamp.by ?? SELF,
  epoch: stamp.epoch ?? 1,
  seq: stamp.seq,
  result: successResult(request),
  ...over,
})

type Fixture = ReturnType<typeof createStubTransport> &
  ReturnType<typeof createClient>

/** 自端末を唯一の接続 = host として購読済みの状態を作る */
const setupSelfAsHost = async (): Promise<Fixture> => {
  const stub = createStubTransport()
  const client = createClient(stub.transport)

  await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
  client.store.dispatch(
    synquxActions.peerUpserted({ id: SELF, groupId: GROUP_ID, connected: 1 }),
  )

  return { ...stub, ...client }
}

/** stub の respondRequest を「裁定を requestChanged として即時 echo する」実装にする */
const echoResponses = (fixture: Fixture, options?: { ackDelayMs?: number }) => {
  fixture.respondRequest.mockImplementation((async (...args: unknown[]) => {
    const [id, patch] = args as [
      string,
      {
        epoch: number
        seq: number
        responsedBy: string
        result: string | null
      },
    ]
    const pending = fixture.store.getState().synqux.requests.entities[id]

    fixture.store.dispatch(
      synquxActions.requestChanged({
        request: {
          ...pending!,
          responsedBy: patch.responsedBy,
          epoch: patch.epoch,
          seq: patch.seq,
          result: patch.result
            ? (JSON.parse(patch.result) as Result)
            : undefined,
        },
      }),
    )

    if (options?.ackDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.ackDelayMs))
    }
  }) as never)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('actionRequestMiddleware', () => {
  it('client の synced action は request 化され、ローカル適用は中断される', async () => {
    const { store, pushRequest } = await setupSelfAsHost()

    await store.dispatch({ type: 'game/increment', payload: 1 })

    expect(pushRequest).toHaveBeenCalledTimes(1)
    expect(pushRequest.mock.calls[0]?.[0]?.action.type).toBe('game/increment')
    // 楽観更新しない: request 化された action は store に届かない
    expect(store.getState().game.count).toBe(0)
  })

  it('canRequest=false の端末 (readonly 相当) は request を送信しない', async () => {
    const stub = createStubTransport()
    const client = createClient(stub.transport, { canRequest: () => false })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    client.store.dispatch(
      synquxActions.peerUpserted({ id: SELF, groupId: GROUP_ID, connected: 1 }),
    )

    await client.store.dispatch({ type: 'game/increment', payload: 1 })

    expect(stub.pushRequest).not.toHaveBeenCalled()
    expect(client.store.getState().game.count).toBe(0)
  })

  it('meta.requestedBy 付き (同期済み) action は素通しして適用する', async () => {
    const { store, pushRequest } = await setupSelfAsHost()

    await store.dispatch({
      type: 'game/increment',
      payload: 1,
      meta: { requestedBy: SELF, hash: 'hash-direct', dispatched: 1 },
    })

    expect(pushRequest).not.toHaveBeenCalled()
    expect(store.getState().game.count).toBe(1)
  })
})

describe('host 裁定 fork (requestListener)', () => {
  it('正常系: reducer を試し実行して (epoch, seq) を採番・response し、snapshot を永続化する', async () => {
    const { store, respondRequest, saveSnapshot } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    store.dispatch(synquxActions.requestAdded({ request }))
    await vi.advanceTimersByTimeAsync(10)

    expect(respondRequest).toHaveBeenCalledTimes(1)
    const [id, patch] = respondRequest.mock.calls[0]!
    expect(id).toBe(request.id)
    expect(patch.responsedBy).toBe(SELF)
    expect(patch.epoch).toBe(1) // 初回昇格の世代
    expect(patch.seq).toBe(1) // 採番は appliedSeq + 1
    // 裁定時刻 (serverNow 基準) が封筒へ焼かれる (ADR-0008)
    expect(typeof patch.responsed).toBe('number')
    // result を書かない action も action 自身の default success になる (ADR-0013)
    const result = JSON.parse(patch.result as string) as Result
    expect(result).toMatchObject({
      type: 'success',
      action: {
        type: 'game/increment',
        meta: { hash: request.action.meta?.hash },
      },
    })

    // 試し実行は store を書き換えない。適用は response 受信側の責務
    expect(store.getState().game.count).toBe(0)

    // snapshot には試し実行後 (= 適用後) の state と順序状態が載る
    expect(saveSnapshot).toHaveBeenCalledTimes(1)
    const payload = (
      saveSnapshot.mock.calls[0] as unknown as [string, string]
    )[1]
    const snapshot = parseSnapshotPayload(payload)
    expect((snapshot.synced as RootState['game']).count).toBe(1)
    expect(snapshot.ordering.appliedSeq).toBe(1)
    expect(snapshot.ordering.applied[1]).toBe(request.id)
    expect(saveSnapshot.mock.calls[0]?.[2]).toEqual({
      epoch: 1,
      appliedSeq: 1,
    })
  })

  it('validation NG の action は error result として response する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/forbidden' })

    store.dispatch(synquxActions.requestAdded({ request }))
    await vi.advanceTimersByTimeAsync(10)

    const raw = respondRequest.mock.calls[0]?.[1].result
    const result = raw ? (JSON.parse(raw) as Result) : null
    expect(result?.type).toBe('error')
    // message なし = log 専用の拒否 (fixture の forbidden は log: 'forbidden')
    expect(result?.message).toBeUndefined()
    expect(result?.log).toBe('forbidden')
    // result は判定対象 action のもの (stale result にならない)
    expect((result?.action as GameAction | undefined)?.meta?.hash).toBe(
      request.action.meta?.hash,
    )
  })

  it('in-flight (裁定済み・未適用) が残る間は次の裁定を待ち、適用後に裁定する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()

    // seq 2 だけが届いている (seq 1 が欠けた) 状態 = in-flight が残る状態
    const first = makeRequest({ type: 'game/increment', payload: 1 })
    const second = makeRequest({ type: 'game/increment', payload: 10 })
    store.dispatch(
      synquxActions.requestChanged({
        request: responded(second, { seq: 2, by: 'peer-other' }),
      }),
    )

    const target = makeRequest({ type: 'game/increment', payload: 100 })
    store.dispatch(synquxActions.requestAdded({ request: target }))
    await vi.advanceTimersByTimeAsync(300)
    expect(respondRequest).not.toHaveBeenCalled() // 土台 state が古いため裁定しない

    // seq 1 が届くと 1 → 2 と適用が進み、ゲートが開いて seq 3 を採番する
    store.dispatch(
      synquxActions.requestChanged({
        request: responded(first, { seq: 1, by: 'peer-other' }),
      }),
    )
    await vi.advanceTimersByTimeAsync(500)

    expect(store.getState().game.count).toBe(11)
    expect(respondRequest).toHaveBeenCalledTimes(1)
    expect(respondRequest.mock.calls[0]?.[1].seq).toBe(3)
  })

  it('適用済みの request は裁定しない', async () => {
    const { store, respondRequest } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    // 一度 changed 経由で適用して処理済みにする
    store.dispatch(
      synquxActions.requestChanged({ request: responded(request, { seq: 1 }) }),
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(store.getState().game.count).toBe(1)

    // 同じ request が added で届いても response しない
    store.dispatch(synquxActions.requestAdded({ request }))
    await vi.advanceTimersByTimeAsync(200)
    expect(respondRequest).not.toHaveBeenCalled()
  })

  it('【既知の問題②の根治】辞書順で過去の id を持つ request もドロップされず裁定される', async () => {
    const { store, respondRequest } = await setupSelfAsHost()

    // 辞書順で新しい id の request が先に適用済み
    const newest = makeRequest(
      { type: 'game/increment', payload: 1 },
      { id: 'req-zzz-newest' },
    )
    store.dispatch(
      synquxActions.requestChanged({ request: responded(newest, { seq: 1 }) }),
    )
    await vi.advanceTimersByTimeAsync(200)

    // 時計がズレた端末の request (辞書順で過去の id)。v1 はここで暗黙に
    // ドロップしていた (isDelayedRequestId)。v2 は順序が id と無関係のため
    // 普通に次の seq を貰って適用される
    const older = makeRequest(
      { type: 'game/increment', payload: 10 },
      { id: 'req-aaa-older' },
    )
    store.dispatch(synquxActions.requestAdded({ request: older }))
    await vi.advanceTimersByTimeAsync(300)

    expect(respondRequest).toHaveBeenCalledTimes(1)
    expect(respondRequest.mock.calls[0]?.[0]).toBe('req-aaa-older')
    expect(respondRequest.mock.calls[0]?.[1].seq).toBe(2)
  })

  it('host でない間は裁定せず、host 昇格後に未応答 request を引き継いで裁定する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()

    // 自分より後に接続した端末が host になる
    store.dispatch(
      synquxActions.peerUpserted({
        id: 'peer-other',
        groupId: GROUP_ID,
        connected: 2,
      }),
    )
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    store.dispatch(synquxActions.requestAdded({ request }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(respondRequest).not.toHaveBeenCalled()

    // host 離脱 → 自分が host に昇格 → 滞留 request を処理する
    store.dispatch(synquxActions.peerRemoved('peer-other'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(respondRequest).toHaveBeenCalledTimes(1)
  })

  it('response の ack が遅くても snapshot の順序状態は二重記録されない (v1 既知の問題①の再発防止)', async () => {
    const fixture = await setupSelfAsHost()
    echoResponses(fixture, { ackDelayMs: 150 })

    const request = makeRequest({ type: 'game/increment', payload: 1 })
    fixture.store.dispatch(synquxActions.requestAdded({ request }))
    await vi.advanceTimersByTimeAsync(500)

    // snapshot 用の順序状態は ack await 前に評価固定される
    const payload = (
      fixture.saveSnapshot.mock.calls[0] as unknown as [string, string]
    )[1]
    const snapshot = parseSnapshotPayload(payload)
    expect(snapshot.ordering.appliedSeq).toBe(1)
    expect(Object.values(snapshot.ordering.applied)).toEqual([request.id])
    // 適用も 1 回だけ
    expect(fixture.store.getState().game.count).toBe(1)
  })

  it('【fencing】dual-host 窓の同一 seq 敗者を、host が新しい seq で再裁定して救済する', async () => {
    const fixture = await setupSelfAsHost()
    echoResponses(fixture)

    // dual-host 窓の産物: 異なる request が同一 seq 1 を持って届いた
    const winner = makeRequest({ type: 'game/increment', payload: 1 })
    const loser = makeRequest({ type: 'game/increment', payload: 10 })
    fixture.store.dispatch(
      synquxActions.requestChanged({
        request: responded(winner, { epoch: 1, seq: 1, by: 'zzz-host' }),
      }),
    )
    fixture.store.dispatch(
      synquxActions.requestChanged({
        request: responded(loser, { epoch: 1, seq: 1, by: 'aaa-host' }),
      }),
    )
    await vi.advanceTimersByTimeAsync(1000)

    // 勝者 (responsedBy 辞書順降順) が seq 1 で適用され、
    // 敗者は自端末 (host) が seq 2 で再裁定して適用される
    expect(fixture.store.getState().game.count).toBe(11)
    expect(fixture.store.getState().game.log).toEqual([
      'increment:1',
      'increment:10',
    ])
    expect(fixture.respondRequest).toHaveBeenCalledTimes(1)
    expect(fixture.respondRequest.mock.calls[0]?.[0]).toBe(loser.id)
    expect(fixture.respondRequest.mock.calls[0]?.[1].seq).toBe(2)
  })
})

describe('適用 fork (responseListener)', () => {
  it('success result の response を受信すると action を適用し、entities から破棄する', async () => {
    const { store } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    store.dispatch(
      synquxActions.requestChanged({ request: responded(request, { seq: 1 }) }),
    )
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.count).toBe(1)
    // dispatch 完了した request は entities から破棄される
    expect(
      store.getState().synqux.requests.entities[request.id],
    ).toBeUndefined()
  })

  it('log 専用の error result (message なし) は適用せず console.error へ流し、seq は消費する', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store } = await setupSelfAsHost()
    const base = makeRequest({ type: 'game/increment', payload: 1 })
    const request = responded(
      base,
      { seq: 1 },
      { result: { ...successResult(base), type: 'error', log: 'rejected' } },
    )

    store.dispatch(synquxActions.requestChanged({ request }))
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.count).toBe(0)
    expect(spy).toHaveBeenCalled()

    // seq 1 は拒否の記録として消費済みで、seq 2 が次に適用される
    const next = makeRequest({ type: 'game/increment', payload: 10 })
    store.dispatch(
      synquxActions.requestChanged({ request: responded(next, { seq: 2 }) }),
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(store.getState().game.count).toBe(10)
    spy.mockRestore()
  })

  it('seq 順に線形化して適用する (到着順が逆でも host の採番順で適用)', async () => {
    const { store } = await setupSelfAsHost()
    const first = makeRequest({ type: 'game/increment', payload: 1 })
    const second = makeRequest({ type: 'game/increment', payload: 10 })

    store.dispatch(
      synquxActions.requestChanged({ request: responded(second, { seq: 2 }) }),
    )
    store.dispatch(
      synquxActions.requestChanged({ request: responded(first, { seq: 1 }) }),
    )
    await vi.advanceTimersByTimeAsync(400)

    expect(store.getState().game.log).toEqual(['increment:1', 'increment:10'])
  })

  it('適用済みの response は再適用しない (時間差の再配送は冪等)', async () => {
    const { store } = await setupSelfAsHost()
    const request = responded(makeRequest({ type: 'game/toggle' }), { seq: 1 })

    store.dispatch(synquxActions.requestChanged({ request }))
    await vi.advanceTimersByTimeAsync(200)
    store.dispatch(synquxActions.requestChanged({ request }))
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.log).toEqual(['toggle']) // 1 回だけ適用
    expect(store.getState().game.count).toBe(1)
  })

  it('同一 response の同時二重配送でも二重適用しない (v1 既知の問題①′対策の継続)', async () => {
    const { store } = await setupSelfAsHost()
    const request = responded(makeRequest({ type: 'game/toggle' }), { seq: 1 })

    // check-then-act の窓 (check と markApplied の間の await) に 2 通目を入れる
    store.dispatch(synquxActions.requestChanged({ request }))
    store.dispatch(synquxActions.requestChanged({ request }))
    await vi.advanceTimersByTimeAsync(400)

    // toggle 系 action が反転 ×2 で「クリックが無かったこと」にならない
    expect(store.getState().game.log).toEqual(['toggle'])
    expect(store.getState().game.count).toBe(1)
  })

  it('【fencing】同一 seq の衝突は epoch 優先の決定的 tiebreak で勝者を選ぶ', async () => {
    const stub = createStubTransport()
    const client = createClient(stub.transport)
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    // 自分は host ではない (敗者の再裁定はこの端末では起きない)
    client.store.dispatch(
      synquxActions.peerUpserted({ id: SELF, groupId: GROUP_ID, connected: 1 }),
    )
    client.store.dispatch(
      synquxActions.peerUpserted({
        id: 'peer-other',
        groupId: GROUP_ID,
        connected: 2,
      }),
    )

    const oldGen = makeRequest({ type: 'game/increment', payload: 1 })
    const newGen = makeRequest({ type: 'game/increment', payload: 10 })

    // responsedBy 辞書順では oldGen ('zzz') が勝つが、epoch は newGen が新しい
    client.store.dispatch(
      synquxActions.requestChanged({
        request: responded(oldGen, { epoch: 1, seq: 1, by: 'zzz-host' }),
      }),
    )
    client.store.dispatch(
      synquxActions.requestChanged({
        request: responded(newGen, { epoch: 2, seq: 1, by: 'aaa-host' }),
      }),
    )
    await vi.advanceTimersByTimeAsync(400)

    // epoch が新しい方が勝者 (世代 tiebreak が responsedBy より優先)
    expect(client.store.getState().game.log).toEqual(['increment:10'])
    expect(client.store.getState().game.count).toBe(10)
  })
})
