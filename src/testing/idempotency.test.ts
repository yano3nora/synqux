import { describe, expect, it } from 'vitest'
import { gameInitialState, gameReducer } from '../core/test-fixtures.js'
import {
  assertActionIdempotency,
  verifyActionIdempotency,
} from './idempotency.js'

describe('verifyActionIdempotency', () => {
  it('toggle 系 (非冪等) action を検出する', () => {
    const report = verifyActionIdempotency({
      reducer: gameReducer,
      state: gameInitialState,
      action: { type: 'game/toggle' },
    })

    // 反転 ×2 = 元に戻る、が検出される
    expect(report.idempotent).toBe(false)
  })

  it('increment (非冪等) も検出する', () => {
    const report = verifyActionIdempotency({
      reducer: gameReducer,
      state: gameInitialState,
      action: { type: 'game/increment', payload: 1 },
    })

    expect(report.idempotent).toBe(false)
  })

  it('関係のない action (state 不変) は冪等と判定される', () => {
    const report = verifyActionIdempotency({
      reducer: gameReducer,
      state: gameInitialState,
      action: { type: 'game/unknown' },
    })

    expect(report.idempotent).toBe(true)
  })

  it('assertActionIdempotency は非冪等 action で差分つきの Error を投げる', () => {
    expect(() =>
      assertActionIdempotency({
        reducer: gameReducer,
        state: gameInitialState,
        action: { type: 'game/toggle' },
      }),
    ).toThrow('not idempotent')
  })
})
