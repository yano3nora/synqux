# Changelog

本パッケージは [semver](https://semver.org/lang/ja/) に従う。消費者 repo は「テンプレは ^latest 追従、出荷済みプロジェクトは exact pin」で運用する (ADR-0001 Decision 6)。

## [Unreleased]

### Added

- seq gap が継続して同期適用が止まった端末を `state.synqux.health` で検知する sync health (ADR-0003)
- `stallAfterMs` 設定、`selectSyncHealth` / `selectIsSyncStalled`、`useSyncHealth` / `useIsSyncStalled`
- seq gap を requests 再購読 → snapshot restore の 1 巡で自動回復する段階制御 (ADR-0004)
- `recovering` / `unrecoverable` phase、`selectIsSyncUnrecoverable` / `useIsSyncUnrecoverable`
- snapshot ack 後に適用窓の外だけを削除する requests retention。optional な `SynquxTransport.pruneRequests` と memory / Firebase adapter 実装 (ADR-0005)
- prune 対象の request を `logs/` へ原子的に退避し、全量 replay 調査を維持する Firebase adapter の `archivePrunedRequests` option
- `assertActionIdempotency` に action repeat contract を宣言する `mode` (`idempotent` / `rejects-repeat` / `repeatable`) を追加 (ADR-0007)

### Changed

- `selectIsSyncStalled` / `useIsSyncStalled` は回復中・回復不能を含む `phase !== 'ok'` を返す。リロード案内は `*IsSyncUnrecoverable` を使う

### Fixed

- Firebase adapter が一時切断後に同じ connection id と初回 `connected` で presence を自動復元し、host 序列を変えずに候補へ復帰するよう修正 (ADR-0006)
- 冪等性ハーネスの比較を `result` を除く domain state に修正し、2 回目を明示的に拒否する execute-once 型の誤検知を解消 (ADR-0007)

## [0.2.0] - 2026-07-05

### Changed (BREAKING: wire format v2)

- Phase 3: 順序判定を host 採番 seq へ全面刷新 (`docs/ADR-0002-host-seq.md`)
    - 封筒の裁定印が `prev` (チェーン参照) → `(epoch, seq)` (連番 + host 世代) に変更。`SYNQUX_SCHEMA_VERSION = 2`、v1 封筒・snapshot は明示的に拒否される
    - snapshot 封筒の `ordering` が `{ revisions: string[] }` → `{ epoch, appliedSeq, applied (直近 200 件窓) }` に変更 (無限成長の解消)
    - transport 契約変更: `respondRequest` の patch が `(epoch, seq)`、`subscribeRequests` の onAdded から prevKey 引数を削除
- fork の待機をイベント駆動化 (ポーリングは安全網に格下げ)。直列処理 191ms/req → 2ms/req、host migration 回復 510ms → 10ms

### Fixed

- 既知の問題② (clock skew による request の無言ドロップ) を機構ごと根絶。順序が request id (端末時計) と無関係になった
- dual-host 窓で同一 seq が衝突した場合の収束を決定的 tiebreak (epoch → responsedBy) で保証し、敗者 request は host が新しい seq で再裁定して救済する (v1 は敗者救済なし)

## [0.1.0] - 2026-07-05

### Added

- Phase 1: 公開 API 境界の確定と core の移植・インスタンス化
    - `createSynqux` — transport / isSyncedAction / rootReducer 注入によるインスタンスベース API (モジュール変数の廃止)
    - `createSynquxRootReducer` — 「synqux 内部 → synced (meta.root なし) → locals (宣言順・meta.root 付き)」の直列 rootReducer helper
    - `stateWithError` / `stateWithResult` / `generateResult` — reducer (唯一の判定器) 用ヘルパー
    - `selectIsHost` / `selectPeers` / `selectSelfId` + `synqux/react` (`SynquxProvider` / `useIsHost` / `usePeers` / `useSelfId` / `useLatestResult`)
    - `synqux/testing` — `createMemoryHub` (fault injection つき決定的 in-memory transport) / `verifyActionIdempotency` / `assertActionIdempotency`
    - standalone (enabled=false) の local 永続化 (`localSnapshots` / `localStorageSnapshotStore`)
    - dev モード決定性検出網 (`devDeterminismCheck`)
    - snapshot / request 封筒に schema version を導入 (不一致は明示的に拒否)

### Fixed

- 移植元の既知の問題① (revisions の隣接二重記録): snapshot へ載せる revisions を response ack の前に評価固定
- 移植元の既知の問題①′ (同一 response の同時二重配送による二重適用): 同期的な処理中ガードを導入

- Phase 2: `synqux/firebase` — Firebase Realtime Database adapter (`firebaseTransport(db)`)。データ配置は移植元テンプレート互換 (`connections/` / `requests/` / `games/`)。firebase は optional peerDependency

### Notes

- 既知の問題② (clock skew による request 取りこぼし) は既知トレードオフとして残置。根治 (host 採番 seq) は Phase 3 (ADR-0001 Decision 10)
