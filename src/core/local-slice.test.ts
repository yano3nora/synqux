import type { Reducer } from '@reduxjs/toolkit'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { LocalAction, SyncedAction } from './action.js'
import { defineSynqux } from './define-synqux.js'
import {
  buildCreateLocalSlice,
  type LocalActionOf,
  type WithLocalMeta,
} from './local-slice.js'
import { createSynquxRootReducer } from './root-reducer.js'
import type { SynquxState } from './slice.js'
import type { SynquxSynced } from './types.js'

type CounterState = SynquxSynced<SyncedAction> & { count: number }
const counterInitialState: CounterState = { result: null, count: 0 }

type PanelState = { seen: number; label: string; fallbacks: number }
const panelInitialState: PanelState = { seen: -1, label: '', fallbacks: 0 }

// テストでは root を手書きする (consumer の導出 root と構造は同じ。
// 導出 ⇄ 束縛の循環切断は consumer 側の Reducer<State> 注釈の責務)
type TestRoot = {
  synqux: SynquxState
  counter: CounterState
  panel: PanelState
}
type TestMeta = { throttleless?: true }

const kit = defineSynqux({ syncedKey: 'counter' }).withTypes<{
  synced: CounterState
}>()
// P を明示すると T の literal 推論が落ちる (RTK createAction と同じ制約) ため、
// 判別 narrowing のテストに使う都合で T も明示する
const boost = kit.createSyncedAction<number, 'shared/boost'>('shared/boost')

// prepare 拡張 meta が判別 union になる creator (ReplacedMeta の分配検証用)
const tagged = kit.createSyncedAction('shared/tagged', (kind: 'a' | 'b') => ({
  payload: kind,
  meta:
    kind === 'a'
      ? { kind: 'a' as const, a: 1 }
      : { kind: 'b' as const, b: 's' },
}))

const createLocalSlice = buildCreateLocalSlice<TestRoot, TestMeta>()

const counterReducer: Reducer<CounterState> = (
  state = counterInitialState,
  action,
) => {
  if (boost.match(action)) {
    return { ...state, count: state.count + action.payload }
  }
  return state
}

const panelSlice = createLocalSlice({
  name: 'panel',
  initialState: panelInitialState,
  reducers: {
    rename: (state, action: LocalAction<string, TestRoot, TestMeta>) => {
      state.label = action.payload
    },
  },
  extraReducers: (builder) => {
    builder.addCase(boost, (state, action) => {
      // 交差ではなく置換: creator の root?: any に TRoot が潰されない
      expectTypeOf(action.meta.root).toEqualTypeOf<TestRoot | undefined>()
      expectTypeOf(action.meta.hash).toBeString()
      expectTypeOf(action.meta.throttleless).toEqualTypeOf<true | undefined>()
      expectTypeOf(action.payload).toBeNumber()

      state.seen = action.meta.root?.counter.count ?? -1
    })

    builder.addMatcher(kit.isSyncedAction, (state, action) => {
      // guard matcher: narrow 後の union にも root 置換が分配される
      expectTypeOf(action.meta.root).toEqualTypeOf<TestRoot | undefined>()

      state.label = `synced:${action.type}`
    })

    builder.addMatcher(
      (action) => action.type === 'panel-probe/boolean',
      (state, action) => {
        // boolean matcher: LocalUnknownAction (type: string を保ったまま meta だけ重なる)
        expectTypeOf(action.type).toBeString()
        expectTypeOf(action.meta?.root).toEqualTypeOf<TestRoot | undefined>()

        state.fallbacks += 1
      },
    )
  },
})

const isBoostOrTagged = (
  action: any,
): action is ReturnType<typeof boost> | ReturnType<typeof tagged> =>
  boost.match(action) || tagged.match(action)

const probeSlice = createLocalSlice({
  name: 'probe',
  initialState: { last: '' },
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(tagged, (state, action) => {
      // prepare 拡張 meta の判別 union がメンバー固有キーごと保たれる
      expectTypeOf(action.meta.kind).toEqualTypeOf<'a' | 'b'>()
      if (action.meta.kind === 'a') {
        expectTypeOf(action.meta.a).toBeNumber()
      }
      expectTypeOf(action.meta.root).toEqualTypeOf<TestRoot | undefined>()

      state.last = `tagged:${action.payload}`
    })

    builder.addCase('probe/typed-string', (state, action) => {
      // type 文字列 overload も locals view (optional meta) で受ける
      expectTypeOf(action.type).toEqualTypeOf<'probe/typed-string'>()
      expectTypeOf(action.meta?.root).toEqualTypeOf<TestRoot | undefined>()

      state.last = action.type
    })

    builder.addMatcher(isBoostOrTagged, (state, action) => {
      // action union への分配: 判別 narrowing がそのまま効く
      if (action.type === 'shared/boost') {
        expectTypeOf(action.payload).toBeNumber()
      } else {
        expectTypeOf(action.payload).toEqualTypeOf<'a' | 'b'>()
      }
      expectTypeOf(action.meta.root).toEqualTypeOf<TestRoot | undefined>()

      state.last = `matched:${state.last}`
    })

    builder.addMatcher(
      (action: any): action is { payload: { probe: true } } =>
        Boolean(action?.payload?.probe),
      (state, action) => {
        // 非 Action 型の guard は & Action 正規化で type を保つ (RTK 同義)
        expectTypeOf(action.type).toBeString()
        expectTypeOf(action.payload.probe).toEqualTypeOf<true>()
        expectTypeOf(action.meta?.root).toEqualTypeOf<TestRoot | undefined>()

        state.last = `probe:${state.last}`
      },
    )
  },
})

describe('buildCreateLocalSlice', () => {
  it('runtime は RTK createSlice 素通し (creator / reducer / getInitialState)', () => {
    const renamed = panelSlice.reducer(
      undefined,
      panelSlice.actions.rename('a'),
    )

    expect(panelSlice.actions.rename('a').type).toBe('panel/rename')
    expect(renamed.label).toBe('a')
    expect(panelSlice.getInitialState()).toEqual(panelInitialState)
    expectTypeOf(panelSlice.actions.rename).parameter(0).toBeString()
  })

  it('rootReducer 配下で addCase が meta.root 経由の「適用後 synced」を読める', () => {
    const wiring = createSynquxRootReducer({
      isSyncedAction: kit.isSyncedAction,
      syncedKey: 'counter',
      synced: counterReducer,
      locals: { panel: panelSlice.reducer },
    })

    let state = wiring.rootReducer(undefined, { type: '@@INIT' })
    state = wiring.rootReducer(state, boost(5))

    expect(state.counter.count).toBe(5)
    // addCase (root.counter) と guard matcher (label) の両方が root を読めている
    expect(state.panel.seen).toBe(5)
    expect(state.panel.label).toBe('synced:shared/boost')
  })

  it('boolean matcher は type を保ったまま meta.root を読める形で発火する', () => {
    const state = panelSlice.reducer(undefined, {
      type: 'panel-probe/boolean',
    })

    expect(state.fallbacks).toBe(1)
  })

  it('addDefaultCase も locals view (meta.root) で受ける', () => {
    const fallbackSlice = createLocalSlice({
      name: 'fallback',
      initialState: { hits: 0 },
      reducers: {},
      extraReducers: (builder) => {
        builder.addDefaultCase((state, action) => {
          expectTypeOf(action.meta?.root).toEqualTypeOf<TestRoot | undefined>()
          state.hits += 1
        })
      },
    })

    expect(fallbackSlice.reducer(undefined, { type: 'anything' }).hits).toBe(1)
  })

  it('probe slice: 各 overload の runtime 発火 (addCase creator / type 文字列 / matchers)', () => {
    let state = probeSlice.reducer(undefined, tagged('a'))
    // addCase → 同一 action で guard matcher も発火する (case → matcher の実行順)
    expect(state.last).toBe('matched:tagged:a')

    state = probeSlice.reducer(undefined, { type: 'probe/typed-string' })
    expect(state.last).toBe('probe/typed-string')

    state = probeSlice.reducer(undefined, {
      type: 'anything',
      payload: { probe: true },
    })
    expect(state.last).toBe('probe:')
  })

  it('WithLocalMeta: optional meta の維持と meta なし action への optional 追加', () => {
    type OptMetaAction = { type: 'y'; payload: number; meta?: { note: string } }
    type ReplacedOpt = WithLocalMeta<OptMetaAction, TestRoot, TestMeta>

    // optional は optional のまま (undefined が残る)
    expectTypeOf<
      Extract<ReplacedOpt['meta'], undefined>
    >().toEqualTypeOf<undefined>()
    expectTypeOf<NonNullable<ReplacedOpt['meta']>['note']>().toBeString()
    expectTypeOf<NonNullable<ReplacedOpt['meta']>['root']>().toEqualTypeOf<
      TestRoot | undefined
    >()

    type BareAction = { type: 'z'; payload: number }
    type ReplacedBare = WithLocalMeta<BareAction, TestRoot, TestMeta>

    expectTypeOf<
      Extract<ReplacedBare['meta'], undefined>
    >().toEqualTypeOf<undefined>()
    expectTypeOf<NonNullable<ReplacedBare['meta']>['root']>().toEqualTypeOf<
      TestRoot | undefined
    >()
    expectTypeOf<
      NonNullable<ReplacedBare['meta']>['throttleless']
    >().toEqualTypeOf<true | undefined>()
  })

  it('LocalActionOf が束縛済み factory から TRoot / TMeta を逆引きする', () => {
    type Derived = LocalActionOf<typeof createLocalSlice, number>

    expectTypeOf<Derived>().toEqualTypeOf<
      LocalAction<number, TestRoot, TestMeta>
    >()
  })
})
