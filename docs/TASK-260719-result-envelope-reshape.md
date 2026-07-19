# TASK-260719: Result / 封筒形状の刷新

- Status: **Done (2026-07-19)**
- 決定の背景と内容: `docs/ADR-0008-result-envelope-reshape.md`

## やったこと

- `Result.message` を `undefined | { text: string }` (TMessage generics で拡張可) へ構造化
- `Result.console` / `Result.duration` を削除し `log?: string` へ置換
    - log の console 出力 (`console.log` / `console.error`、targets 準拠) を synqux の責務化
    - log 専用 error (message なし) の dispatch 省略は v2 の `error && console` の挙動を継承
- `RequestEnvelope.responsed` (裁定時刻) を追加。host fork が `issueSeq()` 後に `serverNow()` で取得し `respondRequest` patch へ含める (memory hub / firebase adapter 追従)
- `SYNQUX_SCHEMA_VERSION` 2 → 3
- SPEC-0001 (設計上の割り切り・Trouble Shooting)、SPEC-0002 (型シグネチャ・wire format)、README・demo を追従
- テスト: results / characterization / create-synqux / react / idempotency / memory-hub / firebase を新形状へ更新し、responsed 焼き込み・message 拡張 generics・success+log 出力 (`game/announce`) の検査を追加

## レビュー対応 (codex)

- major: `responsed` の `serverNow()` await が「current 読み取り → 直列ゲート判定 → seq 発行 → 試し実行 → orderingState 評価固定」の同期ブロック内 (issueSeq 直後) にあり、待機中の host 交代・response 適用で古い土台のまま裁定する窓が開いていた → 取得を state 読み取りの前へ移動 (ADR-0008 追従)
- minor: SPEC-0002 の `stateWithResult` / `generateResult` / `useLatestResult` シグネチャと export 一覧へ `TMessage` / `ResultMessage` を反映
- minor: log 契約のテスト強化 — targets 準拠 (依頼元のみ出力) の回数検査、changed 重複配送での二重出力なしを追加

## 残項目

なし (BACKLOG へ追加した項目もなし)
