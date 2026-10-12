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
import { createMemoryHub } from '../testing/memory-hub.js'
import type { SyncedAction, SyncedActionMeta } from './action.js'
import { defineSynqux } from './define-synqux.js'
import { withErrorResult } from './results.js'
import { settle } from './test-fixtures.js'
import type { SynquxSynced } from './types.js'

// ulid: 26 文字 Crockford base32
const ULID_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

type CounterState = SynquxSynced<SyncedAction> & { count: number }
const counterInitialState: CounterState = { result: null, count: 0 }

const kit = defineSynqux({ syncedKey: 'counter' }).withTypes<{
  synced: CounterState
}>()

const counterSlice = kit.createSyncedSlice({
  name: 'counter',
  initialState: counterInitialState,
  reducers: {
    add: (state, action: SyncedAction<number>) => {
      const next = state.count + action.payload

      // reducer が唯一の判定器: validation 失敗は state を変えず error を積む
      if (next > 100) {
        return withErrorResult({ ...state }, action, {
          message: { text: 'over' },
        })
      }

      state.count = next
    },
    reset: (state) => {
      state.count = 0
    },
    launch: {
      prepare: (label: string, value: number) => ({
        payload: { label, value },
        meta: { source: 'test' },
      }),
      reducer: (
        state,
        action: SyncedAction<{ label: string; value: number }>,
      ) => {
        state.count = action.payload.value
      },
    },
  },
})

const { add, launch, reset } = counterSlice.actions

describe('createSyncedSlice', () => {
  it('生成 creator は type prefix / 生成時 stamp / required meta 型を持つ', () => {
    const action = add(3)

    expect(action.type).toBe('counter/add')
    expect(action.payload).toBe(3)
    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expect(typeof action.meta.dispatched).toBe('number')
    expectTypeOf(action.meta).toMatchTypeOf<SyncedActionMeta>()
    expectTypeOf(action.payload).toBeNumber()
  })

  it('定義した case は全て registry に登録される (定義 = 同期対象の宣言)', () => {
    expect(kit.isSyncedAction(add(1))).toBe(true)
    expect(kit.isSyncedAction({ type: 'counter/reset' })).toBe(true)
    expect(kit.isSyncedAction({ type: 'counter/launch' })).toBe(true)
    expect(kit.isSyncedAction({ type: 'counter/unknown' })).toBe(false)
  })

  it('prepare 記法は consumer の payload / meta を維持したまま stamp を合成する', () => {
    const action = launch('phase-1', 7)

    expect(action.payload).toEqual({ label: 'phase-1', value: 7 })
    expect(action.meta.source).toBe('test')
    expect(action.meta.hash).toMatch(ULID_PATTERN)
    expectTypeOf(action.meta.source).toBeString()
  })

  it('action 引数なしの case は引数なし creator になる', () => {
    expectTypeOf(reset).parameters.toEqualTypeOf<[]>()
    expect(reset().type).toBe('counter/reset')
    expect(reset().meta.hash).toMatch(ULID_PATTERN)
  })

  it('reducer は immer の mutable 記法と withErrorResult の返却を両方受ける', () => {
    const applied = counterSlice.reducer(undefined, add(2))
    expect(applied.count).toBe(2)

    const rejected = counterSlice.reducer({ ...applied, count: 100 }, add(1))
    expect(rejected.count).toBe(100)
    expect(rejected.result?.type).toBe('error')
  })

  it('creator の match が使える (RTK createSlice 委譲の確認)', () => {
    expect(add.match({ type: 'counter/add' })).toBe(true)
    expect(add.match({ type: 'counter/reset' })).toBe(false)
  })

  it('予約 slice name "synqux" は synqux/ 配下も含めて定義時に throw する', () => {
    expect(() =>
      kit.createSyncedSlice({
        name: 'synqux',
        initialState: counterInitialState,
        reducers: {},
      }),
    ).toThrow(/reserved slice name/)
    // 生成 type が synqux/ 配下に入る name も拒否する
    expect(() =>
      kit.createSyncedSlice({
        name: 'synqux/custom',
        initialState: counterInitialState,
        reducers: {},
      }),
    ).toThrow(/reserved slice name/)
  })

  it('prepare が焼き込んだ hash / dispatched / error を尊重する (createSyncedAction と同じ契約)', () => {
    const own = defineSynqux({ syncedKey: 'counter' }).withTypes<{
      synced: CounterState
    }>()
    const slice = own.createSyncedSlice({
      name: 'fixed',
      initialState: counterInitialState,
      reducers: {
        burn: {
          prepare: () => ({
            payload: 1,
            error: { message: 'declared' },
            meta: { hash: '01HFIXED000000000000000000', dispatched: 1_000 },
          }),
          reducer: () => {},
        },
      },
    })

    const action = slice.actions.burn()
    expect(action.meta.hash).toBe('01HFIXED000000000000000000')
    expect(action.meta.dispatched).toBe(1_000)
    expect(action.error).toEqual({ message: 'declared' })
  })

  it('getInitialState が initialState を返す', () => {
    expect(counterSlice.getInitialState()).toEqual(counterInitialState)
  })

  it('extraReducers は他所で定義された synced action への追従を受ける (RTK 同義)', () => {
    const own = defineSynqux({ syncedKey: 'counter' }).withTypes<{
      synced: CounterState
    }>()
    // slice 外・横断 action は createSyncedAction で定義し、slice は追従するだけ
    const boost = own.createSyncedAction<number>('shared/boost')
    const slice = own.createSyncedSlice({
      name: 'extra',
      initialState: counterInitialState,
      reducers: {},
      extraReducers: (builder) => {
        builder.addCase(boost, (state, action) => {
          state.count += action.payload
        })
      },
    })

    expect(slice.reducer(undefined, boost(4)).count).toBe(4)
    // 登録は追従先 creator の定義側が担っている (slice は action を定義しない)
    expect(own.isSyncedAction({ type: 'shared/boost' })).toBe(true)
  })
})

describe('createSyncedSlice (end-to-end)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('slice だけで request 化 → host 裁定 → 全端末適用が成立する', async () => {
    const hub = createMemoryHub()

    const createClient = () => {
      // 二相 API: 定義 (defineSynqux) の createSynqux が配線まで内部化する
      const sync = kit.createSynqux({
        transport: hub.createTransport(),
        synced: counterSlice.reducer,
        locals: {},
      })
      const store = configureStore({
        reducer: sync.rootReducer,
        middleware: (getDefaultMiddleware) =>
          getDefaultMiddleware().prepend(...sync.middlewares),
      })
      return { sync, store }
    }

    const a = createClient()
    const b = createClient()

    await a.sync.subscribe({ store: a.store, groupId: 'slice-group' })
    await b.sync.subscribe({ store: b.store, groupId: 'slice-group' })
    await settle()

    a.store.dispatch(add(5))
    await settle()

    expect(a.store.getState().counter.count).toBe(5)
    expect(b.store.getState().counter.count).toBe(5)

    // 受理 action には host 採番の seq が焼かれている
    expect(hub.inspect.requests('slice-group')[0]?.seq).toBe(1)
  })
})

describe('createSyncedSlice validate / mutate 記法 (ADR-0031)', () => {
  const slice = kit.createSyncedSlice({
    name: 'validated',
    initialState: counterInitialState,
    reducers: {
      add: {
        validate: (state, payload: number, meta) => {
          if (state.count + payload > 10) return 'over'
          // 時刻の条件は meta があるときだけ評価する (SPEC-0001 ガイドライン)
          if (meta && meta.dispatched < 100)
            return { message: { text: 'early' } }
          return null
        },
        mutate: (state, action) => {
          state.count += action.payload
        },
      },
      reset: {
        mutate: (state) => {
          state.count = 0
        },
      },
      launch: {
        prepare: (label: string, value: number) => ({
          payload: { label, value },
          meta: { source: 'test' },
        }),
        validate: (_state, payload) => (payload.value < 0 ? 'negative' : null),
        mutate: (state, action) => {
          state.count = action.payload.value
        },
      },
    },
  })

  it('string の拒否は log 専用の error result を積み、state を変えない', () => {
    expect(slice.actions.add.validate(counterInitialState, 11)).toBe('over')

    const rejected = slice.reducer(undefined, slice.actions.add(11))
    expect(rejected.count).toBe(0)
    expect(rejected.result).toMatchObject({ type: 'error', log: 'over' })
    expect(rejected.result?.message).toBeUndefined()
  })

  it('object の拒否は withErrorResult の option として message を積む', () => {
    const action = slice.actions.add(1)
    action.meta.dispatched = 0

    const rejected = slice.reducer(undefined, action)
    expect(rejected.count).toBe(0)
    expect(rejected.result).toMatchObject({
      type: 'error',
      message: { text: 'early' },
    })
  })

  it('validate が null なら mutate を適用する', () => {
    expect(slice.reducer(undefined, slice.actions.add(2)).count).toBe(2)
  })

  it('validate 省略時も creator は validate を持ち、常に null を返す', () => {
    expect(slice.actions.reset.validate(counterInitialState, undefined)).toBe(
      null,
    )
    expect(
      slice.reducer({ ...counterInitialState, count: 5 }, slice.actions.reset())
        .count,
    ).toBe(0)
    expectTypeOf(slice.actions.reset).parameters.toEqualTypeOf<[]>()
  })

  it('prepare 付きは prepare の引数・戻りを使い、payload は prepare から推論する', () => {
    const action = slice.actions.launch('test', 3)
    expectTypeOf(slice.actions.launch).parameters.toEqualTypeOf<
      [label: string, value: number]
    >()
    expect(action.meta.source).toBe('test')
    expect(slice.reducer(undefined, action).count).toBe(3)
    expect(
      slice.actions.launch.validate(counterInitialState, {
        label: 'x',
        value: -1,
      }),
    ).toBe('negative')
  })

  it('型: payload は validate 第 2 引数 → mutate 注釈の順に推論する', () => {
    const inferred = kit.createSyncedSlice({
      name: 'inferred',
      initialState: counterInitialState,
      reducers: {
        fromValidate: {
          validate: (_state, payload: number) => (payload < 0 ? 'neg' : null),
          // slice 記法では mutate 内の action は注釈が無いと any (RTK の case
          // reducer と同じ)。推論が効くのは生成 creator と validate の側
          mutate: (state, action) => {
            state.count += action.payload
          },
        },
        fromMutate: {
          validate: (_state) => null,
          mutate: (state, action: SyncedAction<number | undefined>) => {
            state.count += action.payload ?? 1
          },
        },
      },
    })

    expectTypeOf(inferred.actions.fromValidate).parameters.toEqualTypeOf<
      [payload: number]
    >()
    expectTypeOf(inferred.actions.fromValidate.validate)
      .parameter(1)
      .toBeNumber()
    expectTypeOf(inferred.actions.fromMutate).parameters.toEqualTypeOf<
      [payload?: number | undefined]
    >()
    expect(inferred.actions.fromValidate(1).payload).toBe(1)
  })

  it('型: validate と mutate の payload 注釈の食い違いは型エラー', () => {
    const mismatch = kit.createSyncedSlice({
      name: 'mismatch',
      initialState: counterInitialState,
      reducers: {
        bad: {
          validate: (_state, _payload: number) => null,
          // @ts-expect-error validate の number と mutate の string が食い違う
          mutate: (_state, _action: SyncedAction<string>) => {},
        },
      },
    })
    expect(mismatch.name).toBe('mismatch')
  })

  it('型: result を持たない state の slice には validate 記法を書けない', () => {
    const withoutResult = kit.createSyncedSlice({
      name: 'without-result',
      initialState: { count: 0 },
      reducers: {
        bad: {
          // @ts-expect-error 拒否は result で表現するため SynquxSynced 専用
          mutate: (state: { count: number }) => {
            state.count = 1
          },
        },
      },
    })
    expect(withoutResult.name).toBe('without-result')
  })
})

describe('createSyncedSlice validate / mutate 記法 (prepare の整合)', () => {
  it('型: prepare 付きは prepare の payload を validate / mutate に押し付ける', () => {
    const mismatch = kit.createSyncedSlice({
      name: 'prepared-mismatch',
      initialState: counterInitialState,
      reducers: {
        bad: {
          prepare: (value: string) => ({ payload: Number(value) }),
          // @ts-expect-error prepare の number と mutate の string が食い違う
          mutate: (_state, _action: SyncedAction<string>) => {},
        },
      },
    })
    expect(mismatch.name).toBe('prepared-mismatch')
  })
})
