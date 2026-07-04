# synqux Phase 3: 分散制御層の本格リファクタ

- Status: **着手 (2026-07-05)。Phase 2 のテンプレ置換より前倒し**
- 根拠: `ADR-0001-design.md` Decision 5 / 10、`SPEC-requests-sync.md` 改善ロードマップ
- **順序変更の決定 (2026-07-05)**: 当初前提は「Phase 2 完了 = 消費者が semver に乗った状態」だったが、publish 保留により消費者ゼロの期間が生じたため前倒しする。消費者ゼロの今なら wire format 変更 (schema version bump) が無償で、テンプレは seq 済み形式へ一度で移行できる (静穏時間帯デプロイが 1 回で済む)。Decision 10 の実質的な前提「テスト基盤」は Phase 1 で完了済み
- 作業 branch: `phase3` (main は publish レビュー用に凍結)
- 実施順: 負荷実測 baseline → seq 化 + fencing (ADR-0002) → イベント駆動化 → 再計測。snapshot throttle は帯域問題が顕在化してから

## タスク

### 1. host 採番の連番 (seq) 導入 — 既知の問題②の根治

- push id + 端末時計依存の順序判定を host 採番 seq に置き換え、clock skew による正当 request のドロップを根絶する
- **差し替え点は Phase 1 で `src/core/ordering.ts` に隔離済み** (Decision 10 保険 1)。snapshot 封筒の `ordering` フィールドごと差し替える
- 新規設計が必要なもの: dual-host 窓での採番衝突に対する fencing (host 世代番号等)
- wire format 変更になるため `SYNQUX_SCHEMA_VERSION` を increment (新旧混在は検出して明示的拒否 — Phase 1 で仕込み済み)。端末間バージョン混在は「exact pin / セッション進行中にデプロイしない」運用で吸収 (Decision 6)

### 2. ポーリングのイベント駆動化

- fork 内の 100ms sleep ループ (`REQUEST_LOOP_MS` / `HOST_PROMOTION_LOOP_MS`、移植元踏襲) を、ordering の状態変化通知によるイベント駆動へ

### 3. 同時操作の負荷実測 — **baseline 取得済み (2026-07-05)**

計測: `src/core/protocol-latency.test.ts` (simulation 時間軸、fake timers)。イベント駆動化の前後比較用に上限 assert を回帰ガードとして固定してある。

| シナリオ | baseline |
| --- | --- |
| 単発 request (自分が host) | 10ms |
| 直列 burst 20 requests (非 host 端末発) | 3,820ms (191ms/req) |
| 交錯 30 requests (3 端末 × 10) | 5,830ms (194ms/req) |
| host migration 回復 (離脱 → 滞留 request 適用) | 510ms |

**読み**: 直列処理は端末数によらず ~190ms/req で頭打ち = 支配項は競合ではなく **request 1 件あたり約 2 回の 100ms ポーリング** (prev 待機 + 適用完了待機)。スループット ~5 req/秒は協力型・ターン制の想定人数では実用域だが、burst 時は体感遅延として積み上がる。migration 回復の支配項は 1000ms の host 昇格監視。イベント駆動化の目標は「/req を配送遅延 (~10ms) まで落とす」

### 4. snapshot 書き込み削減 (帯域コストが問題化してから)

- 「受理 request ごと」→ throttle (受理 N 件ごと / debounce) へ。**policy 点は `create-synqux.ts` の `persistSnapshot` / `persistLocalSnapshot` に隔離済み** (Decision 11)
- 差分永続化は不採用と決定済み (復元経路に新しいバグクラスを持ち込まない)。チャンク分割・圧縮は adapter 内部の自由

## 留意

- いずれも公開 API に影響しない見込み (requests / prev / revisions は Decision 7 で消費者から隠蔽済み)。破壊的変更が必要になった場合は ADR を起こす
- 分散制御のバグ修正は「そのバグを再現するテスト」を先に書く規律を維持 (AGENTS.md)
