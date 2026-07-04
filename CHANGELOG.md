# Changelog

本パッケージは [semver](https://semver.org/lang/ja/) に従う。消費者 repo は「テンプレは ^latest 追従、出荷済みプロジェクトは exact pin」で運用する (ADR-0001 Decision 6)。

## [Unreleased]

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
