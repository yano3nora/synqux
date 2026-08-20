# TASK-260820: action identity 契約化と consumer 型語彙の配布 (0.14.0)

- 目的: 導入 consumer (具体名は git 管理外の CLAUDE.local.md 参照) の実測で確定した「本来ライブラリが担うべき残留 boilerplate」を吸収し、**react / redux-toolkit を知る開発者が wrapper ゼロで書ける**状態にする
- 設計判断の経緯と決定は導入 consumer 側の TASK doc とユーザレビューで確定済み。本 repo では ADR-0024 / ADR-0025 / ADR-0007 Amendment として記録

## 実装内容

- [x] `src/core/action.ts` 新設
    - `generateActionHash`: 採番を ulid (monotonic factory、`ulid` を dependencies へ追加) に変更。26 文字 Crockford base32 を契約化 (ADR-0024)
    - `createSyncedAction`: RTK createAction 互換 + 生成時に hash / dispatched を stamp。`SyncedActionMeta` (required) が creator の戻り型に乗り、`builder.addCase` が注釈なしで meta 込み推論する (ADR-0025)
    - 型 export: `SyncedActionHash` / `SyncedActionMeta<TRoot>` / `SyncedAction<P, TRoot>` / `LocalAction<P, TRoot, TMeta>` / `CreateSyncedAction`
- [x] `src/core/kit.ts` 新設: `synquxKit.withTypes<{ synced, root, message? }>()` — createSyncedAction / createSyncedActionMatchers / generateResult / stateWithResult / stateWithError / stateWithTransaction を型束縛済みで配布 (ADR-0025)
- [x] `create-synqux.ts`: 内部 `generateHash` を撤去し `generateActionHash` へ。metaSetter を fallback 化し field 単位補完へ (既存 hash 素通しによる dispatched 欠落バグの修正、ADR-0024 Decision 4)。`dispatchAndWait` は action の既存 hash を尊重
- [x] `src/testing/idempotency.ts`: 1 回目は未付与 meta の補完、**2 回目は hash / dispatched を再生成** (「同じ意図の別 request」の忠実な再現、ADR-0007 Amendment、breaking)
- [x] `src/testing/root-state.ts` 新設: `createTestRootState(locals, synqux?)` — consumer テストの `synquxReducer(undefined, {type:'@@INIT'})` 直呼び (primitive 方式の脱出口の用途外利用) を公式化
- [x] `src/core/types.ts` / SPEC-0002: 「判定に使ってよい meta」を requestedBy / dispatched / hash の 3 つ組へ改訂。hash doc を公開識別子として書き換え
- [x] docs: ADR-0024 / ADR-0025 新規、ADR-0007 Amendment、README (Usage 節 + API Reference)、`src/index.test.ts` の公開 surface 目録更新
- [x] version 0.14.0 (SYNQUX_VERSION / package.json)。`npm test` 全 green (vitest 38 files 360 tests / oxlint / oxfmt / tsc / tsc-demo)

## codex レビュー対応 (2026-08-20)

- P0: 「再 dispatch は重複排除」と文書が主張していたが未実装 → **契約を「再 dispatch 禁止 (機構は重複排除しない)」へ訂正**し、dispatchAndWait に同一 hash pending の明示 reject を追加。機構的な排除は BACKLOG へ
- P1: prepare meta の型合成 (`meta: undefined` で型が壊れる / 予約 key が any) → `Omit<M, keyof SynquxActionMeta> &` 合成へ。runtime は共通の `normalizeSyncedActionMeta` (typeof 検証) を creator / metaSetter / ハーネスで共有
- P1: RTK 完全互換ではない → 公称を「主要 2 overload 互換」へ弱め、optional payload (`undefined extends P`) のみ追従
- P2: `isDeliveredSyncedAction` へ hash 検査追加 / `createTestRootState` の deep clone 化 / idempotency 2 回目の配達系 meta 除去 / SPEC-0002 A1 へ新 API シグネチャ追記
- 機密: 公開 docs の consumer 実名・具体情報を一般化 (CLAUDE.local.md 参照へ)

## Breaking (0.14.0 release notes に明記すること)

- `assertActionIdempotency` / `verifyActionIdempotency` の 2 回目適用が別 hash / dispatched になる。同一 hash の重複排除に依存して `'idempotent'` を通していた宣言は fail し得る (それ自体が検出したかった偽陰性。repeatable 化 or 専用 action 化で見直す)
- hash の形式が独自形式 → ulid に変わる。synqux は不透明文字列として扱うため動作影響はないが、既存永続 state とは形式混在になる (migration なし、consumer は reset で収束)
- `dispatchAndWait` が同一 hash の待機中再発行を reject するようになる (従来は resolver を silent に上書きし、先発の Promise が永久未解決になっていた)
- `isDeliveredSyncedAction` が hash も検査するようになる (契約上、配達済み action は必ず hash を持つため実挙動への影響はない想定)

## 積み残し (BACKLOG へ)

- isSyncedAction の library 導出 (creator registry 方式)。ADR-0025 Open Questions 参照
- demo の createSyncedAction / synquxKit への移行 (現状は素の action + metaSetter fallback で動作。README の実例は更新済みだが demo コードは旧方式のまま)

## 追従 (consumer 側)

- 導入 consumer: kit への移行・自作型 / stamper / results wrapper の削除は consumer repo 側の TASK doc で実施 (具体名は CLAUDE.local.md 参照)
- release / publish は人間判断 (prepublishOnly が test + build + smoke を通す)
