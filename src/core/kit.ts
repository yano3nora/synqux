import {
  createSyncedAction,
  type CreateSyncedAction,
  type SyncedAction,
} from './action.js'
import { createSyncedActionMatchers } from './matchers.js'
import {
  generateResult,
  stateWithError,
  stateWithResult,
  stateWithTransaction,
} from './results.js'
import type { SynquxState } from './slice.js'
import type { ResultMessage, SynquxSynced } from './types.js'

/**
 * synquxKit.withTypes へ渡す consumer の型セット (ADR-0025)
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
 * consumer の domain 型を一度だけ束縛し、型付き語彙を配布する kit (ADR-0025)
 *
 * RTK の createAsyncThunk.withTypes / createSelector.withTypes と同じ idiom。
 * consumer はこれを 1 ファイルで呼び、synqux 由来の generics 再束縛 wrapper を
 * 自作しない。束縛は型のみで、synqux instance (createSynqux) に依存しない
 * (reducer → instance の循環 import を構造的に避ける)。
 *
 * @example
 * export const {
 *   createSyncedAction, createSyncedActionMatchers,
 *   generateResult, stateWithError, stateWithResult, stateWithTransaction,
 * } = synquxKit.withTypes<{
 *   synced: GameState
 *   root: RootState
 *   message: GameResultMessage
 * }>()
 */
export const synquxKit = {
  withTypes: <T extends SynquxKitTypes>() => ({
    /** RTK createAction の同期版。生成時に hash / dispatched を付与する (ADR-0024) */
    createSyncedAction: createSyncedAction as CreateSyncedAction<T['root']>,

    /**
     * locals reducer 用の成功判定 matcher 群 (束縛済み)。isSyncedAction /
     * selectSynced は createSynquxRootReducer へ渡すものと同じ値を渡す
     */
    createSyncedActionMatchers: createSyncedActionMatchers as (config: {
      isSyncedAction: (
        action: import('@reduxjs/toolkit').Action,
      ) => action is SyncedAction<any, T['root']>
      selectSynced: (root: T['root']) => T['synced']
    }) => ReturnType<
      typeof createSyncedActionMatchers<
        SyncedAction<any, T['root']>,
        T['synced'],
        T['root']
      >
    >,

    generateResult: generateResult as typeof generateResult<
      SyncedAction<any, T['root']>,
      MessageOf<T>
    >,

    stateWithResult: stateWithResult as typeof stateWithResult<
      T['synced'],
      SyncedAction<any, T['root']>,
      MessageOf<T>
    >,

    stateWithError: stateWithError as typeof stateWithError<
      T['synced'],
      SyncedAction<any, T['root']>,
      MessageOf<T>
    >,

    stateWithTransaction: stateWithTransaction as typeof stateWithTransaction<
      T['synced'],
      SyncedAction<any, T['root']>,
      MessageOf<T>
    >,
  }),
}
