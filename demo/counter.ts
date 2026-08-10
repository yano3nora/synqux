import type { Action, Reducer } from '@reduxjs/toolkit'
import { stateWithError, type SynquxSynced } from 'synqux'

/**
 * demo 用の同期対象 slice (counter)
 *
 * synqux の作法どおりの普通の reducer:
 * - SynquxSynced を満たす (result を持つ)
 * - validation 失敗は state を変えず stateWithError で result に積む
 * - 現在値に依存しない set 型 action を基本にする (設計ガイドライン 1)
 */
export type CounterAction = Action<`counter/${string}`> & {
  payload?: number
  meta?: { requestedBy?: string }
}

export type CounterState = SynquxSynced<CounterAction> & {
  count: number
}

export const counterInitialState: CounterState = { result: null, count: 0 }

export const isCounterAction = (action: Action): action is CounterAction =>
  action.type.startsWith('counter/')

const MAX = 100
const MIN = 0

export const counterReducer: Reducer<CounterState> = (
  state = counterInitialState,
  action,
) => {
  if (!isCounterAction(action)) {
    return state
  }

  switch (action.type) {
    // 増分型 = 無限実行型の自覚的な例 (設計ガイドライン 1 の 3 分類)。
    // demo は同時操作の見た目確認が目的なので、操作回数ぶんの加算を許容する。
    case 'counter/add': {
      const next = state.count + (action.payload ?? 1)

      // validation は reducer に集約する。範囲外は state を変えず error result を
      // 積む → host が拒否し、依頼元にだけ通知される (message ありなので画面通知)
      if (next > MAX || next < MIN) {
        return stateWithError({ ...state }, action, {
          message: {
            text: `count は ${String(MIN)}〜${String(MAX)} の範囲です`,
          },
        })
      }

      return { ...state, count: next }
    }

    case 'counter/set':
      return { ...state, count: action.payload ?? 0 }

    default:
      return state
  }
}
