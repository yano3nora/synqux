import type { Action, UnknownAction } from '@reduxjs/toolkit'
import type { Result, SynquxActionMeta, SynquxSynced } from './types.js'

/**
 * reducer (唯一の判定器) 用の result 生成ヘルパー
 * (移植元 constants/requests.ts の generateResult / stateWithResult /
 * stateWithError の移植。同期利用・standalone によらず同じ書き方で使う)
 */

/**
 * result object を生成する。targets 未指定時は「依頼元 (requestedBy) 宛て」、
 * requestedBy もなければ [] (standalone 扱いで無条件表示)
 */
export const generateResult = <TAction extends Action>(props: {
  action: TAction
  type: Result<TAction>['type']
  message: Result<TAction>['message']
  targets?: Result<TAction>['targets']
  console?: Result<TAction>['console']
  duration?: Result<TAction>['duration']
}): Result<TAction> => {
  const { action, message, type, targets, console, duration } = props
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
    console,
    duration,
    // requestedBy がないとき [null] にならないよう flatMap で [] に落とす
    targets: targets || [meta?.requestedBy].flatMap((v) => (v ? [v] : [])),
  }
}

/** immer draft を直接書き換えて返す (RTK reducer 内での利用前提、Decision 9) */
export const stateWithResult = <
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
>(
  state: TSynced,
  result: Parameters<typeof generateResult<TAction>>[0],
): TSynced => {
  state.result = generateResult(result)
  return state
}

/**
 * validation 失敗を表明する。message 省略時は action.type を message として
 * console 通知 (画面に出さない) になる — 開発者向けのデフォルト挙動
 */
export const stateWithError = <
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
>(
  state: TSynced,
  action: TAction,
  option?: {
    message?: Result<TAction>['message']
    console?: Result<TAction>['console']
    duration?: Result<TAction>['duration']
  },
): TSynced =>
  stateWithResult(state, {
    type: 'error',
    message: option?.message || action.type,
    // message 指定があれば画面通知、なければ console へ (移植元の優先順位を踏襲)
    console: option?.console || !option?.message ? true : option?.console,
    action,
    duration: option?.duration,
  })
