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
import type { LocalAction, SyncedActionMeta } from './action.js'
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
