import {
  createAction,
  type ActionCreatorWithPreparedPayload,
  type PayloadAction,
  type PrepareAction,
} from '@reduxjs/toolkit'
import { monotonicFactory, ulid } from 'ulid'
import type { SynquxActionMeta } from './types.js'

/**
 * synced action の公開一意識別子 (ADR-0024)
 *
 * ulid (26 文字 Crockford base32)。生成後は request 封筒で運ばれ全端末同値に
 * なるため、consumer は同期 state の識別子 (record key 等) にそのまま使ってよい。
 * 同一端末内の生成順で辞書順単調 (monotonic) だが、**端末間の適用順の正は
 * あくまで seq** — hash の辞書順を端末を跨いだ順序判定に使わないこと
 */
export type SyncedActionHash = string

const monotonic = monotonicFactory()

/** synced action の hash (ulid) を採番する */
export const generateActionHash = (): SyncedActionHash => {
  try {
    return monotonic()
  } catch (error) {
    // monotonic factory は同一 ms 内の乱数 increment 溢れで throw し得る。
    // 発生時は端末内 sortable を捨てて一意 ID の発行を優先する
    console.warn(error)
    return ulid()
  }
}

/**
 * hash / dispatched の不変条件 (string / number) を typeof で検証しつつ補完する。
 * creator (createSyncedAction) / metaSetter middleware / テストハーネスが共有する
 * 唯一の正規化点 — 型を欺いた不正値 (数値 hash 等) もここで正しい採番へ倒す
 */
export const normalizeSyncedActionMeta = (
  meta: SynquxActionMeta | undefined,
): SynquxActionMeta & { hash: string; dispatched: number } => ({
  ...meta,
  hash:
    typeof meta?.hash === 'string' && meta.hash !== ''
      ? meta.hash
      : generateActionHash(),
  dispatched:
    typeof meta?.dispatched === 'number' ? meta.dispatched : Date.now(),
})

/**
 * synced reducer が受ける action の meta (consumer の常用型、ADR-0024)
 *
 * createSyncedAction が生成時に hash / dispatched を付与するため required。
 * ゲーム判定に使ってよいのは hash / requestedBy / dispatched。response 系
 * (responsedBy / responsed / epoch / seq) は診断専用 (SynquxActionMeta 参照)。
 * root は locals reducer にのみ渡る (synced reducer では常に undefined)
 */
export type SyncedActionMeta<TRoot = unknown> = Omit<SynquxActionMeta, 'root'> &
  Required<Pick<SynquxActionMeta, 'hash' | 'dispatched'>> & { root?: TRoot }

/**
 * synced action 型 (createSyncedAction の生成物)。listener / result 束縛など
 * 「payload を特定しない synced action」を受ける箇所の注釈に使う
 */
export type SyncedAction<P = any, TRoot = unknown> = PayloadAction<P> & {
  meta: SyncedActionMeta<TRoot>
}

/**
 * locals slice の reducers で `PayloadAction<P>` の代わりに使う注釈型
 *
 * locals reducer には createSynquxRootReducer が meta.root (直前実行後の
 * root state) を付与する (ADR-0001 Decision 8)。TMeta は consumer 固有の
 * dispatch 時 meta 拡張 (throttle 除外フラグ等) の差し込み口
 */
export type LocalAction<
  P = void,
  TRoot = unknown,
  TMeta extends object = object,
> = PayloadAction<P> & {
  meta?: { root?: TRoot } & TMeta
}

/** prepare が返した meta から synqux の予約 field を除いた consumer 拡張部分 */
export type PreparedMetaOf<PA extends PrepareAction<any>> =
  ReturnType<PA> extends { meta: infer M }
    ? M extends object
      ? Omit<M, keyof SynquxActionMeta>
      : object
    : object

/**
 * createSyncedAction の型。RTK createAction の**主要 2 overload (payload /
 * prepare callback) 互換**で、生成される action 型に meta: SyncedActionMeta が
 * 乗る (builder.addCase が meta 込みで推論するため、consumer は reducer 側で
 * action 型を注釈しなくてよい)。RTK の PayloadActionCreator が持つ特殊な
 * 条件分岐 (any / unknown payload の推論細部) までは再現しない
 */
export type CreateSyncedAction<TRoot = unknown> = {
  <P = void, T extends string = string>(
    type: T,
  ): ActionCreatorWithPreparedPayload<
    [P] extends [void]
      ? []
      : undefined extends P
        ? [payload?: P]
        : [payload: P],
    P,
    T,
    never,
    SyncedActionMeta<TRoot>
  >
  <PA extends PrepareAction<any>, T extends string = string>(
    type: T,
    prepareAction: PA,
  ): ActionCreatorWithPreparedPayload<
    Parameters<PA>,
    ReturnType<PA>['payload'],
    T,
    ReturnType<PA> extends { error: infer E } ? E : never,
    PreparedMetaOf<PA> & SyncedActionMeta<TRoot>
  >
}

/**
 * synced action creator を作る (RTK createAction の同期版、ADR-0024 / 0025)
 *
 * hash / dispatched は middleware ではなく **生成時 (prepare 合成) に付与**する。
 * 生成された action はその瞬間から有効な meta を持つため、型は事実の記述であり、
 * reducer 単体テストでも creator の戻りをそのまま使える (stamper 不要)。
 * dispatched は同期時、request 化の時点でサーバ基準時刻に上書きされる。
 *
 * ⚠️ **同一の action オブジェクトを再 dispatch してはならない**: 機構は同一
 * hash の重複排除を行わず、同一 identity の request が二重適用される。再送・
 * 再実行は必ず creator を呼び直すこと (dispatchAndWait は同一 hash の待機中
 * 再発行を明示的に reject する)。
 *
 * prepare callback が meta.hash / meta.dispatched を返した場合はそちらを尊重する
 * (result 照合テスト等で特定 hash を焼き込む用途)。型を欺いた不正値 (数値 hash
 * 等) は normalizeSyncedActionMeta が正しい採番へ倒す
 */
export const createSyncedAction: CreateSyncedAction = ((
  type: string,
  prepareAction?: PrepareAction<unknown>,
) =>
  createAction(type, (...args: unknown[]) => {
    const prepared = prepareAction
      ? prepareAction(...args)
      : { payload: args[0] }

    return {
      ...prepared,
      meta: normalizeSyncedActionMeta(
        (prepared as { meta?: SynquxActionMeta }).meta,
      ),
    }
  })) as CreateSyncedAction
