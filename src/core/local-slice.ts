import {
  createSlice,
  type Action,
  type Draft,
  type Slice,
  type SliceCaseReducers,
  type UnknownAction,
  type ValidateSliceCaseReducers,
} from '@reduxjs/toolkit'
import type { LocalAction } from './action.js'

type IsAny<T> = 0 extends 1 & T ? true : false

/** locals reducer が受ける meta (root は rootReducer が注入、TMeta は consumer 拡張) */
type LocalActionMeta<TRoot, TMeta extends object> = { root?: TRoot } & TMeta

/**
 * meta 型の root を TRoot へ**置換**する (交差ではなく)。
 * synced creator の meta は既に `root?: any` を持つため、交差では
 * `any & TRoot = any` に潰れて型が付かない — Omit で外してから足す。
 * meta 全体が any の場合も同様に潰れるため IsAny で丸ごと差し替える
 */
type ReplacedMeta<M, TRoot, TMeta extends object> =
  IsAny<M> extends true
    ? LocalActionMeta<TRoot, TMeta>
    : ReplacedKnownMeta<Exclude<M, undefined>, TRoot, TMeta>

/**
 * naked conditional で meta の union にも分配して root を置換する
 * (直接 Omit すると union が共通キーへ縮む。prepare 拡張 meta の判別 union 対策)
 */
type ReplacedKnownMeta<M, TRoot, TMeta extends object> = M extends unknown
  ? Omit<M, 'root'> & LocalActionMeta<TRoot, TMeta>
  : never

/**
 * action 型を「locals reducer から見た形」へ変換する: meta.root を TRoot へ
 * 置換し、consumer 拡張 meta (TMeta) を合流させる。runtime の
 * createSynquxRootReducer (withRootMeta) が locals へ渡す前に root を
 * 上書き注入する事実を型に写したもの。
 * naked type param の conditional のため union (domain action union) にも分配される
 */
export type WithLocalMeta<A, TRoot, TMeta extends object = object> = A extends {
  meta: infer M
}
  ? Omit<A, 'meta'> & { meta: ReplacedMeta<M, TRoot, TMeta> }
  : A extends { meta?: infer M }
    ? Omit<A, 'meta'> & { meta?: ReplacedMeta<M, TRoot, TMeta> }
    : A & { meta?: LocalActionMeta<TRoot, TMeta> }

/**
 * boolean matcher / addDefaultCase 用の「未特定 action の locals view」。
 * UnknownAction を Omit で崩すと index signature に畳まれて `type: string` を
 * 失うため、こちらは交差で meta だけ重ねる (index signature の meta: unknown
 * との交差は宣言側が勝ち root?: TRoot で読める)
 */
export type LocalUnknownAction<
  TRoot,
  TMeta extends object = object,
> = UnknownAction & { meta?: LocalActionMeta<TRoot, TMeta> }

/** RTK createSlice の case reducer と同じ契約 (immer draft / 返却どちらも可) */
type LocalCaseReducer<TState, A> = (
  state: Draft<TState>,
  action: A,
) => TState | void | Draft<TState>

type TypedActionCreator<T extends string = string> = {
  (...args: any[]): Action<T>
  type: T
}

type TypeGuard<A> = (value: any) => value is A

/**
 * addMatcher 以降 (RTK 同様、addCase は宣言順制約で呼べなくなる)
 */
export type LocalMatcherBuilder<
  TState,
  TRoot,
  TMeta extends object = object,
> = {
  /**
   * guard matcher は narrow 先 A の root を置換して受ける。
   * boolean matcher は LocalUnknownAction として受ける
   */
  addMatcher<A>(
    // boolean 側の (action: any) は RTK 踏襲 — union の contextual typing で
    // 引数注釈なしの lambda を受けるための妥協 (UnknownAction だと TS7006)
    matcher: TypeGuard<A> | ((action: any) => boolean),
    reducer: LocalCaseReducer<
      TState,
      unknown extends A
        ? LocalUnknownAction<TRoot, TMeta>
        : // RTK 同様、非 Action 型の guard でも type を落とさない正規化 (A & Action)
          WithLocalMeta<A extends Action ? A : A & Action, TRoot, TMeta>
    >,
  ): LocalMatcherBuilder<TState, TRoot, TMeta>

  addDefaultCase(
    reducer: LocalCaseReducer<TState, LocalUnknownAction<TRoot, TMeta>>,
  ): {}
}

/**
 * locals slice の extraReducers builder。RTK ActionReducerMapBuilder の
 * **対応 subset**: addCase (creator / type 文字列) / addMatcher (guard /
 * boolean) / addDefaultCase。**addAsyncThunk は対応外** (locals の thunk 追従は
 * isPending 等の matcher で書ける)。runtime は RTK の builder そのもので、
 * 型だけが「locals reducer には meta.root が渡る」契約 (ADR-0001 Decision 8)
 * を写している
 */
export type LocalReducerBuilder<
  TState,
  TRoot,
  TMeta extends object = object,
> = LocalMatcherBuilder<TState, TRoot, TMeta> & {
  addCase<AC extends TypedActionCreator>(
    creator: AC,
    reducer: LocalCaseReducer<
      TState,
      WithLocalMeta<ReturnType<AC>, TRoot, TMeta>
    >,
  ): LocalReducerBuilder<TState, TRoot, TMeta>
  addCase<TType extends string, A extends Action<TType>>(
    type: TType,
    reducer: LocalCaseReducer<TState, WithLocalMeta<A, TRoot, TMeta>>,
  ): LocalReducerBuilder<TState, TRoot, TMeta>
}

/**
 * buildCreateLocalSlice の戻り (RTK createSlice の locals 版)。
 * options は RTK createSlice の **subset** (`{ name, initialState, reducers,
 * extraReducers? }`): reducers は object 記法のみ (RTK 2.x callback creators
 * 非対応。createSyncedSlice と同じ線引き)、selectors / reducerPath は非対応。
 * 生成される slice / actions / reducer は RTK そのもの
 */
export type CreateLocalSlice<TRoot, TMeta extends object = object> = <
  TState,
  TReducers extends SliceCaseReducers<TState>,
  TName extends string,
>(options: {
  name: TName
  initialState: TState | (() => TState)
  /** case reducer の action は LocalAction<P> 注釈で payload を宣言する (RTK 同様、自動推論はない) */
  reducers: ValidateSliceCaseReducers<TState, TReducers>
  /** 他所で定義された action への追従 (RTK 同義)。action に meta.root が型付きで乗る */
  extraReducers?: (builder: LocalReducerBuilder<TState, TRoot, TMeta>) => void
}) => Slice<TState, TReducers, TName>

/**
 * 束縛済み CreateLocalSlice から locals reducer の注釈型を導出する。
 * TRoot / TMeta の供給点を buildCreateLocalSlice の束縛 1 箇所に保つための
 * 逆引き (consumer が LocalAction の型引数を二重に書かないため)
 *
 * @example
 * export const createLocalSlice = buildCreateLocalSlice<RootState, AppMeta>()
 * export type AppLocalAction<P = void> = LocalActionOf<typeof createLocalSlice, P>
 */
export type LocalActionOf<C, P = void> =
  C extends CreateLocalSlice<infer TRoot, infer TMeta extends object>
    ? LocalAction<P, TRoot, TMeta>
    : never

/**
 * locals slice 用 createSlice factory (RTK buildCreateSlice の命名慣習)。
 * runtime は RTK createSlice への素通しで、仕事は型だけ — extraReducers の
 * builder を LocalReducerBuilder として見せ、「locals reducer には meta.root
 * (直前実行後の root state) が渡る」契約 (createSynquxRootReducer) を
 * cast なしで読めるようにする。
 *
 * **defineSynqux からは配らない**: TRoot (consumer の RootState) は配線フェーズ
 * の生成物 (locals 宣言後に導出) で、定義へ焼き込むと定義 const を通る型循環に
 * なる (ADR-0027)。consumer は RootState を導出したファイルの近くで 1 回だけ
 * 束縛する:
 *
 * @example
 * // consumer のセットアップ層 (束縛はこの 1 箇所だけ)
 * export const createLocalSlice =
 *   buildCreateLocalSlice<RootState, { throttleless?: true }>()
 * export type AppLocalAction<P = void> =
 *   LocalActionOf<typeof createLocalSlice, P>
 *
 * ⚠️ root は synqux rootReducer 配下でのみ注入される — creator 単体生成や
 * slice reducer の単体実行では存在しないため型上も optional。初期化中や
 * locals 宣言順の後続 slice など「完全な root が揃わない」ケースの null 安全は
 * consumer 側のガードが担う (既存の meta.root 契約のまま)。
 * ⚠️ TMeta のフィールドは synqux が実在を保証しない (注入するのは root のみ) —
 * middleware 等で常時付与しない限り **optional で宣言する**こと
 */
export const buildCreateLocalSlice = <
  TRoot = unknown,
  TMeta extends object = object,
>(): CreateLocalSlice<TRoot, TMeta> =>
  createSlice as unknown as CreateLocalSlice<TRoot, TMeta>
