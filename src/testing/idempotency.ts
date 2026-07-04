import type { Action, Reducer } from '@reduxjs/toolkit'
import { canonicalStringify } from '../core/snapshot.js'

/**
 * action 冪等性ハーネス (ADR-0001 Decision 4)
 *
 * 同期基盤は at-least-once な世界で動くため、synced action は「二重適用・
 * 再クリック・遅延後の再送」に耐える冪等な設計 (toggle ではなく set) が望ましい
 * (SPEC-requests-sync.md 設計ガイドライン 1)。このハーネスを consumer の CI で
 * 回すことで、非冪等 action の混入を教育ではなく機械的に検出する
 */
export type IdempotencyReport<TSynced> = {
  /** 2 回適用した結果が 1 回適用と一致するか */
  idempotent: boolean
  /** 1 回適用後の state */
  single: TSynced
  /** 2 回適用後の state */
  double: TSynced
}

/**
 * reducer に同一 action を 2 回適用し、結果が 1 回適用と一致するか検証する
 * 比較は canonical JSON (undefined 除去・key 辞書順) で行う
 *
 * @example
 *   const report = verifyActionIdempotency({
 *     reducer: gameReducer,
 *     state: arrangedState,
 *     action: setPhase({ phase: 2 }),
 *   })
 *   expect(report.idempotent).toBe(true)
 */
export const verifyActionIdempotency = <
  TSynced,
  TAction extends Action,
>(config: {
  reducer: Reducer<TSynced>
  /** 検証の前提 state (arrange 済みのもの) */
  state: TSynced
  action: TAction
}): IdempotencyReport<TSynced> => {
  const single = config.reducer(config.state, config.action)
  const double = config.reducer(single, config.action)

  return {
    idempotent: canonicalStringify(single) === canonicalStringify(double),
    single,
    double,
  }
}

/** CI 組込み用: 非冪等なら差分つきで throw する */
export const assertActionIdempotency = <TSynced, TAction extends Action>(
  config: Parameters<typeof verifyActionIdempotency<TSynced, TAction>>[0],
): void => {
  const report = verifyActionIdempotency(config)

  if (!report.idempotent) {
    throw new Error(
      `Action "${config.action.type}" is not idempotent. ` +
        'Double-applying it produced a different state — prefer set({ value }) style over toggle style.\n' +
        `single: ${canonicalStringify(report.single)}\n` +
        `double: ${canonicalStringify(report.double)}`,
    )
  }
}
