# synqux Phase 3: 分散制御層の本格リファクタ

- Status: **完了 (2026-07-05、snapshot throttle のみ意図的に残置)。Phase 2 のテンプレ置換より前倒しで実施**
- 根拠: `ADR-0001-design.md` Decision 5 / 10、`SPEC-0001-requests-sync.md` 改善ロードマップ
- **順序変更の決定 (2026-07-05)**: 当初前提は「Phase 2 完了 = 消費者が semver に乗った状態」だったが、publish 保留により消費者ゼロの期間が生じたため前倒しする。消費者ゼロの今なら wire format 変更 (schema version bump) が無償で、テンプレは seq 済み形式へ一度で移行できる (静穏時間帯デプロイが 1 回で済む)。Decision 10 の実質的な前提「テスト基盤」は Phase 1 で完了済み
- 作業 branch: `phase3` (main は publish レビュー用に凍結)
- 実施順: 負荷実測 baseline → seq 化 + fencing (ADR-0002) → イベント駆動化 → 再計測。snapshot throttle は帯域問題が顕在化してから

## タスク

### 1. host 採番の連番 (seq) 導入 — **完了 (2026-07-05)**

- 設計の正: `ADR-0002-host-seq.md`。差し替えは想定どおり `ordering.ts` のモジュール交換 + 封筒の裁定印変更で完結 (Decision 10 保険 1 の回収)
- fencing: epoch (観測 max + 1 の host 世代) + responsedBy の決定的 tiebreak。敗者は host が新 seq で再裁定 (救済範囲は直近適用窓 200 件)
- ②は機構ごと根絶 (反転テストで固定)。`SYNQUX_SCHEMA_VERSION = 2`、0.2.0
- **実装中の重要な学び**: (a) 前 host の正当な in-flight 裁定を再採番すると適用列の分岐を作るため、再裁定対象は「seq スロットを別 request に取られた確定敗者」のみに限定 (b) markApplied は dispatch 直後 (同期) が正しい位置 — entity 消失と appliedSeq 前進の間に観測窓があると勝者誤認 race が起きる (SPEC の NOTE に明文化)

### 2. ポーリングのイベント駆動化 — **完了 (2026-07-05)**

- fork の待機を waker (state 変化の notify で起きる待機) へ。notify 点は peer 増減 / request 受信 / 適用完了の 3 種。1000ms タイムアウトは notify 取りこぼしの安全網に格下げ

### 3. 同時操作の負荷実測 — **baseline 取得済み (2026-07-05)**

計測: `src/core/protocol-latency.test.ts` (simulation 時間軸、fake timers)。上限 assert は新実装基準に締めてあり、ポーリング退行の回帰ガードとして機能する。

| シナリオ | v1 baseline | seq 化後 | + イベント駆動化 |
| --- | --- | --- | --- |
| 単発 request (自分が host) | 10ms | 10ms | 10ms |
| 直列 burst 20 requests (非 host 端末発) | 3,820ms (191ms/req) | 220ms (11ms/req) | **40ms (2ms/req)** |
| 交錯 30 requests (3 端末 × 10) | 5,830ms (194ms/req) | 230ms (8ms/req) | **60ms (2ms/req)** |
| host migration 回復 (離脱 → 滞留 request 適用) | 510ms | 510ms | **10ms** |

**読み**: v1 の支配項は request 1 件あたり約 2 回の 100ms ポーリング (prev 待機 + 適用完了待機)。seq 化 + markApplied 同期化で「順序が揃っていれば fork の初回チェックが即通る」構造になり大半が消え、waker のイベント駆動化で migration 回復 (1000ms 昇格監視) も配送遅延まで縮んだ。最終 ~500 req/秒相当で、想定人数の burst でも体感遅延は配送遅延のみ

### 4. snapshot 書き込み削減 (帯域コストが問題化してから)

- 「受理 request ごと」→ throttle (受理 N 件ごと / debounce) へ。**policy 点は `create-synqux.ts` の `persistSnapshot` / `persistLocalSnapshot` に隔離済み** (Decision 11)
- 差分永続化は不採用と決定済み (復元経路に新しいバグクラスを持ち込まない)。チャンク分割・圧縮は adapter 内部の自由

## 留意

- いずれも公開 API に影響しない見込み (requests / prev / revisions は Decision 7 で消費者から隠蔽済み)。破壊的変更が必要になった場合は ADR を起こす
- 分散制御のバグ修正は「そのバグを再現するテスト」を先に書く規律を維持 (AGENTS.md)
