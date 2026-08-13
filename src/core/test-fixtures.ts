import {
  configureStore,
  isAction,
  type Action,
  type Reducer,
} from '@reduxjs/toolkit'
import { vi } from 'vitest'
import type { createMemoryHub } from '../testing/memory-hub.js'
import { createSynqux, type CreateSynquxConfig } from './create-synqux.js'
import { stateWithDefaultResult } from './results.js'
import { synquxReducer, synquxRestored, type SynquxState } from './slice.js'
import type { Result, SynquxSynced, SynquxTransport } from './types.js'

/**
 * core テスト共通の consumer 想定 fixture (primitive 方式)
 * ビルド成果物には含めない (テスト専用。E2 のパッケージ体裁で除外する)
 */

export type GameAction = Action<`game/${string}`> & {
  payload?: number
  meta?: { requestedBy?: string; hash?: string; dispatched?: number }
}

export type GameState = SynquxSynced<GameAction> & {
  count: number
  /** 適用順の検証用。全端末で一致していれば順序保証が成立している */
  log: string[]
}

export type RootState = {
  synqux: SynquxState
  game: GameState
}

export const gameInitialState: GameState = { result: null, count: 0, log: [] }

export const isGameAction = (action: Action): action is GameAction =>
  action.type.startsWith('game/')

export const gameReducer: Reducer<GameState> = (
  state = gameInitialState,
  action,
) => {
  if (!isAction(action) || !isGameAction(action)) {
    return state
  }

  switch (action.type) {
    case 'game/increment':
      return {
        ...state,
        count: state.count + (action.payload ?? 1),
        log: state.log.concat(`increment:${action.payload ?? 1}`),
      }

    // automation の dual-host/retry 検証用 rejects-repeat action。
    // 受理条件は reducer に残し、rule の when は発行トリガーにだけ使う。
    case 'game/increment-once':
      if (state.count > 0) {
        return {
          ...state,
          result: {
            action,
            type: 'error',
            targets: action.meta?.requestedBy ? [action.meta.requestedBy] : [],
          },
        }
      }
      return {
        ...state,
        count: 1,
        log: state.log.concat('increment-once'),
      }

    // toggle 系 action: 二重適用で「クリックが無かったこと」になる非冪等 action の代表
    case 'game/toggle':
      return {
        ...state,
        count: state.count === 0 ? 1 : 0,
        log: state.log.concat('toggle'),
      }

    // 決定性契約違反の代表例: 試し実行と実適用で結果が変わる (D4 検出網の検証用)
    case 'game/random':
      return {
        ...state,
        count: Math.random(),
        log: state.log.concat('random'),
      }

    case 'game/forbidden': {
      // reducer が唯一の判定器: validation 失敗は state を変えず error を積む
      // (message なし = log 専用の拒否として dispatch が省略される経路)
      const result: Result<GameAction> = {
        action,
        type: 'error',
        targets: action.meta?.requestedBy ? [action.meta.requestedBy] : [],
        log: 'forbidden',
      }
      return { ...state, result }
    }

    case 'game/message-forbidden': {
      const result: Result<GameAction> = {
        action,
        type: 'error',
        targets: action.meta?.requestedBy ? [action.meta.requestedBy] : [],
        message: { text: 'forbidden' },
      }
      return { ...state, result }
    }

    // success + message + log の代表例 (適用されつつ log も出力される経路)
    case 'game/announce': {
      const result: Result<GameAction> = {
        action,
        type: 'success',
        message: { text: 'announced' },
        targets: [],
        log: 'announce applied',
      }
      return { ...state, result, log: state.log.concat('announce') }
    }

    default:
      return state
  }
}

// primitive 方式: 予約 key synqux を自前で mount し、restore も自前で処理する
export const rootReducer: Reducer<RootState> = (state, action) => {
  if (synquxRestored.match(action)) {
    return {
      synqux: synquxReducer(state?.synqux, action),
      game: action.payload.synced as GameState,
    }
  }

  return {
    synqux: synquxReducer(state?.synqux, action),
    game: gameReducer(
      isGameAction(action)
        ? stateWithDefaultResult(state?.game ?? gameInitialState, action)
        : state?.game,
      action,
    ),
  }
}

type ClientOptions = Partial<
  Pick<
    CreateSynquxConfig<RootState, GameState, GameAction>,
    | 'mode'
    | 'stallAfterMs'
    | 'canRequest'
    | 'localSnapshots'
    | 'devDeterminismCheck'
    | 'automations'
    | 'listeners'
    | 'hostLiveness'
    | 'onPhaseChanged'
    | 'onSubscribeFailed'
    | 'onUnrecoverable'
  >
>

export const createClient = (
  transport: SynquxTransport,
  options?: ClientOptions,
) => {
  const sync = createSynqux<RootState, GameState, GameAction>({
    transport,
    isSyncedAction: isGameAction,
    rootReducer,
    selectSynced: (root) => root.game,
    ...options,
  })

  const store = configureStore({
    reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().prepend(...sync.middlewares),
  })

  return { sync, store }
}

export const createHubClient = (
  hub: ReturnType<typeof createMemoryHub>,
  options?: ClientOptions,
) => createClient(hub.createTransport(), options)

/** fork の待機 loop と hub の配送を進めて滞留がなくなるまで時間を進める */
export const settle = async (steps = 30): Promise<void> => {
  for (let i = 0; i < steps; i += 1) {
    await vi.advanceTimersByTimeAsync(100)
  }
}
