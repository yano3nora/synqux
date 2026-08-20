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
import { createSyncedActionMatchers } from './matchers.js'
import {
  generateResult,
  stateWithError,
  stateWithResult,
  stateWithTransaction,
} from './results.js'
import type { SynquxState } from './slice.js'
import type { ResultMessage, SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * createSynquxKit へ渡す consumer の型セット (ADR-0025)
 */
export type SynquxKitTypes = {
  /** consumer の synced state (SynquxSynced を満たすこと) */
  synced: SynquxSynced<any, any>
  /** consumer の root state (synqux 予約 slice を含む) */
  root: { synqux: SynquxState }
  /** Result.message の拡張型。省略時は { text } (ResultMessage) */
  message?: ResultMessage
}

type MessageOf<T extends SynquxKitTypes> = T['message'] extends ResultMessage
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
type SyncedActionOf<T extends SynquxKitTypes> =
  T['synced'] extends SynquxSynced<infer A, any>
    ? A extends Action
      ? A
      : SyncedAction<any>
    : SyncedAction<any>

/**
 * matchers の narrow 先: domain union に加え、locals 文脈で実在する
 * meta.root を T['root'] で焼き直したもの
 */
type MatchedSyncedActionOf<T extends SynquxKitTypes> = SyncedActionOf<T> &
  SyncedAction<any, T['root']>

/**
 * T['root'] のうち synced state (T['synced']) が mount されている key の候補。
 * kit へ渡す syncedKey を「型整合する key」に制限する (typo や型の合わない
 * key の誤配線をコンパイル時に落とす。構造的に同型な別 key までは区別できない
 * ため、最終的な正しさは consumer が指定するリテラルが担う)
 */
type SyncedKeyOf<T extends SynquxKitTypes> = {
  [K in keyof T['root'] & string]: T['root'][K] extends T['synced'] ? K : never
}[keyof T['root'] & string]

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
 * が生成時 stamp を行い、type (`${name}/${key}`) を kit registry へ登録する。
 * 「slice が非 synced action を定義する」状態は構造的に書けない。
 *
 * extraReducers は RTK 本来の意味論のまま「他所で定義された action への追従」:
 * slice は action を定義せず、synced かどうかは追従先 creator の定義
 * (kit の createSyncedAction / createSyncedSlice 由来か) が決める。synced state
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
 * consumer の domain 型を一度だけ束縛し、型付き語彙を配布する kit factory
 * (ADR-0025、registry 導入と factory 化は同 ADR の Amendment)
 *
 * consumer はこれをセットアップ層の 1 ファイルで **1 回だけ** 呼び、synqux 由来の
 * generics 再束縛 wrapper も synced domain の手書き述語も自作しない。
 *
 * kit は creator registry を持つ: 返した createSyncedAction が action type を
 * 登録し、isSyncedAction は「この kit の creator で定義された action か」を
 * type 文字列で判定する (配達 action は封筒から再構築されるため brand ではなく
 * type 照合)。ここから 2 つの契約が生まれる:
 *
 * - **creator と isSyncedAction は同じ kit の戻りから取る**。kit を複数回作ると
 *   registry が分裂する
 * - **登録は creator 定義モジュールの import 副作用**。synced reducer が
 *   addCase(creator, ...) で creator を静的参照する限り store 構築時に全登録が
 *   済む。creator の lazy import は「ロード前に他端末から届いた action を
 *   synced と判定できない」ため行わないこと
 *
 * @example
 * export const {
 *   syncedKey, isSyncedAction,
 *   createSyncedAction, createSyncedSlice,
 *   isSucceededAction, isMySucceededAction,
 *   generateResult, stateWithError, stateWithResult, stateWithTransaction,
 * } = createSynquxKit<{
 *   synced: GameState
 *   root: RootState
 *   message: GameResultMessage
 * }>({
 *   syncedKey: 'game',
 * })
 */
export const createSynquxKit = <T extends SynquxKitTypes>(config: {
  /**
   * root 内の synced state の mount key。synced key の命名は consumer の領域の
   * ため kit に一度だけ教え、createSynquxRootReducer へは kit の戻りの
   * `syncedKey` をそのまま渡す (供給点はここだけ)。T['root'][K] = T['synced']
   * を満たす key だけが型で許可される
   */
  syncedKey: SyncedKeyOf<T>
}) => {
  const registry = new Set<string>()

  // matchers 等の内部束縛用。位置の宣言は syncedKey に一本化したため導出する
  const selectSynced = (root: T['root']): T['synced'] =>
    root[config.syncedKey as keyof T['root']] as T['synced']

  // narrow 先は T['synced'] から推論した domain action union。RTK の
  // creator.match と同じく、実行時は type 文字列照合のみで meta / payload の
  // 実在は検査しない (meta は ADR-0024 Decision 4 の不変条件が全経路で保証する)。
  // T['root'] は含めない: 判定対象の action は dispatch / request 配達時点の
  // もので meta.root を持たない (root 込みの型が要る文脈は matchers が担う)
  const isSyncedAction = (action: Action): action is SyncedActionOf<T> =>
    registry.has(action.type)

  return {
    /**
     * RTK createAction の同期版。生成時に hash / dispatched を付与し (ADR-0024)、
     * type を kit の registry へ登録する (定義 = 同期対象の宣言)
     */
    createSyncedAction: ((
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
    }) as CreateSyncedAction<T['root']>,

    /**
     * RTK createSlice の synced 版。各 case を { reducer, prepare } 記法へ変換
     * して RTK createSlice に委譲し、合成 prepare が生成時 stamp (ADR-0024) と
     * registry 登録を行う。生成 creator の action は全て synced action になる
     */
    createSyncedSlice: ((options: {
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
    }) as CreateSyncedSlice<T['root']>,

    /**
     * synced domain action の判定述語 (registry 由来)。createSynquxRootReducer /
     * createSynqux の config へそのまま渡す
     */
    isSyncedAction,

    /**
     * synced subtree の mount key (config の echo)。createSynquxRootReducer の
     * `syncedKey` へそのまま渡す
     */
    syncedKey: config.syncedKey,

    /**
     * locals reducer 用の成功判定 matcher 群 (isSucceededAction /
     * isMySucceededAction)。isSyncedAction は registry から、selectSynced は
     * syncedKey から束縛済みのため、そのまま使える
     */
    ...createSyncedActionMatchers<
      MatchedSyncedActionOf<T>,
      T['synced'],
      T['root']
    >({
      // matchers の narrow 先 (locals 文脈) では meta.root が実在するため、
      // ここでだけ root 型を焼き直す (代入点のみ dirty にする)
      isSyncedAction: isSyncedAction as (
        action: Action,
      ) => action is MatchedSyncedActionOf<T>,
      selectSynced,
    }),

    // results 系の action 束縛は SyncedActionOf<T> (state 自身の Result と同じ
    // union)。synced reducer 内で呼ぶ helper のため root 型は含めない
    generateResult: generateResult as typeof generateResult<
      SyncedActionOf<T>,
      MessageOf<T>
    >,

    stateWithResult: stateWithResult as typeof stateWithResult<
      T['synced'],
      SyncedActionOf<T>,
      MessageOf<T>
    >,

    stateWithError: stateWithError as typeof stateWithError<
      T['synced'],
      SyncedActionOf<T>,
      MessageOf<T>
    >,

    stateWithTransaction: stateWithTransaction as typeof stateWithTransaction<
      T['synced'],
      SyncedActionOf<T>,
      MessageOf<T>
    >,
  }
}
