import {
  createNextState,
  current,
  isDraft,
  type Action,
  type Draft,
  type UnknownAction,
} from '@reduxjs/toolkit'
import type {
  Peer,
  Result,
  ResultMessage,
  SynquxActionMeta,
  SynquxSynced,
} from './types.js'

/**
 * result が指定 peer に表示すべきものかの判定。
 * targets の意味論 (generateResult 参照): [] は standalone / 全員宛てで無条件表示、
 * 非空は宛先 peer id のリスト (未指定時は生成側で requestedBy 宛てに落ちている)。
 *
 * @example
 * createSelector([selectSelfId, selectGameResult], (selfId, result) =>
 *   isResultForPeer(result, selfId) ? result : null,
 * )
 */
export const isResultForPeer = (
  result: Pick<Result, 'targets'> | null | undefined,
  peerId: Peer['id'] | null,
): boolean => {
  if (!result) {
    return false
  }

  return (
    result.targets.length === 0 ||
    (peerId !== null && result.targets.includes(peerId))
  )
}

/**
 * reducer (唯一の判定器) 用の result 生成ヘルパー
 * (移植元 constants/requests.ts の generateResult / stateWithResult /
 * stateWithError の移植。同期利用・standalone によらず同じ書き方で使う)
 */

/**
 * result object を生成する。targets 未指定時は「依頼元 (requestedBy) 宛て」、
 * requestedBy もなければ [] (standalone 扱いで無条件表示)
 */
export const generateResult = <
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(props: {
  action: TAction
  type: Result<TAction, TMessage>['type']
  /** UI 表示想定データ。省略時は画面通知なし (ADR-0008) */
  message?: TMessage
  targets?: Result<TAction, TMessage>['targets']
  /** console 出力メッセージ。synqux が type に応じて console.log / error へ出力する */
  log?: string
}): Result<TAction, TMessage> => {
  const { action, message, type, targets, log } = props
  const meta = (action as UnknownAction).meta as SynquxActionMeta | undefined

  return {
    // reducer で action から result 生成時に、永続化不要 & 重たい root を除去する
    // (undefined 代入は JSON 直列化で消える。移植元 removeActionMeta 踏襲)
    action: {
      ...action,
      ...(meta ? { meta: { ...meta, root: undefined } } : {}),
    },
    message,
    type,
    log,
    // requestedBy がないとき [null] にならないよう flatMap で [] に落とす
    targets: targets || [meta?.requestedBy].flatMap((v) => (v ? [v] : [])),
  }
}

/**
 * synced domain action の適用前に result を default success へ差し替える
 * (ADR-0013)。createSynquxRootReducer が内部で呼ぶ。primitive 方式の consumer は
 * 自前 rootReducer の synced reducer 前段でこれを呼ぶ義務を負う。
 *
 * reducer 実行前に使うため、immer draft を変更せず新しい state を返す。
 * message / log は付けず、UI 通知や console 出力は発生させない (ADR-0008)。
 */
export const stateWithDefaultResult = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  action: TAction,
): TSynced => ({
  ...state,
  result: generateResult<TAction, TMessage>({ action, type: 'success' }),
})

/** immer draft を直接書き換えて返す (RTK reducer 内での利用前提、Decision 9) */
export const stateWithResult = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  result: Parameters<typeof generateResult<TAction, TMessage>>[0],
): TSynced => {
  state.result = generateResult(result)
  return state
}

/**
 * validation 失敗を表明する。message (UI 表示) を省略した場合は log 専用の
 * 拒否になり、log 未指定なら action.type を log として出力する — 開発者向けの
 * デフォルト挙動。log 専用の error result は dispatch 自体が省略される (ADR-0008)
 */
export const stateWithError = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  action: TAction,
  option?: {
    message?: TMessage
    log?: string
  },
): TSynced =>
  stateWithResult<TSynced, TAction, TMessage>(state, {
    type: 'error',
    message: option?.message,
    // message 指定なし & log 指定なしでも「何が弾かれたか」を console に残す
    log: option?.log ?? (option?.message ? undefined : action.type),
    action,
  })

/**
 * callback 内の複数変更を一括適用し、error result が積まれた場合は domain の変更を
 * すべて巻き戻す。result は ADR-0013 の pre-stamp 済みであることを前提とする。
 *
 * 移植元との差分として `draft.result = null` のリセットは行わない。リセットすると
 * silent success 時に stamp 済み success を破壊するため。また error 時も受け取った
 * draft を直接変更せず、base のコピーへ error result だけを載せて返す。これにより
 * 成功・失敗のどちらでも、この helper 自体は外側の draft に触れない。
 *
 * reducer の状態変更はすべて mutate callback 内で行うこと。外側の draft を先に変更
 * してから呼ぶと、immer が「draft 変更 + 新値 return」として throw する。host では
 * reducer throw が拒否裁定になる。また state 全体をコピーするため、高頻度 action
 * には使わないこと。
 */
export const stateWithTransaction = <
  TSynced extends SynquxSynced<TAction, TMessage>,
  TAction extends Action,
  TMessage extends ResultMessage = ResultMessage,
>(
  state: TSynced,
  mutate: (draft: TSynced) => void,
): TSynced => {
  const base = isDraft(state)
    ? (current(state as unknown as Draft<TSynced>) as unknown as TSynced)
    : state
  const next = createNextState(base, (draft) => {
    mutate(draft as unknown as TSynced)
  })

  return next.result?.type === 'error' ? { ...base, result: next.result } : next
}
