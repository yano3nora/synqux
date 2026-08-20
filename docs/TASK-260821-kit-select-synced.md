# TASK-260821: kit への selectSynced 集約 (matchers の全束縛化)

- Date: 2026-08-21
- 関連: ADR-0025 の Amendment (kit への selectSynced 集約)、
  TASK-260820-synced-action-registry の続き

## 背景 / 決定

導入 consumer の追従で「matchers 生成のためだけに selectSynced を再供給する
1 ファイル」が残った。synced の位置 (root 内の key) を教える責任は consumer に
ある (key 命名は consumer の領域、synqux の予約は `state.synqux` のみ) が、
供給点は kit の 1 箇所に畳める:

1. `createSynquxKit<T>({ selectSynced })` として factory が selectSynced を受ける
2. kit は `isSucceededAction` / `isMySucceededAction` を全束縛済みで直接返す。
   kit 版 `createSyncedActionMatchers` factory は廃止 (core 版は primitive 方式用)
3. `createSynquxRootReducer` の synced record key (state 構成の宣言) とは役割が
   異なるため統合しない

## 作業項目

- [x] `kit.ts`: factory 引数追加・matchers の直接 spread・doc 更新
- [x] テスト / demo の kit 呼び出し追従
- [x] ADR-0025 Amendment・SPEC-0002・README
- [x] `npm run fix` / `npm test` (392 tests 全 green)
- [x] Codex レビュー → Approve (docs 2 箇所の追従指摘のみ、修正済み)
