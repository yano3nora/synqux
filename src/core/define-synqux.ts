import {
  createSlice,
  type Action,
  type ActionCreatorWithPreparedPayload,
  type ActionReducerMapBuilder,
  type Draft,
  type PrepareAction,
  type Reducer,
} from '@reduxjs/toolkit'
import {
  createSyncedAction,
  normalizeSyncedActionMeta,
  type CreateSyncedAction,
  type PreparedMetaOf,
  type SyncedAction,
  type SyncedActionMeta,
} from './action.js'
import {
  createSynqux,
  type CreateSynquxConfig,
  type Synqux,
} from './create-synqux.js'
import { createSyncedActionMatchers } from './matchers.js'
import {
  generateResult,
  stateWithError,
  stateWithResult,
  stateWithTransaction,
} from './results.js'
import {
  createSynquxRootReducer,
  type SynquxRootState,
} from './root-reducer.js'
import type { SynquxState } from './slice.js'
import type { ResultMessage, SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * defineSynqux(...).withTypes へ渡す consumer の型セット (ADR-0026)
 *
 * root は含まない — root state は配線フェーズ (definition.createSynqux) が
 * syncedKey + synced reducer + locals から導出するため、consumer が SynquxState
 * を import して root を手書きする必要はない
 */
export type SynquxTypes = {
  /** consumer の synced state (SynquxSynced を満たすこと) */
  synced: SynquxSynced<any, any>
  /** Result.message の拡張型。省略時は { text } (ResultMessage) */
  message?: ResultMessage
}

type MessageOf<T extends SynquxTypes> = T['message'] extends ResultMessage
  ? T['message']
  : ResultMessage

/**
 * T['synced'] の Result 束縛から consumer の synced action union を推論する。
 * 手書き predicate が担っていた domain 型 (dispatchAndWait / automations /
 * listeners の TAction) を registry 述語でも失わないための narrow 先。
 *
 * この narrow の正しさは「registry へ登録した creator の action ⊆ この union」
 * という consumer の宣言整合に依存する (手書き predicate の `a is DomainAction`
 * と同じ契約)。union 外の creator を登録した時点で、受理 action が積まれる
 * Result<A> の型宣言自体が破綻しているため、これは narrow が新設する義務では
 * なく synced state 型宣言の既存義務である
 */
type SyncedActionOf<T extends SynquxTypes> =
  T['synced'] extends SynquxSynced<infer A, any>
    ? A extends Action
      ? A
      : SyncedAction<any>
    : SyncedAction<any>

/**
 * 定義フェーズ時点で判明している部分 root (予約 slice + synced subtree)。
 * creators / matchers の meta.root 型に使う — locals は配線フェーズまで未知の
 * ため含まれない。sibling locals まで読む文脈は LocalAction<P, TRoot> 注釈
 * (TRoot は導出 RootState) を使う
 */
type DefinedRootOf<TKey extends string, T extends SynquxTypes> = {
  synqux: SynquxState
} & Record<TKey, T['synced']>

/**
 * matchers の narrow 先: domain union に加え、locals 文脈で実在する
 * meta.root を部分 root で焼き直したもの
 */
type MatchedSyncedActionOf<
  TKey extends string,
  T extends SynquxTypes,
> = SyncedActionOf<T> & SyncedAction<any, DefinedRootOf<TKey, T>>

/** createSyncedSlice の case reducer (RTK 同様 immer draft を受ける) */
type SyncedSliceCaseReducer<TState> = (
  state: Draft<TState>,
  action: any,
) => TState | void | Draft<TState>

/**
 * createSyncedSlice の reducers に書ける case 定義。
 * plain case reducer と `{ prepare, reducer }` の 2 記法のみサポートする
 * (RTK 2.x の callback creators (create.asyncThunk 等) は非対応)
 */
export type SyncedSliceCaseReducers<TState> = Record<
  string,
  | SyncedSliceCaseReducer<TState>
  | {
      prepare: PrepareAction<any>
      reducer: SyncedSliceCaseReducer<TState>
    }
>

/**
 * case 定義から生成される synced action creator の型を導出する。
 * plain 記法は case reducer の action 注釈 (PayloadAction<P> / SyncedAction<P>
 * どちらでも) から payload を推論し、prepare 記法は prepare の引数・戻りに従う。
 * いずれも戻り action は required な SyncedActionMeta を持つ (生成時 stamp)
 */
type SyncedSliceActionCreator<
  TCase,
  TType extends string,
  TRoot,
> = TCase extends { prepare: infer PA extends PrepareAction<any> }
  ? ActionCreatorWithPreparedPayload<
      Parameters<PA>,
      ReturnType<PA>['payload'],
      TType,
      ReturnType<PA> extends { error: infer E } ? E : never,
      PreparedMetaOf<PA> & SyncedActionMeta<TRoot>
    >
  : TCase extends (state: any, action: infer A) => any
    ? A extends { payload: infer P }
      ? ActionCreatorWithPreparedPayload<
          [P] extends [void]
            ? []
            : undefined extends P
              ? [payload?: P]
              : [payload: P],
          P,
          TType,
          never,
          SyncedActionMeta<TRoot>
        >
      : ActionCreatorWithPreparedPayload<
          [],
          void,
          TType,
          never,
          SyncedActionMeta<TRoot>
        >
    : never

/**
 * RTK createSlice の synced 版 (ADR-0025 Amendment)。**この slice が定義する
 * (= reducers ブロックの) action は全て synced action になる**: 合成した prepare
 * が生成時 stamp を行い、type (`${name}/${key}`) を registry へ登録する。
 * 「slice が非 synced action を定義する」状態は構造的に書けない。
 *
 * extraReducers は RTK 本来の意味論のまま「他所で定義された action への追従」:
 * slice は action を定義せず、synced かどうかは追従先 creator の定義
 * (createSyncedAction / createSyncedSlice 由来か) が決める。synced state
 * を変える case は synced action にだけ書くこと — local action の case を書くと
 * 端末ごとに分岐する (これは合成 reducer / primitive 方式にも共通する
 * synced reducer 全般の doc 契約であり、本 API 固有の保証ではない)
 */
export type CreateSyncedSlice<TRoot = unknown> = <
  TState,
  TName extends string,
  TReducers extends SyncedSliceCaseReducers<TState>,
>(options: {
  /** action type の prefix。`synqux` (と `synqux/` 配下) は予約のため throw */
  name: TName
  initialState: TState
  reducers: TReducers
  /** 他所で定義された synced action (createSyncedAction 等) への追従 (RTK 同義) */
  extraReducers?: (builder: ActionReducerMapBuilder<TState>) => void
}) => {
  name: TName
  reducer: Reducer<TState>
  actions: {
    [K in keyof TReducers & string]: SyncedSliceActionCreator<
      TReducers[K],
      `${TName}/${K}`,
      TRoot
    >
  }
  getInitialState: () => TState
}

/**
 * 配線フェーズ (definition.createSynqux) の config。
 * core の CreateSynquxConfig から定義側が埋める接続点 (isSyncedAction /
 * rootReducer / selectSynced) を除き、素材 (synced reducer / locals) を受ける
 */
export type DefinedCreateSynquxConfig<
  TRoot extends { synqux: SynquxState },
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
  TLocals extends Record<string, unknown>,
> = Omit<
  CreateSynquxConfig<TRoot, TSynced, TAction>,
  'isSyncedAction' | 'rootReducer' | 'selectSynced'
> & {
  /** 同期対象 reducer (構造上 1 つ。複数ドメインは合成して 1 reducer / slice に畳む) */
  synced: Reducer<TSynced>
  /** 端末ローカル slice 群。宣言順で直列実行される (createSynquxRootReducer と同義) */
  locals: { [K in keyof TLocals]: Reducer<TLocals[K]> }
}

/**
 * defineSynqux が返す定義エンティティの型 (ADR-0026)
 */
export type SynquxDefinition<T extends SynquxTypes, TKey extends string> = {
  /**
   * RTK createAction の同期版。生成時に hash / dispatched を付与し (ADR-0024)、
   * type を registry へ登録する (定義 = 同期対象の宣言)。
   * `synqux/` 予約 prefix の type は定義時に throw で拒否する
   */
  createSyncedAction: CreateSyncedAction<DefinedRootOf<TKey, T>>

  /**
   * RTK createSlice の synced 版。各 case を { reducer, prepare } 記法へ変換
   * して RTK createSlice に委譲し、合成 prepare が生成時 stamp (ADR-0024) と
   * registry 登録を行う。生成 creator の action は全て synced action になる
   */
  createSyncedSlice: CreateSyncedSlice<DefinedRootOf<TKey, T>>

  /**
   * synced domain action の判定述語 (registry 由来)。配線フェーズが内部で
   * 接続するため通常は触らない (primitive 方式で core へ直接渡す場合に使う)
   */
  isSyncedAction: (action: Action) => action is SyncedActionOf<T>

  /**
   * synced subtree の mount key (config の echo)。primitive 方式で
   * createSynquxRootReducer へ直接渡す場合に使う
   */
  syncedKey: TKey

  /**
   * locals reducer 用の成功判定 matcher。「直前に適用された synced action が
   * 成功したか」。isSyncedAction は registry から、selectSynced は syncedKey
   * から束縛済み。meta.root は locals にしか付与されないため locals reducer 専用
   */
  isSucceededAction: (
    action: Action,
  ) => action is MatchedSyncedActionOf<TKey, T>

  /** isSucceededAction + 「依頼元が自端末か」(standalone は成功時 true) */
  isMySucceededAction: (
    action: Action,
  ) => action is MatchedSyncedActionOf<TKey, T>

  /**
   * **配線フェーズ**: transport と素材 (synced reducer / locals) を受けて
   * instance を作る。rootReducer / selectSynced / isSyncedAction の接続は
   * 内部化され、root 型は SynquxRootState<TKey, TSynced, TLocals> として
   * 導出される — consumer の RootState は
   * `ReturnType<typeof synqux.rootReducer>` で得る (手書き root 不要)。
   *
   * group を跨ぐときは instance を作り直す契約 (core と同じ) のため、
   * singleton ではなく都度呼べる factory になっている
   */
  createSynqux: <TLocals extends Record<string, unknown>>(
    config: DefinedCreateSynquxConfig<
      SynquxRootState<TKey, T['synced'], TLocals>,
      T['synced'] & SynquxSynced<SyncedActionOf<T>>,
      SyncedActionOf<T>,
      TLocals
    >,
  ) => Synqux<
    SynquxRootState<TKey, T['synced'], TLocals>,
    SyncedActionOf<T>,
    T['synced']
  >

  /** Result を組む helper (domain 型束縛済み) */
  generateResult: typeof generateResult<SyncedActionOf<T>, MessageOf<T>>
  /** state を変えつつ任意の result を積む helper (domain 型束縛済み) */
  stateWithResult: typeof stateWithResult<
    T['synced'],
    SyncedActionOf<T>,
    MessageOf<T>
  >
  /** validation 失敗を宣言する helper (domain 型束縛済み) */
  stateWithError: typeof stateWithError<
    T['synced'],
    SyncedActionOf<T>,
    MessageOf<T>
  >
  /** 複数段の判定を transaction として畳む helper (domain 型束縛済み) */
  stateWithTransaction: typeof stateWithTransaction<
    T['synced'],
    SyncedActionOf<T>,
    MessageOf<T>
  >

  /**
   * consumer の domain 型を束縛した同一の定義を返す (純粋な型 cast)。
   * registry などの状態は defineSynqux が 1 回だけ作るため、何度呼んでも
   * 同じ定義であり分裂しない
   */
  withTypes: <T2 extends SynquxTypes>() => SynquxDefinition<T2, TKey>
}

/**
 * synqux の**定義フェーズ** (ADR-0026)。synced の mount key を受けて
 * 型付き語彙 (creators / matchers / result helpers) と配線 factory
 * (createSynqux) を配布する。セットアップ層の 1 ファイルで **1 回だけ** 呼び、
 * `.withTypes<T>()` で consumer の domain 型を束縛する。
 *
 * `defineSynqux({...})` が key literal の値推論を、`.withTypes<T>()` が型束縛を
 * それぞれ担う 2 段チェーン (TS は型引数の部分推論を許さないため単一呼び出しに
 * 畳めない)。withTypes は純粋な型 cast で、状態 (registry) は defineSynqux が
 * 1 回だけ作る — 何度呼んでも registry は分裂しない。
 *
 * 定義と配線が二相に分かれるのは構造制約による: reducer モジュールは creator
 * (runtime 関数 + registry 副作用) を module 評価時に import する必要があり、
 * instance (transport / store) と同居させると reducers → instance → reducers の
 * runtime 循環になる。定義フェーズは transport / store に依存しない。
 *
 * 定義は creator registry を持つ: 返した createSyncedAction / createSyncedSlice
 * が action type を登録し、isSyncedAction は「この定義の creator で定義された
 * action か」を type 文字列で判定する (配達 action は封筒から再構築されるため
 * brand ではなく type 照合)。ここから 2 つの契約が生まれる:
 *
 * - **creator と isSyncedAction は同じ定義の戻りから取る**。defineSynqux を
 *   複数回呼ぶと registry が分裂する
 * - **登録は creator 定義モジュールの import 副作用**。synced reducer が
 *   addCase(creator, ...) で creator を静的参照する限り store 構築時に全登録が
 *   済む。creator の lazy import は「ロード前に他端末から届いた action を
 *   synced と判定できない」ため行わないこと
 *
 * @example
 * // 定義フェーズ (reducers はこのファイルだけを import する)
 * export const {
 *   createSyncedAction, createSyncedSlice, isSyncedAction,
 *   isSucceededAction, isMySucceededAction, createSynqux,
 *   generateResult, stateWithError, stateWithResult, stateWithTransaction,
 * } = defineSynqux({ syncedKey: 'game' }).withTypes<{
 *   synced: GameState
 *   message: GameResultMessage
 * }>()
 *
 * // 配線フェーズ (store ファイル)。root 型は導出される
 * export const synqux = createSynqux({
 *   transport: firebaseTransport(db),
 *   synced: gameReducer,
 *   locals: { scenes: scenesReducer },
 * })
 * export type RootState = ReturnType<typeof synqux.rootReducer>
 */
export const defineSynqux = <TKey extends string>(config: {
  /**
   * root 内の synced state の mount key。key の命名は consumer の領域のため
   * 定義に一度だけ教える (供給点はここだけ)。root state は配線フェーズが
   * この key + locals から導出する
   */
  syncedKey: TKey
}): SynquxDefinition<SynquxTypes, TKey> => {
  const registry = new Set<string>()

  // matchers 等の内部束縛用。位置の宣言は syncedKey に一本化したため導出する
  const selectSynced = (root: Record<string, unknown>): unknown =>
    root[config.syncedKey]

  // narrow 先 (SyncedActionOf) は SynquxDefinition の型が担う。RTK の
  // creator.match と同じく、実行時は type 文字列照合のみで meta / payload の
  // 実在は検査しない (meta は ADR-0024 Decision 4 の不変条件が全経路で保証する)
  const isSyncedAction = (action: Action): boolean => registry.has(action.type)

  const definition = {
    createSyncedAction: (
      type: string,
      prepareAction?: PrepareAction<unknown>,
    ) => {
      // synqux 内部 action (synqux/restored 等) の registry 汚染を定義時に
      // fail-fast で防ぐ。通れば内部 restore が request 化され同期が壊れる
      if (type.startsWith('synqux/')) {
        throw new Error(
          `createSyncedAction: "${type}" uses the reserved "synqux/" prefix`,
        )
      }

      registry.add(type)
      return (
        createSyncedAction as (
          type: string,
          prepareAction?: PrepareAction<unknown>,
        ) => unknown
      )(type, prepareAction)
    },

    createSyncedSlice: (options: {
      name: string
      initialState: unknown
      reducers: Record<
        string,
        | SyncedSliceCaseReducer<unknown>
        | {
            prepare: PrepareAction<unknown>
            reducer: SyncedSliceCaseReducer<unknown>
          }
      >
      extraReducers?: (builder: ActionReducerMapBuilder<unknown>) => void
    }) => {
      // 内部 action prefix (synqux/) との type 衝突を定義時に fail-fast で防ぐ。
      // name 'synqux/custom' の生成 type も synqux/ 配下に入るため prefix で拒否
      if (options.name === 'synqux' || options.name.startsWith('synqux/')) {
        throw new Error(
          `createSyncedSlice: "${options.name}" is a reserved slice name (internal action prefix)`,
        )
      }

      const reducers = Object.fromEntries(
        Object.entries(options.reducers).map(([key, caseDef]) => {
          registry.add(`${options.name}/${key}`)

          const caseReducer =
            typeof caseDef === 'function' ? caseDef : caseDef.reducer
          const prepare =
            typeof caseDef === 'function' ? undefined : caseDef.prepare

          return [
            key,
            {
              reducer: caseReducer,
              // createSyncedAction と同じ生成時 stamp を prepare に合成する。
              // consumer の prepare が焼いた hash / dispatched は尊重される
              prepare: (...args: unknown[]) => {
                const prepared = prepare
                  ? prepare(...args)
                  : { payload: args[0] }

                return {
                  ...prepared,
                  meta: normalizeSyncedActionMeta(
                    (prepared as { meta?: SynquxActionMeta }).meta,
                  ),
                }
              },
            },
          ]
        }),
      )

      return (createSlice as (config: unknown) => unknown)({
        name: options.name,
        initialState: options.initialState,
        reducers,
        extraReducers: options.extraReducers,
      })
    },

    isSyncedAction,
    syncedKey: config.syncedKey,

    ...createSyncedActionMatchers({
      isSyncedAction: isSyncedAction as (action: Action) => action is Action,
      selectSynced: selectSynced as (root: {
        synqux: SynquxState
      }) => SynquxSynced,
    }),

    createSynqux: (instanceConfig: {
      synced: Reducer<SynquxSynced>
      locals: Record<string, Reducer<unknown>>
    }) => {
      const { synced, locals, ...rest } = instanceConfig

      return createSynqux({
        ...rest,
        ...createSynquxRootReducer({
          isSyncedAction: isSyncedAction as (
            action: Action,
          ) => action is Action,
          syncedKey: config.syncedKey,
          synced,
          locals,
        }),
      } as never)
    },

    generateResult,
    stateWithResult,
    stateWithError,
    stateWithTransaction,

    // 純粋な型 cast: 状態は defineSynqux が作った 1 つだけ (分裂しない)
    withTypes: () => definition,
  }

  // runtime は素通しで組み、公開契約は SynquxDefinition の手書き型が担う
  // (kit 以来の「境界で cast」方式)
  return definition as unknown as SynquxDefinition<SynquxTypes, TKey>
}
