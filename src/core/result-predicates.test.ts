import {
  configureStore,
  createReducer,
  type Action,
  type Reducer,
  type UnknownAction,
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
import type { SyncedActionMeta } from './action.js'
import { defineSynqux } from './define-synqux.js'
import {
  isSucceededResult,
  withDefaultResult,
  withErrorResult,
} from './results.js'
import { createSynquxRootReducer } from './root-reducer.js'
import { selectSelfId } from './selectors.js'
import { createHubClient, settle } from './test-fixtures.js'
import type { SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * result 述語 (isSucceededResult / isMySucceededResult) の検証
 * (TASK-260825。旧 createSyncedActionMatchers の置換)
 *
 * 「chain 内の result は適用中の action のもの」の根拠は pre-stamp (ADR-0013)
 * + 直列 rootReducer (ADR-0001 Decision 8) + result-action 契約の 3 点。
 * ここでは rootReducer と結合した現実的経路でその帰結 (hash 照合なしの判定) を
 * 表明する
 */

type ChainAction = Action<`game/${string}`> & {
  payload?: number
  meta?: SynquxActionMeta
}
type ChainState = SynquxSynced<ChainAction> & {
  count: number
  followUps: number
}

const chainInitial: ChainState = { result: null, count: 0, followUps: 0 }

const isChainAction = (action: Action): action is ChainAction =>
  action.type.startsWith('game/')

const chainReducer = createReducer(chainInitial, (builder) => {
  builder
    .addCase('game/reject', (state, action) =>
      withErrorResult(state as ChainState, action as ChainAction),
    )
    .addCase('game/accept', (state) => {
      state.count += 1
    })
    .addMatcher(isChainAction, (state) => {
      // follow-up matcher の推奨イディオム: 先頭ガード。pre-stamp が直前に
      // 走るため、hash 照合なしで「今回の action の error」を検出できる
      if (!isSucceededResult(state)) {
        return
      }
      state.followUps += 1
    })
})

describe('isSucceededResult (unit)', () => {
  const action: ChainAction = { type: 'game/accept', meta: { hash: 'h1' } }

  it('result null (初期状態) は false、success stamp は true、error は false', () => {
    expect(isSucceededResult({ result: null })).toBe(false)

    const stamped = withDefaultResult({ result: null } as ChainState, action)
    expect(isSucceededResult(stamped)).toBe(true)
    expect(isSucceededResult(withErrorResult(stamped, action))).toBe(false)
  })
})

describe('isSucceededResult (rootReducer chain)', () => {
  type ChainRoot = { game: ChainState }

  const buildRoot = () => {
    let rootSeenByLocal: ChainRoot | null = null

    const root = createSynquxRootReducer({
      isSyncedAction: isChainAction,
      syncedKey: 'game',
      synced: chainReducer as Reducer<ChainState>,
      locals: {
        probe: (state: number = 0, action: Action) => {
          rootSeenByLocal =
            ((action as UnknownAction).meta as { root?: ChainRoot } | undefined)
              ?.root ?? null
          return state + 1
        },
      },
    })

    let state = root.rootReducer(undefined, { type: '@@INIT' })
    const dispatch = (action: Action) => {
      state = root.rootReducer(state, action)
      return state
    }

    return { dispatch, seenByLocal: () => rootSeenByLocal }
  }

  it('synced matcher は case reducer の error を hash 照合なしで検出する', () => {
    const { dispatch } = buildRoot()

    let state = dispatch({ type: 'game/accept' })
    expect(state.game.followUps).toBe(1)

    // 直前の success result が残留していても、pre-stamp → case の error を
    // 後続 matcher がそのまま読める (旧実装の手書き hash 照合の置換)
    state = dispatch({ type: 'game/reject' })
    expect(state.game.result?.type).toBe('error')
    expect(state.game.followUps).toBe(1)

    state = dispatch({ type: 'game/accept' })
    expect(state.game.followUps).toBe(2)
  })

  it('locals は meta.root 経由で同一 chain の result を判定できる', () => {
    const { dispatch, seenByLocal } = buildRoot()

    dispatch({ type: 'game/accept' })
    expect(seenByLocal() && isSucceededResult(seenByLocal()!.game)).toBe(true)

    dispatch({ type: 'game/reject' })
    expect(seenByLocal() && isSucceededResult(seenByLocal()!.game)).toBe(false)
  })

  it('local action の処理中は残留 result を読む (synced action の文脈で呼ぶ契約)', () => {
    const { dispatch, seenByLocal } = buildRoot()
    dispatch({ type: 'game/accept' })

    // 旧 matcher は action アンカーで false にしていた状況。述語は state の
    // 記述のため残留 success を読む — 特定 action への追従は addCase /
    // isSyncedAction matcher の中で呼ぶこと (docstring 契約) の表明
    dispatch({ type: 'ui/open-scene' })
    expect(seenByLocal() && isSucceededResult(seenByLocal()!.game)).toBe(true)
  })
})

/**
 * defineSynqux 束縛版の分散経路検証。requestedBy が request → host 試し実行 →
 * 封筒再構築の全経路で保持されることに isMySucceededResult は依存する
 */

type GameAction = Action<`game/${string}`> & {
  payload?: number
  meta: SyncedActionMeta
}
type GameSynced = SynquxSynced<GameAction> & { count: number }

const definition = defineSynqux({ syncedKey: 'game' }).withTypes<{
  synced: GameSynced
}>()
const increment = definition.createSyncedAction<number>('game/increment')
const reject = definition.createSyncedAction('game/reject')

const gameReducer: Reducer<GameSynced> = (
  state = { result: null, count: 0 },
  action,
) => {
  if (!definition.isSyncedAction(action)) {
    return state
  }

  if (reject.match(action)) {
    // message 付きにして log 専用拒否 (console.error 出力) を避ける
    return definition.withErrorResult(state, action, {
      message: { text: 'rejected' },
    })
  }

  return { ...state, count: state.count + (action.payload ?? 1) }
}

/** locals reducer から meta.root で述語を評価した結果の記録 (実配線と同じ経路) */
type ProbeState = { mine: boolean | null }

const createDefinitionClient = (hub: ReturnType<typeof createMemoryHub>) => {
  const sync = definition.createSynqux({
    transport: hub.createTransport(),
    synced: gameReducer,
    locals: {
      probe: (state: ProbeState = { mine: null }, action: Action) => {
        if (!definition.isSyncedAction(action)) {
          return state
        }

        const root = (
          (action as UnknownAction).meta as
            | { root?: Parameters<typeof definition.isMySucceededResult>[0] }
            | undefined
        )?.root
        return root ? { mine: definition.isMySucceededResult(root) } : state
      },
    },
  })
  const store = configureStore({
    reducer: sync.rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(...sync.middlewares),
  })

  return { sync, store }
}

const GROUP_ID = 'result-predicates'

describe('isMySucceededResult (defineSynqux 束縛)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requestedBy は全経路 (request → 裁定 → 封筒配達) で保持され、依頼元だけ true になる', async () => {
    const hub = createMemoryHub()
    const a = createDefinitionClient(hub)
    const b = createDefinitionClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(increment(2))
    await settle()

    const aState = a.store.getState()
    const bState = b.store.getState()
    expect(definition.isSucceededResult(aState.game)).toBe(true)
    expect(definition.isSucceededResult(bState.game)).toBe(true)
    expect(definition.isMySucceededResult(aState)).toBe(true)
    expect(definition.isMySucceededResult(bState)).toBe(false)

    // locals reducer が meta.root 経由で読んだ判定も端末ごとに一致する
    expect(aState.probe.mine).toBe(true)
    expect(bState.probe.mine).toBe(false)

    // serialize/parse を通った封筒でも requestedBy が保持されている
    // (host 試し実行で失われないことの直接表明)。封筒の result は JSON 文字列
    const serialized = hub.inspect.requests(GROUP_ID)[0]?.result
    const envelopeResult = serialized
      ? (JSON.parse(serialized) as { action?: { meta?: SynquxActionMeta } })
      : null
    expect(envelopeResult?.action?.meta?.requestedBy).toBe(selectSelfId(aState))

    // error result では requestedBy が自分でも false (同期中の拒否 request は
    // そもそも適用されないため、result だけ error に差し替えて条件を表明する)
    const errorState = {
      ...aState,
      game: {
        ...aState.game,
        result: { ...aState.game.result!, type: 'error' as const },
      },
    }
    expect(definition.isMySucceededResult(errorState)).toBe(false)

    // requestedBy 欠落 (契約違反 result 等) は安全側の false
    const withoutRequestedBy = {
      ...aState,
      game: {
        ...aState.game,
        result: {
          ...aState.game.result!,
          action: {
            ...aState.game.result!.action,
            meta: {
              ...aState.game.result!.action.meta,
              requestedBy: undefined,
            },
          },
        },
      },
    }
    expect(definition.isMySucceededResult(withoutRequestedBy)).toBe(false)

    // selfId 未確定 (null) も false
    const withoutSelfId = {
      ...aState,
      synqux: {
        ...aState.synqux,
        connections: { ...aState.synqux.connections, selfId: null },
      },
    }
    expect(definition.isMySucceededResult(withoutSelfId)).toBe(false)
  })

  it('standalone は requestedBy なしでも成功時 true / 失敗時 false', async () => {
    const client = createDefinitionClient(createMemoryHub())
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })

    client.store.dispatch(increment(1))
    expect(definition.isMySucceededResult(client.store.getState())).toBe(true)

    client.store.dispatch(reject())
    expect(definition.isMySucceededResult(client.store.getState())).toBe(false)
  })

  it('restore (途中参加) 直後は result が null 化され、両述語とも false', async () => {
    const hub = createMemoryHub()
    const a = createDefinitionClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle()
    a.store.dispatch(increment(3))
    await settle()

    const late = createDefinitionClient(hub)
    const pending = late.sync.subscribe({
      store: late.store,
      groupId: GROUP_ID,
    })
    await settle()
    await pending

    const lateState = late.store.getState()
    expect(lateState.game.count).toBe(3)
    expect(lateState.game.result).toBeNull()
    expect(definition.isSucceededResult(lateState.game)).toBe(false)
    expect(definition.isMySucceededResult(lateState)).toBe(false)
  })

  it('chain 外は「最後に適用された action の result」— automation の nested dispatch が上書きする', async () => {
    // standalone automation は外側 action の適用後に別 action を発行できる。
    // dispatch が戻ったあとの state.result は内側 action のもの (述語の保証は
    // chain 内のみ、の表明)。automation × dispatchAndWait の複合問題は
    // BACKLOG P1 参照
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      mode: 'standalone',
      localSnapshots: false,
      automations: [
        {
          id: 'announce-after-five',
          retryMs: 100,
          when: (synced) =>
            synced.count >= 5 && !synced.log.includes('announce'),
          action: () => ({ type: 'game/announce' }),
        },
      ],
    })

    // game/announce は log 付き success のため console.log を spy して吸収する
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
      client.store.dispatch({ type: 'game/increment', payload: 5 })
      await settle()

      const game = client.store.getState().game
      expect(game.log).toEqual(['increment:5', 'announce'])
      expect(game.result?.action.type).toBe('game/announce')
      expect(isSucceededResult(game)).toBe(true)
      expect(consoleLog).toHaveBeenCalledWith('announce applied')
    } finally {
      consoleLog.mockRestore()
    }
  })
})

describe('result 述語の型契約', () => {
  it('addMatcher(isSyncedAction, ...) 合成で narrowing が維持される', () => {
    const reducer = createReducer(
      { result: null, count: 0 } as GameSynced,
      (builder) => {
        builder.addMatcher(definition.isSyncedAction, (state, action) => {
          // 旧 matcher の type guard 機能の移行先: narrowing は isSyncedAction
          // が担い、成功判定は state 述語で行う
          expectTypeOf(action).toEqualTypeOf<GameAction>()
          if (!isSucceededResult(state)) {
            return
          }
          state.count += action.payload ?? 0
        })
      },
    )

    expect(reducer(undefined, { type: 'noop' }).count).toBe(0)
  })

  it('isMySucceededResult は root を要求する (synced reducer では物理的に呼べない)', () => {
    expectTypeOf(definition.isMySucceededResult)
      .parameter(0)
      .toMatchTypeOf<{ game: GameSynced }>()
    // synced state 単体は渡せない (決定性境界の型保証)
    expectTypeOf(definition.isMySucceededResult)
      .parameter(0)
      .not.toMatchTypeOf<GameSynced>()
  })

  it('旧 API (matcher / stateWith*) は definition から消えている', () => {
    expectTypeOf(definition).not.toHaveProperty('isSucceededAction')
    expectTypeOf(definition).not.toHaveProperty('isMySucceededAction')
    expectTypeOf(definition).not.toHaveProperty('stateWithError')
    expectTypeOf(definition).not.toHaveProperty('stateWithResult')
    expectTypeOf(definition).not.toHaveProperty('stateWithTransaction')
  })
})
