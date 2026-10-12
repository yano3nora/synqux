import type { Reducer } from '@reduxjs/toolkit'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createTestRootState } from '../testing/root-state.js'
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

describe('buildCreateLocalSlice validate / mutate 記法 (ADR-0031)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const slice = createLocalSlice({
    name: 'validated-panel',
    initialState: panelInitialState,
    reducers: {
      set: {
        validate: (root, payload: number) =>
          root.counter.count < payload ? 'not enough' : null,
        mutate: (state, action) => {
          state.seen = action.payload
        },
      },
      reset: {
        mutate: (state) => {
          state.seen = 0
        },
      },
      plain: (state) => {
        state.seen = 1
      },
      launch: {
        prepare: (value: string) => ({
          payload: Number(value),
          meta: { throttleless: true as const },
        }),
        validate: (_root, payload) => (payload < 0 ? 'negative' : null),
        mutate: (state, action) => {
          state.seen = action.payload
        },
      },
    },
  })

  const rootWithCount = (count: number) =>
    createTestRootState<TestRoot>({
      counter: { ...counterInitialState, count },
      panel: panelInitialState,
    })

  it('validate は root を受け、拒否時は state を変えず result も console 出力も無い', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(slice.actions.set.validate(rootWithCount(0), 1)).toBe('not enough')

    const rejected = slice.reducer(undefined, {
      ...slice.actions.set(1),
      meta: { root: rootWithCount(0) },
    })
    expect(rejected).toBe(panelInitialState)
    expect(rejected).not.toHaveProperty('result')
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('validate が null なら mutate を適用する (createTestRootState の root で単体実行)', () => {
    expect(
      slice.reducer(undefined, {
        ...slice.actions.set(2),
        meta: { root: rootWithCount(3) },
      }).seen,
    ).toBe(2)
    expect(
      slice.reducer(undefined, {
        ...slice.actions.launch('3'),
        meta: { root: rootWithCount(3) },
      }).seen,
    ).toBe(3)
    expectTypeOf(slice.actions.launch).parameters.toEqualTypeOf<
      [value: string]
    >()
  })

  it('rootReducer 配下では meta.root が注入され、適用後の synced で判定する', () => {
    const wiring = createSynquxRootReducer({
      isSyncedAction: kit.isSyncedAction,
      syncedKey: 'counter',
      synced: counterReducer,
      locals: { panel: slice.reducer },
    })

    let root = wiring.rootReducer(undefined, { type: '@@INIT' })
    root = wiring.rootReducer(root, slice.actions.set(1))
    expect(root.panel.seen).toBe(-1)

    root = wiring.rootReducer(root, boost(3))
    root = wiring.rootReducer(root, slice.actions.set(2))
    expect(root.panel.seen).toBe(2)
  })

  it('validate を持つ case は meta.root 無しで throw する (fail-fast)', () => {
    expect(() => slice.reducer(undefined, slice.actions.set(1))).toThrow(
      'requires meta.root',
    )
  })

  it('validate 省略時は root を要求せず、validate は常に null', () => {
    expect(slice.actions.reset.validate({} as TestRoot, undefined)).toBe(null)
    expect(slice.reducer(undefined, slice.actions.reset()).seen).toBe(0)
  })

  it('型: creator の validate は TRoot / P で型付けされ、plain 記法には無い', () => {
    expectTypeOf(slice.actions.set.validate)
      .parameter(0)
      .toEqualTypeOf<TestRoot>()
    expectTypeOf(slice.actions.set.validate).parameter(1).toBeNumber()
    expectTypeOf(slice.actions.set).parameters.toEqualTypeOf<
      [payload: number]
    >()
    // RTK の ActionCreatorWithoutPayload (引数 void) に写る
    expectTypeOf(slice.actions.reset).toBeCallableWith()
    expectTypeOf(slice.actions.plain).not.toHaveProperty('validate')
  })

  it('型: validate と mutate の payload 注釈の食い違いは型エラー', () => {
    const mismatch = createLocalSlice({
      name: 'mismatch',
      initialState: panelInitialState,
      reducers: {
        bad: {
          validate: (_root, _payload: number) => null,
          // @ts-expect-error validate の number と mutate の string が食い違う
          mutate: (_state, _action: LocalAction<string, TestRoot>) => {},
        },
      },
    })
    expect(mismatch.name).toBe('mismatch')
  })
})

describe('buildCreateLocalSlice validate / mutate 記法 (primitive state)', () => {
  it('primitive state でも拒否は state を返す (RTK は undefined 返却を throw する)', () => {
    const counter = createLocalSlice({
      name: 'primitive',
      initialState: 0,
      reducers: {
        set: {
          validate: (root, payload: number) =>
            root.counter.count < payload ? 'not enough' : null,
          mutate: (_state, action) => action.payload,
        },
      },
    })
    const root = createTestRootState<TestRoot>({
      counter: counterInitialState,
      panel: panelInitialState,
    })

    expect(
      counter.reducer(5, { ...counter.actions.set(1), meta: { root } }),
    ).toBe(5)
  })

  it('型: prepare 付きは prepare の payload を validate / mutate に押し付ける', () => {
    const mismatch = createLocalSlice({
      name: 'prepared-mismatch',
      initialState: panelInitialState,
      reducers: {
        bad: {
          prepare: (value: string) => ({ payload: Number(value) }),
          // @ts-expect-error prepare の number と mutate の string が食い違う
          mutate: (_state, _action: LocalAction<string, TestRoot>) => {},
        },
      },
    })
    expect(mismatch.name).toBe('prepared-mismatch')
  })
})
