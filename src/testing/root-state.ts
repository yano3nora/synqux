import { synquxInitialState, type SynquxState } from '../core/slice.js'

/**
 * locals reducer / selector のテスト用に root state fixture を組む (ADR-0025)
 *
 * synqux 予約 slice の初期値を内部で埋めるため、consumer のテストが
 * `synquxReducer(undefined, { type: '@@INIT' })` (primitive 方式の脱出口) を
 * 直接呼ぶ必要はない。mode / selfId 等を検証したい場合は synqux で上書きする
 *
 * @example
 *   const root = createTestRootState<RootState>({
 *     game: structuredClone(gameInitialState),
 *     scenes: scenesInitialState,
 *   })
 */
export const createTestRootState = <TRoot extends { synqux: SynquxState }>(
  locals: Omit<TRoot, 'synqux'>,
  /** shallow merge (Partial は 1 段のみ)。connections 等は object ごと渡すこと */
  synqux?: Partial<SynquxState>,
): TRoot =>
  ({
    // fixture 間・synquxInitialState との内部 object 共有 (health / connections /
    // requests) を避けるため、初期値は毎回 deep clone する
    synqux: { ...structuredClone(synquxInitialState), ...synqux },
    ...locals,
  }) as TRoot
