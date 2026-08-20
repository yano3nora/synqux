import type { Action, Reducer, UnknownAction } from '@reduxjs/toolkit'
import { stateWithDefaultResult } from './results.js'
import { synquxReducer, synquxRestored, type SynquxState } from './slice.js'
import type { SynquxSynced } from './types.js'

/**
 * 「synced reducer は純粋関数、locals は前段参照」の直列 rootReducer helper
 * (ADR-0001 Decision 8。移植元 store.ts の独自 rootReducer と同一セマンティクス)
 *
 * 実行順:
 *   1. synqux 内部 slice
 *   2. synced (meta.root **なし**) — synced domain action は default success result を
 *      stamp してから実行する (ADR-0013)。host の試し実行と各端末での適用が同一
 *      結果になること (決定性) を構成上保証し、端末ローカル state 参照による同期
 *      分岐も構造的に不可能にする
 *   3. locals (**宣言順**、meta.root 付き) — 「適用後の synced state」と
 *      「自分より前に実行された local state」を meta.root で読める
 *
 * consumer 側の注意: RTK の serializableCheck には
 * `ignoredActionPaths: ['meta.root']` の設定が必要 (meta.root は root state
 * そのものを運ぶため)
 */
export type SynquxRootState<
  TSyncedKey extends string,
  TSynced,
  TLocals extends Record<string, unknown>,
> = { synqux: SynquxState } & Record<TSyncedKey, TSynced> & TLocals

export const createSynquxRootReducer = <
  TSyncedKey extends string,
  TAction extends Action,
  TSynced extends SynquxSynced,
  TLocals extends Record<string, unknown>,
>(config: {
  /** default result を付与する synced domain action の判定述語 */
  isSyncedAction: (action: Action) => action is TAction
  /**
   * synced subtree を mount する root 内の key。定義 (defineSynqux) の
   * syncedKey をそのまま渡す — 「synced の位置」の供給点は定義の 1 箇所
   * (通常は定義の配線フェーズが内部で渡す。直接呼ぶのは primitive 方式)
   */
  syncedKey: TSyncedKey
  /**
   * 同期対象 reducer。構造上 1 つのみ (仕様。複数ドメインは合成して 1 reducer /
   * 1 slice に畳み、result を top-level へ写す)
   */
  synced: Reducer<TSynced>
  /** 端末ローカル slice 群。ここに書いた順で直列実行される */
  locals: { [K in keyof TLocals]: Reducer<TLocals[K]> }
}): {
  rootReducer: Reducer<SynquxRootState<TSyncedKey, TSynced, TLocals>>
  selectSynced: (root: SynquxRootState<TSyncedKey, TSynced, TLocals>) => TSynced
  isSyncedAction: (action: Action) => action is TAction
} => {
  // 予約 key state.synqux との衝突を配線時に fail-fast で防ぐ
  if ((config.syncedKey as string) === 'synqux') {
    throw new Error(
      'createSynquxRootReducer: "synqux" is a reserved root key (internal slice mount)',
    )
  }

  // locals は直列進行で { ...acc, [key]: next } と mount するため、syncedKey /
  // 予約 key と同名の local は synced subtree・内部 state を静かに上書きする。
  // 配線時に fail-fast で拒否する
  for (const key of Object.keys(config.locals)) {
    if (key === 'synqux' || key === (config.syncedKey as string)) {
      throw new Error(
        `createSynquxRootReducer: locals key "${key}" collides with ${
          key === 'synqux' ? 'the reserved internal slice' : 'syncedKey'
        }`,
      )
    }
  }

  const { syncedKey, synced: syncedReducer } = config
  const localEntries = Object.entries(config.locals) as [
    keyof TLocals & string,
    Reducer<TLocals[keyof TLocals]>,
  ][]

  type TRoot = SynquxRootState<TSyncedKey, TSynced, TLocals>

  const rootReducer: Reducer<TRoot> = (state, action) => {
    const synqux = synquxReducer(state?.synqux, action)

    // restore は synced subtree の全量差し替え。locals はこのあと通常どおり実行
    // されるため、meta.root 経由で「復元後の synced」に反応できる
    const synced = synquxRestored.match(action)
      ? (action.payload.synced as TSynced)
      : syncedReducer(
          state && config.isSyncedAction(action)
            ? (stateWithDefaultResult(
                state[syncedKey] as SynquxSynced<TAction>,
                action,
              ) as unknown as TSynced)
            : state?.[syncedKey],
          action,
        )

    // locals へ直列進行に応じた root を引き渡す。accumulator を進めながら
    // 実行することで「自分より前の local の結果」も読める
    let acc = {
      ...state,
      synqux,
      [syncedKey]: synced,
    } as TRoot

    let changed =
      !state || state.synqux !== synqux || state[syncedKey] !== synced

    for (const [key, localReducer] of localEntries) {
      const next = localReducer(state?.[key], withRootMeta(action, acc))

      if (!state || state[key] !== next) {
        changed = true
        acc = { ...acc, [key]: next }
      }
    }

    // どの slice も変化がなければ参照を維持する (combineReducers と同じ規約)
    return changed || !state ? acc : state
  }

  return {
    rootReducer,
    selectSynced: (root) => root[syncedKey],
    isSyncedAction: config.isSyncedAction,
  }
}

/**
 * locals への root 引き渡しチャネル
 *
 * 現状は移植元踏襲の `meta.root` 方式。将来 ctx 引数方式 (reducer 第 3 引数) へ
 * 移行する場合もこの関数の差し替えで済むよう、付与箇所をここに隔離している
 */
const withRootMeta = (action: Action, root: unknown): UnknownAction => ({
  ...(action as UnknownAction),
  meta: {
    ...((action as UnknownAction).meta as object | undefined),
    root,
  },
})
