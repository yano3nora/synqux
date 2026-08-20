import { configureStore, type Action, type Reducer } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import type { SyncedActionMeta } from './action.js'
import { createSynqux } from './create-synqux.js'
import { createSynquxKit } from './kit.js'
import { createSynquxRootReducer } from './root-reducer.js'
import type { SynquxState } from './slice.js'
import { settle } from './test-fixtures.js'
import type { SynquxSynced } from './types.js'

/**
 * kit (creator registry) 述語での end-to-end 検証
 *
 * 手書き predicate (test-fixtures) ベースの simulation test に対し、こちらは
 * registry 由来の isSyncedAction が分散経路 (request 化 → host 裁定 →
 * 封筒再構築での配達 → snapshot restore) をそのまま通ることを確認する。
 * 実運用では端末ごとに別 JS realm で同一 bundle が評価されるため registry
 * instance は端末ごとに独立する — 基本ケースはモジュールスコープの kit を
 * 共有し、独立 registry の再現は専用のケースで行う
 */

type CountAction = Action<'game/increment'> & {
  payload: number
  meta: SyncedActionMeta
}
type CountState = SynquxSynced<CountAction> & { count: number }
type RootState = { synqux: SynquxState; game: CountState }

const kit = createSynquxKit<{ synced: CountState; root: RootState }>({
  syncedKey: 'game',
})
const increment = kit.createSyncedAction<number>('game/increment')

const countReducer: Reducer<CountState> = (
  state = { result: null, count: 0 },
  action,
) => {
  // 判定は type 文字列基準なので、どの kit instance の述語でも同じ結果になる
  if (!kit.isSyncedAction(action)) {
    return state
  }

  return { ...state, count: state.count + action.payload }
}

const createKitClient = (
  hub: ReturnType<typeof createMemoryHub>,
  ownKit = kit,
) => {
  const wiring = createSynquxRootReducer({
    isSyncedAction: ownKit.isSyncedAction,
    syncedKey: ownKit.syncedKey,
    synced: countReducer,
    locals: {},
  })
  const sync = createSynqux({
    transport: hub.createTransport(),
    ...wiring,
  })
  const store = configureStore({
    reducer: wiring.rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(...sync.middlewares),
  })

  return { sync, store }
}

const GROUP_ID = 'kit-group'

describe('createSynquxKit (end-to-end)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-20T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registry 述語で request 化 → host 裁定 → 封筒再構築の全端末適用が成立する', async () => {
    const hub = createMemoryHub()
    const a = createKitClient(hub)
    const b = createKitClient(hub)

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
    const a = createKitClient(hub)
    const b = createKitClient(hub)

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

  it('端末ごとに独立した kit (別 realm 相当) でも type 文字列基準で封筒配達が成立する', async () => {
    // 実ブラウザは端末ごとに別 JS realm で同一 bundle を評価するため、registry
    // instance は端末ごとに別物になる。同じ creator 定義を各 kit で評価した状態
    // (= 同一 bundle の再現) で、封筒から再構築された action が判定できること
    const buildPeer = (hub: ReturnType<typeof createMemoryHub>) => {
      const ownKit = createSynquxKit<{ synced: CountState; root: RootState }>({
        syncedKey: 'game',
      })
      const ownIncrement = ownKit.createSyncedAction<number>('game/increment')
      return { ...createKitClient(hub, ownKit), increment: ownIncrement }
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
    const a = createKitClient(hub)
    const b = createKitClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(increment(1))
    await settle()
    b.store.dispatch(increment(4))
    await settle()

    const late = createKitClient(hub)
    const pending = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await pending

    expect(late.store.getState().game.count).toBe(5)
  })
})
