import {
  configureStore,
  createSlice,
  type Action,
  type Reducer,
} from '@reduxjs/toolkit'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { LocalAction, SyncedAction, SyncedActionMeta } from './action.js'
import { defineSynqux } from './define-synqux.js'
import { settle } from './test-fixtures.js'
import type { SynquxState } from './slice.js'
import type { SynquxSynced } from './types.js'

/**
 * defineSynqux (定義 + 配線の二相 API) の end-to-end 検証
 *
 * 手書き predicate (test-fixtures) ベースの simulation test に対し、こちらは
 * registry 由来の isSyncedAction と definition.createSynqux の内部配線が
 * 分散経路 (request 化 → host 裁定 → 封筒再構築での配達 → snapshot restore) を
 * そのまま通ることを確認する。
 * 実運用では端末ごとに別 JS realm で同一 bundle が評価されるため registry
 * instance は端末ごとに独立する — 基本ケースはモジュールスコープの定義を
 * 共有し、独立 registry の再現は専用のケースで行う
 */

type CountAction = Action<'game/increment'> & {
  payload: number
  meta: SyncedActionMeta
}
type CountState = SynquxSynced<CountAction> & { count: number }

const definition = defineSynqux({ syncedKey: 'game' }).withTypes<{
  synced: CountState
}>()
const increment = definition.createSyncedAction<number>('game/increment')

const countReducer: Reducer<CountState> = (
  state = { result: null, count: 0 },
  action,
) => {
  // 判定は type 文字列基準なので、どの定義 instance の述語でも同じ結果になる
  if (!definition.isSyncedAction(action)) {
    return state
  }

  return { ...state, count: state.count + action.payload }
}

const createClient = (
  hub: ReturnType<typeof createMemoryHub>,
  ownDefinition = definition,
) => {
  // 配線フェーズ: rootReducer / selectSynced / isSyncedAction の接続は内部化
  const sync = ownDefinition.createSynqux({
    transport: hub.createTransport(),
    synced: countReducer,
    locals: {},
  })
  const store = configureStore({
    reducer: sync.rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(...sync.middlewares),
  })

  return { sync, store }
}

const GROUP_ID = 'kit-group'

describe('defineSynqux (end-to-end)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registry 述語で request 化 → host 裁定 → 封筒再構築の全端末適用が成立する', async () => {
    const hub = createMemoryHub()
    const a = createClient(hub)
    const b = createClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(increment(2))

    // 楽観更新しない: request 化された action はローカル適用されない
    expect(a.store.getState().game.count).toBe(0)

    await settle()

    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(hub.inspect.requests(GROUP_ID)[0]?.seq).toBe(1)
  })

  it('登録済み type の素の action も metaSetter fallback が meta を補完して request 化する', async () => {
    const hub = createMemoryHub()
    const a = createClient(hub)
    const b = createClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    // creator を通さない素の dispatch (meta なし)。kit 方式でも registry に
    // 載っている type なら同期対象になり、fallback が hash / dispatched を補完する
    a.store.dispatch({ type: 'game/increment', payload: 3 })
    await settle()

    expect(a.store.getState().game.count).toBe(3)
    expect(b.store.getState().game.count).toBe(3)

    // 不変条件: reducer に到達した synced action は hash / dispatched を必ず持つ
    const applied = a.store.getState().game.result?.action
    expect(typeof applied?.meta.hash).toBe('string')
    expect(typeof applied?.meta.dispatched).toBe('number')
  })

  it('端末ごとに独立した定義 (別 realm 相当) でも type 文字列基準で封筒配達が成立する', async () => {
    // 実ブラウザは端末ごとに別 JS realm で同一 bundle を評価するため、registry
    // instance は端末ごとに別物になる。同じ creator 定義を各定義で評価した状態
    // (= 同一 bundle の再現) で、封筒から再構築された action が判定できること
    const buildPeer = (hub: ReturnType<typeof createMemoryHub>) => {
      const ownDefinition = defineSynqux({ syncedKey: 'game' }).withTypes<{
        synced: CountState
      }>()
      const ownIncrement =
        ownDefinition.createSyncedAction<number>('game/increment')
      return { ...createClient(hub, ownDefinition), increment: ownIncrement }
    }

    const hub = createMemoryHub()
    const a = buildPeer(hub)
    const b = buildPeer(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(a.increment(2))
    await settle()
    b.store.dispatch(b.increment(3))
    await settle()

    expect(a.store.getState().game.count).toBe(5)
    expect(b.store.getState().game.count).toBe(5)
  })

  it('途中参加端末が snapshot restore で registry 述語のまま追いつく', async () => {
    const hub = createMemoryHub()
    const a = createClient(hub)
    const b = createClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(increment(1))
    await settle()
    b.store.dispatch(increment(4))
    await settle()

    const late = createClient(hub)
    const pending = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await pending

    expect(late.store.getState().game.count).toBe(5)
  })

  it('root 型は配線フェーズが導出し、手書き root を必要としない', () => {
    const sync = definition.createSynqux({
      transport: createMemoryHub().createTransport(),
      synced: countReducer,
      locals: { local: (state: number = 0) => state },
    })

    // consumer の RootState は ReturnType<typeof sync.rootReducer> で得る
    type DerivedRoot = ReturnType<typeof sync.rootReducer>
    expectTypeOf<DerivedRoot>().toMatchTypeOf<{
      synqux: SynquxState
      game: CountState
      local: number
    }>()
    // dispatchAndWait は synced state から推論した domain action で型付く
    expectTypeOf(sync.dispatchAndWait).parameter(0).toEqualTypeOf<CountAction>()

    // 束縛後の定義に withTypes は存在しない (別 domain 型への再束縛を型で封じる)
    expectTypeOf(definition).not.toHaveProperty('withTypes')
  })

  it('replaceReducers は instance と store を生かしたまま synced reducer を差し替える', async () => {
    const hub = createMemoryHub()
    const a = createClient(hub)
    const b = createClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    // HMR で再評価された reducer module 相当 (payload を 2 倍で適用する)
    const doubled: Reducer<CountState> = (state, action) =>
      definition.isSyncedAction(action)
        ? countReducer(state, { ...action, payload: action.payload * 2 })
        : countReducer(state, action)
    a.sync.replaceReducers({ synced: doubled, locals: {} })
    b.sync.replaceReducers({ synced: doubled, locals: {} })

    a.store.dispatch(increment(2))
    await settle()

    // store.replaceReducer なし: 配線済みの echo が委譲先の変更へ追従する
    expect(a.store.getState().game.count).toBe(4)
    expect(b.store.getState().game.count).toBe(4)

    // 素材の型は配線 config と同じ (synced の型と locals の key 集合は配線時に
    // 固定。root の形を変える差し替えは対象外で instance を作り直す)
    expectTypeOf(a.sync.replaceReducers)
      .parameter(0)
      .toHaveProperty('synced')
      .toMatchTypeOf<Reducer<CountState>>()
  })

  it('creator は locals の LocalAction 注釈 (導出 root) の addCase と両立する', () => {
    const sync = definition.createSynqux({
      transport: createMemoryHub().createTransport(),
      synced: countReducer,
      locals: { local: (state: number = 0) => state },
    })
    type DerivedRoot = ReturnType<typeof sync.rootReducer>

    // locals slice が synced creator へ追従する既存 idiom: 注釈で root に型を
    // 与える。creator の meta.root は any のため注釈と衝突しない (ADR-0026)
    const localsSlice = createSlice({
      name: 'local',
      initialState: { seen: 0 },
      reducers: {},
      extraReducers: (builder) => {
        builder.addCase(
          increment,
          (state, action: LocalAction<number, DerivedRoot>) => {
            state.seen = action.meta?.root?.game.count ?? 0
          },
        )
      },
    })

    expect(localsSlice.reducer(undefined, { type: 'noop' }).seen).toBe(0)
  })
})

describe('defineSynqux validate / mutate 記法 (ADR-0031)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const createValidatedClient = (
    hub: ReturnType<typeof createMemoryHub>,
    options?: {
      automations?: Parameters<typeof definition.createSynqux>[0]['automations']
    },
  ) => {
    const own = defineSynqux({ syncedKey: 'game' }).withTypes<{
      synced: CountState
    }>()
    const add = own.createSyncedAction('game/increment', {
      validate: (state, payload: number) => {
        expectTypeOf(state).toEqualTypeOf<CountState>()
        if (state.count + payload > 10) return 'over'
        if (payload === 0) return { message: { text: 'zero' } }
        return null
      },
      mutate: (state, action) => {
        state.count += action.payload
      },
    })
    const slice = createSlice({
      name: 'game',
      initialState: { result: null, count: 0 } as CountState,
      reducers: {},
      // 配線は consumer が明示する (自動配線しない)
      extraReducers: (builder) => {
        builder.addCase(add, add.reducer)
      },
    })
    const sync = own.createSynqux({
      transport: hub.createTransport(),
      synced: slice.reducer,
      locals: {},
      automations: options?.automations,
    })
    const store = configureStore({
      reducer: sync.rootReducer,
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware().prepend(...sync.middlewares),
    })

    return { add, sync, store }
  }

  it('createSyncedAction の creator は validate / reducer を持ち、host 裁定で拒否と受理が分かれる', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const { add, sync, store } = createValidatedClient(hub)
    expectTypeOf(add).parameters.toEqualTypeOf<[payload: number]>()
    expect(add.validate({ result: null, count: 0 }, 11)).toBe('over')

    const unsubscribe = await sync.subscribe({ store, groupId: 'validated' })

    // string の拒否: log 専用 (state は不変、console.error に理由)
    store.dispatch(add(11))
    await settle()
    expect(store.getState().game.count).toBe(0)
    expect(consoleError).toHaveBeenCalledWith('over')

    // object の拒否: message 付き error result が端末へ届く
    store.dispatch(add(0))
    await settle()
    expect(store.getState().game.count).toBe(0)
    expect(store.getState().game.result).toMatchObject({
      type: 'error',
      message: { text: 'zero' },
    })

    store.dispatch(add(2))
    await settle()
    expect(store.getState().game.count).toBe(2)
    expect(store.getState().game.result?.type).toBe('success')

    await unsubscribe()
  })

  it('定義の registry が automations の発行前判定へ配線され、拒否される request は流れない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const { sync, store } = createValidatedClient(hub, {
      automations: [
        {
          id: 'over',
          retryMs: 100,
          when: () => true,
          action: () => ({
            type: 'game/increment',
            payload: 11,
            meta: { hash: 'auto', dispatched: 0 },
          }),
        },
      ],
    })

    const unsubscribe = await sync.subscribe({ store, groupId: 'auto' })
    await vi.advanceTimersByTimeAsync(350)
    await settle()

    expect(hub.inspect.requests('auto')).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('over')

    await unsubscribe()
  })

  it('型: prepare 付きは prepare が payload を決め、validate のみ / mutate のみでも推論する', () => {
    const own = defineSynqux({ syncedKey: 'game' }).withTypes<{
      synced: CountState
    }>()

    const prepared = own.createSyncedAction('game/prepared', {
      prepare: (label: string, value: number) => ({
        payload: value,
        meta: { label },
      }),
      validate: (_state, payload) => {
        expectTypeOf(payload).toBeNumber()
        return payload < 0 ? 'negative' : null
      },
      mutate: (state, action) => {
        expectTypeOf(action.payload).toBeNumber()
        state.count += action.payload
      },
    })
    expectTypeOf(prepared).parameters.toEqualTypeOf<
      [label: string, value: number]
    >()
    expect(prepared('x', 2).meta.label).toBe('x')
    expect(prepared.validate({ result: null, count: 0 }, -1)).toBe('negative')

    const mutateOnly = own.createSyncedAction('game/mutate-only', {
      mutate: (state, action: SyncedAction<number>) => {
        state.count += action.payload
      },
    })
    expectTypeOf(mutateOnly).parameters.toEqualTypeOf<[payload: number]>()
    expect(mutateOnly.validate({ result: null, count: 0 }, 2)).toBe(null)

    // @ts-expect-error validate の number と mutate の string が食い違う (overload 不一致)
    own.createSyncedAction('game/mismatch', {
      validate: (_state, _payload: number) => null,
      mutate: (_state, _action: SyncedAction<string>) => {},
    })
  })
})
