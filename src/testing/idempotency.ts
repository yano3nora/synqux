import type { Action, Reducer } from '@reduxjs/toolkit'
import {
  generateActionHash,
  normalizeSyncedActionMeta,
} from '../core/action.js'
import { canonicalStringify } from '../core/snapshot.js'
import type { SynquxActionMeta } from '../core/types.js'

/**
 * action repeat contract ハーネス (ADR-0007)
 *
 * 同一 request の二重適用 (①) は同期機構が防ぐ。ここで検査するのは、再クリックや
 * retry が同じ意図の別 request になる場合 (②) の domain semantics である。
 * action は set 型 (`idempotent`)、execute-once 型 (`rejects-repeat`)、無限実行型
 * (`repeatable`) のいずれかを宣言し、その契約だけを検査する。
 */
export type IdempotencyReport<TSynced> = {
  /** result を除く domain state が、1 回適用時と 2 回適用時で一致するか */
  idempotent: boolean
  /** 1 回適用後の state。result を含む元の形を保持する */
  single: TSynced
  /** 2 回適用後の state。result を含む元の形を保持する */
  double: TSynced
}

type ActionRepeatMode = 'idempotent' | 'rejects-repeat' | 'repeatable'

/**
 * result は transient な通知なので null に正規化し、domain state だけを比較する。
 * TSynced の公開 generics は維持し、synced state が object であるという境界の型補強を
 * 比較点だけに閉じる。
 */
const domainState = <TSynced>(state: TSynced): unknown => ({
  ...(state as object),
  result: null,
})

const resultType = (state: unknown): unknown =>
  (state as { result?: { type?: unknown } | null }).result?.type

const actionMeta = (action: Action): SynquxActionMeta | undefined =>
  (action as Action & { meta?: SynquxActionMeta }).meta

/** 1 回目: 未付与の hash / dispatched を補い、有効な synced action にする */
const ensureActionMeta = <TAction extends Action>(action: TAction): TAction => {
  const meta = actionMeta(action)

  if (typeof meta?.hash === 'string' && typeof meta.dispatched === 'number') {
    return action
  }

  return { ...action, meta: normalizeSyncedActionMeta(meta) }
}

/**
 * 2 回目: hash / dispatched を再生成する (ADR-0007 Amendment)
 *
 * 同一 request の二重適用 (①) は同期機構が防ぐため現実に存在しない。検査対象の
 * 「同じ意図の別 request (②)」は別 hash で届くため、忠実に再現する。hash を
 * state の識別子に使う consumer では、同一 hash の重複排除が ② の実害を隠す
 * 偽陰性になるため、同一 action の再適用では検査にならない
 */
const regenerateActionMeta = <TAction extends Action>(
  action: TAction,
): TAction => {
  // 「別 request」は pre-dispatch の action なので、配達済み action が入力でも
  // 配達経路でしか付かない meta (response 系 / root / requestedBy) は持ち込まない
  const {
    requestedBy: _requestedBy,
    responsedBy: _responsedBy,
    responsed: _responsed,
    epoch: _epoch,
    seq: _seq,
    replay: _replay,
    root: _root,
    ...rest
  } = actionMeta(action) ?? {}

  return {
    ...action,
    meta: { ...rest, hash: generateActionHash(), dispatched: Date.now() },
  }
}

/**
 * reducer に「同じ意図の action」を 2 回適用し、domain state が 1 回適用時と
 * 一致するか検証する。2 回目は hash / dispatched を再生成した**別 request** として
 * 適用する (ADR-0007 Amendment。① の同一 request 二重適用は同期機構が防ぐため
 * 検査対象ではない)。比較は result を null にしたうえで canonical JSON
 * (undefined 除去・key 辞書順) で行う
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
  const first = ensureActionMeta(config.action)
  const second = regenerateActionMeta(first)
  const single = config.reducer(config.state, first)
  const double = config.reducer(single, second)

  return {
    idempotent:
      canonicalStringify(domainState(single)) ===
      canonicalStringify(domainState(double)),
    single,
    double,
  }
}

/**
 * CI 組込み用の action repeat contract 検査。
 *
 * - idempotent: set 型。2 回目で domain state が変わらないことを検査する
 * - rejects-repeat: execute-once 型。初回受理・domain 不変・2 回目拒否を検査する
 * - repeatable: 無限実行型の明示的な検査除外 (no-op)
 *
 * repeatable で同じ意図の別 request に実害があるかは consumer が評価する。実害が
 * ある場合は payload に一意 key を持たせ、validation reject する execute-once 型にする。
 */
export const assertActionIdempotency = <TSynced, TAction extends Action>(
  config: Parameters<typeof verifyActionIdempotency<TSynced, TAction>>[0] & {
    mode?: ActionRepeatMode
  },
): void => {
  const mode = config.mode ?? 'idempotent'

  // repeatable は「検査済み table に載せたうえで除外する」ための宣言であり、
  // reducer の試し実行自体を行わない。
  if (mode === 'repeatable') {
    return
  }

  const report = verifyActionIdempotency(config)
  const singleDomain = canonicalStringify(domainState(report.single))
  const doubleDomain = canonicalStringify(domainState(report.double))

  if (mode === 'idempotent') {
    if (!report.idempotent) {
      throw new Error(
        `Action "${config.action.type}" is not idempotent in domain state. ` +
          'Double-applying it produced a different domain state (result is excluded) — prefer set({ value }) style over toggle style.\n' +
          `single domain: ${singleDomain}\n` +
          `double domain: ${doubleDomain}`,
      )
    }
    return
  }

  if (resultType(report.single) === 'error') {
    throw new Error(
      `Action "${config.action.type}" violates "rejects-repeat": first application was rejected.`,
    )
  }

  if (!report.idempotent) {
    throw new Error(
      `Action "${config.action.type}" violates "rejects-repeat": repeat changed domain state.\n` +
        `single domain: ${singleDomain}\n` +
        `double domain: ${doubleDomain}`,
    )
  }

  if (resultType(report.double) !== 'error') {
    throw new Error(
      `Action "${config.action.type}" violates "rejects-repeat": repeat was not rejected with result.type "error".`,
    )
  }
}
