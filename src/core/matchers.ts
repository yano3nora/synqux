import type { Action, UnknownAction } from '@reduxjs/toolkit'
import type { SynquxState } from './slice.js'
import type { SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * synqux 内部 action (synqux/restored, synqux/sessionStarted など) の判定。
 * consumer が listener / middleware の除外条件に使う。
 * action type の prefix 文字列は内部実装詳細のため公開しない (これを使うこと)
 */
export const isSynquxAction = (action: Action): boolean =>
  action.type.startsWith('synqux/')

/**
 * locals reducer から、直前に適用された synced action の成功と依頼元を判定する。
 * createSynquxRootReducer の返り値をそのまま config に渡せる。
 *
 * **locals reducer 専用**。meta.root は locals にしか付与されない
 * (ADR-0001 Decision 8) ため、synced reducer 内では常に false になる。
 * synced reducer から端末ローカル情報を読むと決定性が壊れるため、そもそも
 * synced reducer では使用してはならない。
 */
export const createSyncedActionMatchers = <
  TAction extends Action,
  TSynced extends SynquxSynced,
  TRoot extends { synqux: SynquxState },
>(config: {
  /** createSynquxRootReducer と同じ synced domain action の判定述語 */
  isSyncedAction: (action: Action) => action is TAction
  /** createSynquxRootReducer が返す synced slice selector */
  selectSynced: (root: TRoot) => TSynced
}): {
  isSucceededAction: (action: Action) => action is TAction
  isMySucceededAction: (action: Action) => action is TAction
} => {
  const isSucceededAction = (action: Action): action is TAction => {
    // standalone では両 hash が undefined になり得るため、照合より先に必ず
    // domain 述語で絞る。これがないと local action を成功と誤判定する。
    if (!config.isSyncedAction(action)) {
      return false
    }

    const meta = (action as UnknownAction).meta as SynquxActionMeta | undefined
    const root = meta?.root as TRoot | undefined
    if (!root) {
      return false
    }

    const result = config.selectSynced(root).result
    const resultMeta = (result?.action as UnknownAction | undefined)?.meta as
      | SynquxActionMeta
      | undefined

    return result?.type === 'success' && resultMeta?.hash === meta?.hash
  }

  const isMySucceededAction = (action: Action): action is TAction => {
    if (!isSucceededAction(action)) {
      return false
    }

    const meta = (action as UnknownAction).meta as SynquxActionMeta
    const root = meta.root as TRoot
    if (root.synqux.mode === 'standalone') {
      return true
    }

    const selfId = root.synqux.connections.selfId
    return (
      selfId !== null &&
      typeof meta.requestedBy === 'string' &&
      meta.requestedBy === selfId
    )
  }

  return { isSucceededAction, isMySucceededAction }
}
