import type { Action, UnknownAction } from '@reduxjs/toolkit'
import type { SynquxActionMeta } from './types.js'

/**
 * synqux 内部 action (synqux/restored, synqux/sessionStarted など) の判定。
 * consumer が listener / middleware の除外条件に使う。
 * action type の prefix 文字列は内部実装詳細のため公開しない (これを使うこと)
 */
export const isSynquxAction = (action: Action): boolean =>
  action.type.startsWith('synqux/')

/**
 * request 経路を通り、host の裁定後に全端末へ配達された action の判定。
 * consumer が dispatch 前の action と配達済み action を区別するために使う。
 *
 * synced domain の判定は consumer の責務。この matcher 単体では action type を
 * 判定しないため、必要なら consumer の isSyncedAction と組み合わせること。
 */
export const isDeliveredSyncedAction = (
  action: Action,
): action is Action & {
  meta: SynquxActionMeta &
    Required<
      Pick<
        SynquxActionMeta,
        | 'hash'
        | 'requestedBy'
        | 'dispatched'
        | 'responsedBy'
        | 'responsed'
        | 'epoch'
        | 'seq'
      >
    >
} => {
  const meta = (action as UnknownAction).meta as SynquxActionMeta | undefined
  return (
    typeof meta?.hash === 'string' &&
    typeof meta.requestedBy === 'string' &&
    typeof meta.dispatched === 'number' &&
    typeof meta.responsedBy === 'string' &&
    typeof meta.responsed === 'number' &&
    typeof meta.epoch === 'number' &&
    typeof meta.seq === 'number'
  )
}
