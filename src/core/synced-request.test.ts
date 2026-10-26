import { configureStore } from '@reduxjs/toolkit'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'
import { assertActionIdempotency } from '../testing/idempotency.js'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { SyncedAction } from './action.js'
import { defineSynqux } from './define-synqux.js'
import { selectIsHost } from './selectors.js'
import type {
  InflightState,
  SyncedRequestDefinition,
} from './synced-request.js'
import { settle } from './test-fixtures.js'
import type { Result } from './types.js'

/**
 * createSyncedRequest (ADR-0032) の検証。前半は生成 reducer 単体、後半は
 * memory hub で engine の配線 (host だけの perform、timeout、session 境界) を見る
 */

type EchoState = {
  result: Result<SyncedAction, { text: string }> | null
  inflight: InflightState
  count: number
  log: string[]
}

const definition = defineSynqux({ syncedKey: 'game' }).withTypes<{
  synced: EchoState
}>()

const perform =
  vi.fn<SyncedRequestDefinition<EchoState, { n: number }, number>['perform']>()

const echo = definition.createSyncedRequest<{ n: number }, number>({
  key: 'echo',
  request: {
    validate: (_, payload) => (payload.n < 0 ? 'negative' : null),
    mutate: (state, action) => {
      state.log.push(`requested:${action.payload.n}`)
    },
  },
  resolve: {
    mutate: (state, action, inflight) => {
      state.count += action.payload.output
      state.log.push(`resolved:${inflight.payload.n}`)
    },
  },
  abort: {
    mutate: (state, action, inflight) => {
      state.log.push(`aborted:${action.payload.reason}:${inflight.payload.n}`)
    },
  },
  timeoutMs: 1_000,
  perform: (...args) => perform(...args),
})

const initialState: EchoState = {
  result: null,
  inflight: {},
  count: 0,
  log: [],
}

const slice = definition.createSyncedSlice({
  name: 'game',
  initialState,
  reducers: {},
  extraReducers: echo.reducer,
})
const reducer = slice.reducer

const requestedState = () => {
  const base = echo.requested({ n: 3 })
  const action = { ...base, meta: { ...base.meta, dispatched: 1_000 } }

  return { action, state: reducer(initialState, action) }
}

describe('createSyncedRequest (reducer)', () => {
  it('requested は台帳に処理中の 1 件を書き、利用側の mutate を呼ぶ', () => {
    const { action, state } = requestedState()

    expect(state.inflight.echo).toEqual({
      id: action.meta.hash,
      requestedAt: 1_000,
      requestedBy: null,
      payload: { n: 3 },
    })
    expect(state.log).toEqual(['requested:3'])
    expect(state.result?.type).not.toBe('error')
  })

  it('requested は処理中なら拒否し、利用側の validate はその後に評価する', () => {
    const { state } = requestedState()
    const next = reducer(state, echo.requested({ n: 4 }))

    expect(next.result?.type).toBe('error')
    expect(next.inflight.echo).toEqual(state.inflight.echo)
    expect(echo.requested.validate(state, { n: -1 })).toBe('echo: in flight')
    expect(echo.requested.validate(initialState, { n: -1 })).toBe('negative')
    expect(echo.requested.validate(initialState, { n: 1 })).toBeNull()
  })

  it('resolved は id が一致すれば mutate して台帳を消す', () => {
    const { action, state } = requestedState()
    const next = reducer(
      state,
      echo.resolved({ id: action.meta.hash, output: 6 }),
    )

    expect(next.result?.type).not.toBe('error')
    expect(next.count).toBe(6)
    expect(next.log).toEqual(['requested:3', 'resolved:3'])
    expect(next.inflight.echo).toBeNull()
  })

  it('resolved は台帳が空か id が違えば拒否し、再適用も拒否する', () => {
    const { action, state } = requestedState()

    expect(
      echo.resolved.validate(initialState, { id: action.meta.hash, output: 6 }),
    ).toBe('echo: no inflight request')
    expect(echo.resolved.validate(state, { id: 'other', output: 6 })).toContain(
      'echo: id mismatch',
    )
    assertActionIdempotency({
      reducer,
      state,
      action: echo.resolved({ id: action.meta.hash, output: 6 }),
      mode: 'rejects-repeat',
    })
  })

  it('aborted は id が一致すれば利用側の mutate を呼び台帳を消す', () => {
    const { action, state } = requestedState()
    const next = reducer(
      state,
      echo.aborted({ id: action.meta.hash, reason: 'timeout' }),
    )

    expect(next.log).toEqual(['requested:3', 'aborted:timeout:3'])
    expect(next.inflight.echo).toBeNull()
    expect(
      reducer(state, echo.aborted({ id: 'other', reason: 'failed' })).result
        ?.type,
    ).toBe('error')
  })

  it('synced state が inflight を持たなければ型エラーになる', () => {
    const plain = defineSynqux({ syncedKey: 'game' }).withTypes<{
      synced: { result: null; count: number }
    }>()

    expectTypeOf(plain.createSyncedRequest)
      .parameter(0)
      .not.toHaveProperty('perform')
  })
})

const GROUP_ID = 'synced-request-group'

const createClient = (
  hub: ReturnType<typeof createMemoryHub>,
  options?: { mode?: 'standalone' },
) => {
  const sync = definition.createSynqux({
    transport: hub.createTransport(),
    synced: reducer,
    locals: {},
    requests: [echo],
    ...(options?.mode ? { mode: options.mode, localSnapshots: false } : {}),
  })
  const store = configureStore({
    reducer: sync.rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(...sync.middlewares),
  })

  return { sync, store }
}

const subscribePair = async (hub: ReturnType<typeof createMemoryHub>) => {
  const a = createClient(hub)
  const b = createClient(hub)
  await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
  await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
  await settle(5)
  const [host, guest] = selectIsHost(a.store.getState()) ? [a, b] : [b, a]

  return { host, guest }
}

/** 解決を外から制御できる perform */
const deferPerform = () => {
  let resolve!: (output: number) => void
  perform.mockImplementationOnce(
    () => new Promise<number>((r) => (resolve = r)),
  )

  return { resolve: (output: number) => resolve(output) }
}

describe('createSyncedRequest (engine)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-26T00:00:00.000Z'))
    perform.mockReset()
    perform.mockImplementation(async ({ n }) => n * 2)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('host だけが perform し、resolved が全端末に適用される', async () => {
    const hub = createMemoryHub()
    const { host, guest } = await subscribePair(hub)

    guest.store.dispatch(echo.requested({ n: 3 }))
    await settle()

    expect(perform).toHaveBeenCalledOnce()
    expect(perform).toHaveBeenCalledWith(
      { n: 3 },
      { synced: expect.objectContaining({ count: 0 }) },
    )
    for (const client of [host, guest]) {
      expect(client.store.getState().game.count).toBe(6)
      expect(client.store.getState().game.inflight.echo).toBeNull()
    }
  })

  it('perform が throw したら aborted (failed) が全端末に適用される', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    perform.mockRejectedValueOnce(new Error('boom'))
    const hub = createMemoryHub()
    const { host, guest } = await subscribePair(hub)

    guest.store.dispatch(echo.requested({ n: 3 }))
    await settle()

    for (const client of [host, guest]) {
      expect(client.store.getState().game.log).toEqual([
        'requested:3',
        'aborted:failed:3',
      ])
    }
    expect(error).toHaveBeenCalledWith(
      '[synqux] SyncedRequest "echo" perform failed',
      expect.any(Error),
    )
  })

  it('timeout で aborted になり、その後に届いた結果は捨てられる', async () => {
    // 遅れた resolved の拒否は log 付きの error result として console に出る
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const { host, guest } = await subscribePair(hub)
    const deferred = deferPerform()

    guest.store.dispatch(echo.requested({ n: 3 }))
    // automation の評価間隔 (既定 1000ms) をまたぐまで進める
    await settle(30)

    expect(guest.store.getState().game.log).toEqual([
      'requested:3',
      'aborted:timeout:3',
    ])

    deferred.resolve(6)
    await settle()

    for (const client of [host, guest]) {
      expect(client.store.getState().game.count).toBe(0)
      expect(client.store.getState().game.log).toEqual([
        'requested:3',
        'aborted:timeout:3',
      ])
    }
    expect(error).toHaveBeenCalledWith('echo: no inflight request')
  })

  it('host が perform 中に抜けたら、新しい host が timeout で aborted を出す', async () => {
    const hub = createMemoryHub()
    const { host, guest } = await subscribePair(hub)
    const deferred = deferPerform()

    guest.store.dispatch(echo.requested({ n: 3 }))
    await settle(3)
    expect(perform).toHaveBeenCalledOnce()

    await host.sync.unsubscribe()
    // 抜けた端末の perform が終わっても、終わった session には流さない
    deferred.resolve(6)
    await settle(20)

    expect(selectIsHost(guest.store.getState())).toBe(true)
    expect(perform).toHaveBeenCalledOnce()
    expect(hub.inspect.requests(GROUP_ID).map((r) => r.action.type)).toEqual([
      'echo/requested',
      'echo/aborted',
    ])
    expect(host.store.getState().game.count).toBe(0)
    expect(guest.store.getState().game.log).toEqual([
      'requested:3',
      'aborted:timeout:3',
    ])
  })

  it('standalone でも perform と resolved が同じ配線で動く', async () => {
    const hub = createMemoryHub()
    const client = createClient(hub, { mode: 'standalone' })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.store.dispatch(echo.requested({ n: 2 }))
    await settle(3)

    expect(client.store.getState().game.count).toBe(4)
  })

  it('replaceRules の requests で perform の配線を差し替える', async () => {
    const hub = createMemoryHub()
    const client = createClient(hub, { mode: 'standalone' })
    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })

    client.sync.replaceRules({ requests: [] })
    client.store.dispatch(echo.requested({ n: 2 }))
    await settle(30)

    expect(perform).not.toHaveBeenCalled()
    expect(client.store.getState().game.inflight.echo).not.toBeNull()
  })

  it('同じ key の request を 2 つ渡すと createSynqux が throw する', () => {
    const hub = createMemoryHub()

    expect(() =>
      definition.createSynqux({
        transport: hub.createTransport(),
        synced: reducer,
        locals: {},
        requests: [echo, echo],
      }),
    ).toThrow('Duplicate SynquxAutomation id: synqux/request/echo/timeout')
  })
})
