/**
 * synqux - Client-host realtime sync for Redux apps
 *
 * 設計は docs/ADR-0001-design.md、同期仕様は docs/SPEC-0001-requests-sync.md、
 * 公開 API の境界と理由は docs/SPEC-0002-public-api.md を参照。
 */
export const SYNQUX_VERSION = '0.14.0'

// 共有語彙 (契約型)
export * from './core/types.js'

// action identity と consumer 型語彙 (ADR-0024 / ADR-0025 / ADR-0026)
// createSyncedAction / createSyncedSlice は defineSynqux の戻りからのみ提供する
// (registry 登録のため。定義非経由の creator は「作れるのに同期されない」抜け道になる)
export {
  generateActionHash,
  type CreateSyncedAction,
  type LocalAction,
  type SyncedAction,
  type SyncedActionHash,
  type SyncedActionMeta,
} from './core/action.js'
export { defineSynqux, type SynquxTypes } from './core/define-synqux.js'

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
// (成功判定 matchers は defineSynqux の戻り (isSucceededAction /
//  isMySucceededAction) からのみ提供する — creators と同じ整理。ADR-0026)
export { isDeliveredSyncedAction, isSynquxAction } from './core/matchers.js'
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
