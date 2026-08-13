/**
 * synqux - Client-host realtime sync for Redux apps
 *
 * 設計は docs/ADR-0001-design.md、同期仕様は docs/SPEC-0001-requests-sync.md、
 * 公開 API の境界と理由は docs/SPEC-0002-public-api.md を参照。
 */
export const SYNQUX_VERSION = '0.11.0'

// 共有語彙 (契約型)
export * from './core/types.js'

// セットアップ層
export {
  createSynqux,
  type CreateSynquxConfig,
  type Synqux,
  type SynquxAutomation,
  type SynquxHostLiveness,
  type SynquxListener,
  type SynquxListenerContext,
  type SynquxSubscribeOptions,
} from './core/create-synqux.js'
export {
  createSynquxRootReducer,
  type SynquxRootState,
} from './core/root-reducer.js'
export { localStorageSnapshotStore } from './core/local-storage.js'

// primitive 方式 (helper が合わない consumer の脱出口) 用の内部 slice
export {
  synquxReducer,
  synquxRestored,
  type PendingRequest,
  type SynquxHealth,
  type SynquxPhase,
  type SynquxState,
} from './core/slice.js'

// ゲーム開発者層: reducer ヘルパーと読み取り selector
export {
  createSyncedActionMatchers,
  isDeliveredSyncedAction,
  isSynquxAction,
} from './core/matchers.js'
export {
  generateResult,
  isResultForPeer,
  stateWithDefaultResult,
  stateWithError,
  stateWithResult,
  stateWithTransaction,
} from './core/results.js'
export {
  selectIsHost,
  selectIsLive,
  selectIsSyncStalled,
  selectIsSyncUnrecoverable,
  selectPeers,
  selectSelf,
  selectSelfId,
  selectSelfRole,
  selectSyncHealth,
  selectSyncPhase,
} from './core/selectors.js'
