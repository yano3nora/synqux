# synqux Phase 3: 分散制御層の本格リファクタ

- Status: **未着手 (計画)**
- 根拠: `ADR-0001-design.md` Decision 5 / 10、`SPEC-requests-sync.md` 改善ロードマップ
- 前提: Phase 2 完了 (消費者が synqux 依存になり、semver の中で安全に変更できる状態)

## タスク

### 1. host 採番の連番 (seq) 導入 — 既知の問題②の根治

- push id + 端末時計依存の順序判定を host 採番 seq に置き換え、clock skew による正当 request のドロップを根絶する
- **差し替え点は Phase 1 で `src/core/ordering.ts` に隔離済み** (Decision 10 保険 1)。snapshot 封筒の `ordering` フィールドごと差し替える
- 新規設計が必要なもの: dual-host 窓での採番衝突に対する fencing (host 世代番号等)
- wire format 変更になるため `SYNQUX_SCHEMA_VERSION` を increment (新旧混在は検出して明示的拒否 — Phase 1 で仕込み済み)。端末間バージョン混在は「exact pin / セッション進行中にデプロイしない」運用で吸収 (Decision 6)

### 2. ポーリングのイベント駆動化

- fork 内の 100ms sleep ループ (`REQUEST_LOOP_MS` / `HOST_PROMOTION_LOOP_MS`、移植元踏襲) を、ordering の状態変化通知によるイベント駆動へ

### 3. 同時操作の負荷実測

- 想定人数での prev チェーン直列処理のスループット・遅延を memory hub simulation で計測し、進行設計で吸収できるか判断する

### 4. snapshot 書き込み削減 (帯域コストが問題化してから)

- 「受理 request ごと」→ throttle (受理 N 件ごと / debounce) へ。**policy 点は `create-synqux.ts` の `persistSnapshot` / `persistLocalSnapshot` に隔離済み** (Decision 11)
- 差分永続化は不採用と決定済み (復元経路に新しいバグクラスを持ち込まない)。チャンク分割・圧縮は adapter 内部の自由

## 留意

- いずれも公開 API に影響しない見込み (requests / prev / revisions は Decision 7 で消費者から隠蔽済み)。破壊的変更が必要になった場合は ADR を起こす
- 分散制御のバグ修正は「そのバグを再現するテスト」を先に書く規律を維持 (AGENTS.md)
