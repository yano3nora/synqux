import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSnapshotPayload } from './snapshot.js'
import { synquxActions, type PendingRequest } from './slice.js'
import {
  createClient,
  type GameAction,
  type RootState,
} from './test-fixtures.js'
import type { RequestEnvelope, Result, SynquxTransport } from './types.js'

/**
 * requests 同期ステートマシンの characterization test
 * (移植元 Phase 0 の middlewares.test.ts を新 API 向けに書き直したもの)
 *
 * transport を stub し、受信イベントは synquxActions.requestAdded /
 * requestChanged の直接 dispatch で再現する (= 受信ルーティングより内側の
 * middleware レイヤを対象にしている)。既知の問題①①′は Phase 0 で「現在の
 * 挙動」として固定されていたが、本 repo では C6 で修正済みのため、該当テストは
 * 「修正されていること」を assert する再現テストになっている
 */

const SELF = 'peer-self'
const GROUP_ID = 'group-test'

/** transport の書き込み系を全て mock した stub。受信は直接 dispatch で行う */
const createStubTransport = () => {
  const respondRequest = vi.fn(
    async (
      _id: string,
      _patch: {
        prev: string | null
        responsedBy: string
        result: string | null
      },
    ) => undefined,
  )
  const saveSnapshot = vi.fn(
    async (_key: string, _payload: string) => undefined,
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
  message: '',
  targets: [],
})

// host による response 済み request (changed で受信する形) を再現
const responded = (
  request: PendingRequest,
  over: Partial<PendingRequest> = {},
): PendingRequest => ({
  ...request,
  responsedBy: SELF,
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

const lastRespondedResult = (
  respondRequest: ReturnType<typeof createStubTransport>['respondRequest'],
): Result | null => {
  const calls = respondRequest.mock.calls as unknown as [
    string,
    { result: string | null },
  ][]
  const raw = calls.at(-1)?.[1].result
  return raw ? (JSON.parse(raw) as Result) : null
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

describe('requestListener (host の判定と応答)', () => {
  it('正常系: reducer を試し実行して success を response し、snapshot を永続化する', async () => {
    const { store, respondRequest, saveSnapshot } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(10)

    expect(respondRequest).toHaveBeenCalledTimes(1)
    const [id, patch] = respondRequest.mock.calls[0] as unknown as [
      string,
      { responsedBy: string; result: string | null },
    ]
    expect(id).toBe(request.id)
    expect(patch.responsedBy).toBe(SELF)
    // increment は result を積まない (= null) ので success 扱いで受理される
    expect(patch.result).toBeNull()

    // 試し実行は store を書き換えない。適用は response 受信側の責務
    expect(store.getState().game.count).toBe(0)

    // snapshot には試し実行後 (= 適用後) の state と revisions が載る
    expect(saveSnapshot).toHaveBeenCalledTimes(1)
    const payload = (
      saveSnapshot.mock.calls[0] as unknown as [string, string]
    )[1]
    const snapshot = parseSnapshotPayload(payload)
    expect((snapshot.synced as RootState['game']).count).toBe(1)
    expect(snapshot.ordering.revisions).toEqual([request.id])
  })

  it('validation NG の action は error result として response する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/forbidden' })

    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(10)

    const result = lastRespondedResult(respondRequest)
    expect(result?.type).toBe('error')
    expect(result?.console).toBe(true)
    // result は判定対象 action のもの (stale result にならない)
    expect((result?.action as GameAction | undefined)?.meta?.hash).toBe(
      request.action.meta?.hash,
    )
  })

  it('prev が未処理のあいだは待機し、処理済みになってから response する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()
    // NOTE prev の id は request より辞書順で古くしておくこと。
    // 新しくすると prev 解決後に isDelayed (既知の問題②の機構) に食われる
    const prevRequest = responded(
      makeRequest(
        { type: 'game/increment', payload: 1 },
        { id: 'req-aaa-prev' },
      ),
    )
    const request = makeRequest(
      { type: 'game/increment', payload: 10 },
      { id: 'req-zzz-target' },
    )

    store.dispatch(
      synquxActions.requestAdded({ request, prev: 'req-aaa-prev' }),
    )
    await vi.advanceTimersByTimeAsync(250)
    expect(respondRequest).not.toHaveBeenCalled()

    // prev の request が changed で届いて適用されると、待機が解除される
    store.dispatch(
      synquxActions.requestChanged({ request: prevRequest, prev: null }),
    )
    await vi.advanceTimersByTimeAsync(300)
    expect(respondRequest).toHaveBeenCalledTimes(1)
    expect(respondRequest.mock.calls[0]?.[0]).toBe('req-zzz-target')
  })

  it('処理済みの request は破棄する', async () => {
    const { store, respondRequest } = await setupSelfAsHost()
    const request = makeRequest({ type: 'game/increment', payload: 1 })

    // 一度 changed 経由で適用して処理済みにする
    store.dispatch(
      synquxActions.requestChanged({ request: responded(request), prev: null }),
    )
    await vi.advanceTimersByTimeAsync(200)
    expect(store.getState().game.count).toBe(1)

    // 同じ request が added で届いても response しない
    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(200)
    expect(respondRequest).not.toHaveBeenCalled()
  })

  it('【既知の問題②】処理済み末尾より辞書順で古い id の request は暗黙に破棄される', async () => {
    const { store, respondRequest } = await setupSelfAsHost()

    // 高い id の request を先に処理済みにする
    const newest = responded(
      makeRequest(
        { type: 'game/increment', payload: 1 },
        { id: 'req-zzz-newest' },
      ),
    )
    store.dispatch(
      synquxActions.requestChanged({ request: newest, prev: null }),
    )
    await vi.advanceTimersByTimeAsync(200)

    // 端末間の時計ズレで push id が逆転すると、正当な request がここで消える
    const older = makeRequest(
      { type: 'game/increment', payload: 10 },
      { id: 'req-aaa-older' },
    )
    store.dispatch(synquxActions.requestAdded({ request: older, prev: null }))
    await vi.advanceTimersByTimeAsync(500)

    expect(respondRequest).not.toHaveBeenCalled()
    expect(store.getState().game.count).toBe(1) // older は適用もされない
  })

  it('host でない間は response せず、host 昇格後に未応答 request を引き継いで response する', async () => {
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

    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(1500)
    expect(respondRequest).not.toHaveBeenCalled()

    // host 離脱 → 自分が host に昇格 → 滞留 request を処理する
    store.dispatch(synquxActions.peerRemoved('peer-other'))
    await vi.advanceTimersByTimeAsync(1100)
    expect(respondRequest).toHaveBeenCalledTimes(1)
  })

  it('【既知の問題①の再現条件】response の ack が遅くても revisions は重複しない (C6 修正済み)', async () => {
    const { store, respondRequest, saveSnapshot } = await setupSelfAsHost()

    // local echo (即時) と ack (遅延) を再現する:
    // responseListener 側の markApplied が ack より先に完了する状況を作る
    respondRequest.mockImplementation((async (...args: unknown[]) => {
      const [id, patch] = args as [
        string,
        { prev: string | null; responsedBy: string; result: string | null },
      ]
      const pending = store.getState().synqux.requests.entities[id]

      store.dispatch(
        synquxActions.requestChanged({
          request: {
            ...pending!,
            responsedBy: patch.responsedBy,
            result: patch.result
              ? (JSON.parse(patch.result) as Result)
              : undefined,
          },
          prev: patch.prev,
        }),
      )
      await new Promise((resolve) => setTimeout(resolve, 150))
    }) as never)

    const request = makeRequest({ type: 'game/increment', payload: 1 })
    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(500)

    const payload = (
      saveSnapshot.mock.calls[0] as unknown as [string, string]
    )[1]
    const snapshot = parseSnapshotPayload(payload)
    expect(
      snapshot.ordering.revisions.filter((id) => id === request.id),
    ).toHaveLength(1)
    // 適用も 1 回だけ
    expect(store.getState().game.count).toBe(1)
  })

  it('(①の対照) ack が即時に完了する通常時も revisions は重複しない', async () => {
    const { store, respondRequest, saveSnapshot } = await setupSelfAsHost()

    respondRequest.mockImplementation((async (...args: unknown[]) => {
      const [id, patch] = args as [
        string,
        { prev: string | null; responsedBy: string; result: string | null },
      ]
      const pending = store.getState().synqux.requests.entities[id]

      store.dispatch(
        synquxActions.requestChanged({
          request: {
            ...pending!,
            responsedBy: patch.responsedBy,
            result: patch.result
              ? (JSON.parse(patch.result) as Result)
              : undefined,
          },
          prev: patch.prev,
        }),
      )
      // ack 即時解決 = 通常時のネットワーク
    }) as never)

    const request = makeRequest({ type: 'game/increment', payload: 1 })
    store.dispatch(synquxActions.requestAdded({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(500)

    const payload = (
      saveSnapshot.mock.calls[0] as unknown as [string, string]
    )[1]
    const snapshot = parseSnapshotPayload(payload)
    expect(
      snapshot.ordering.revisions.filter((id) => id === request.id),
    ).toHaveLength(1)
  })
})

describe('responseListener (全端末への適用)', () => {
  it('success result の response を受信すると action を適用し、entities から破棄する', async () => {
    const { store } = await setupSelfAsHost()
    const request = responded(
      makeRequest({ type: 'game/increment', payload: 1 }),
    )

    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.count).toBe(1)
    // dispatch 完了した request は entities から破棄される
    expect(
      store.getState().synqux.requests.entities[request.id],
    ).toBeUndefined()
  })

  it('error & console の result は適用せず console.error へ流す', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { store } = await setupSelfAsHost()
    const base = makeRequest({ type: 'game/increment', payload: 1 })
    const request = responded(base, {
      result: { ...successResult(base), type: 'error', console: true },
    })

    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.count).toBe(0)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('prev 順に線形化して適用する (到着順が逆でも host の決めた順で適用)', async () => {
    const { store } = await setupSelfAsHost()
    const first = responded(makeRequest({ type: 'game/increment', payload: 1 }))
    const second = responded(
      makeRequest({ type: 'game/increment', payload: 10 }),
    )

    store.dispatch(
      synquxActions.requestChanged({ request: second, prev: first.id }),
    )
    store.dispatch(synquxActions.requestChanged({ request: first, prev: null }))
    await vi.advanceTimersByTimeAsync(400)

    expect(store.getState().game.log).toEqual(['increment:1', 'increment:10'])
  })

  it('処理済みの response は再適用しない (時間差の再配送は冪等)', async () => {
    const { store } = await setupSelfAsHost()
    const request = responded(makeRequest({ type: 'game/toggle' }))

    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(200)
    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(200)

    expect(store.getState().game.log).toEqual(['toggle']) // 1 回だけ適用
    expect(store.getState().game.count).toBe(1)
  })

  it('【既知の問題①′の再現条件】同一 response の同時二重配送でも二重適用しない (C6 修正済み)', async () => {
    const { store } = await setupSelfAsHost()
    const request = responded(makeRequest({ type: 'game/toggle' }))

    // check-then-act の窓 (check と markApplied の間の await) に 2 通目を入れる
    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    store.dispatch(synquxActions.requestChanged({ request, prev: null }))
    await vi.advanceTimersByTimeAsync(400)

    // toggle 系 action が反転 ×2 で「クリックが無かったこと」にならない
    expect(store.getState().game.log).toEqual(['toggle'])
    expect(store.getState().game.count).toBe(1)
  })
})
