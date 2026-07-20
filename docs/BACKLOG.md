# Backlogs — 未解決／積み残しタスク

> **Status: 常設 (クローズしない)**。未着手・保留・トリガー待ちのタスクを一元管理する唯一の置き場。
> 各 TASK の残項目はここに集約済みなので、過去 TASK を漁る必要はない。

## 運用ルール

1. 次の作業を始めるときは、ここから 1 件 pick して `TASK-YYMMDD-<slug>.md` を新規作成する
2. pick した項目は新 TASK へのリンクに差し替え、完了したらリンクごと項目を削除する
3. 新しい未解決事項が出たら、他の TASK には「BACKLOGへ追加」だけ書いてここへ追記する
4. ADR, SPEC の Open Questions と重複する項目は、決着時に ADR, SPEC 側も更新すること

## 次イテレーション候補

### P0 — 実践投入ブロッカー

- (なし — 0.3.0 の `npm version` / publish 実行はユーザ判断待ち。経緯は [TASK-260720-release-gate](TASK-260720-release-gate.md))

### P1 — 本番境界と公開契約

> 2026-07-20 の P1 評価で再構成し、同日中に全件解消。
> 入力検証の設計は縮小 (ADR-0009 で tamper 耐性は対象外と決定済みのため、同一 schema の
> 壊れた封筒への深い検証は YAGNI と判断)、request id 契約と emulator gate は P2 へ降格。
> 解消記録: [waker-timeout-cleanup](TASK-260720-waker-timeout-cleanup.md) /
> [wire-adapter-failure-handling](TASK-260720-wire-adapter-failure-handling.md) (ADR-0012) /
> [primitive-contract](TASK-260720-primitive-contract.md) /
> [firebase-peer-range](TASK-260720-firebase-peer-range.md)

- (なし)

### P2 — 文書・consumer 導入・コスト最適化

> 2026-07-20: 文書不整合の解消 (request id 契約の緩和を含む) は
> [TASK-260720-doc-consistency](TASK-260720-doc-consistency.md) で解消済み。
> 「consumer repo の action repeat contract を CI へ組み込む」は独立項目を廃止 —
> synqux 側の成果物 (`assertActionIdempotency` / ADR-0007 / SPEC-0001 設計ガイドライン 1) は
> 提供済みで、残作業は consumer repo 側の導入作業のみのため、下記 checklist 項目へ統合した

- **Firebase の本番 rules / data lifecycle checklist を用意する**
  - ADR-0009 のとおり cheat / tamper 耐性は対象外だが、意図しない room 間アクセスや情報漏えいを防ぐ認可、data shape、group 終了時の connections / requests / games / logs 削除は consumer 責務として残る
  - demo の全 read/write rules を流用せず、最初の consumer 導入時に実際の認証・room membership モデルへ合わせて checklist と rules 例を作る
  - 同じ導入タイミングで、action repeat contract の table 化 (`assertActionIdempotency` の mode 宣言つき table、ADR-0007) を consumer CI へ組み込むことも checklist に含める
- **Firebase adapter の emulator conformance gate を用意する (P1 から降格・firebase バージョン bump 時がトリガー)**
  - SDK mock だけでなく、server timestamp、local echo が ack より先に届く順序、presence 再登録、retention query / archive を emulator で確認する小さな release gate を作る
  - AGENTS.md の「emulator 依存テストを増やさない」方針と、bs-template 実導入 (Phase 2) が事実上の conformance gate になることから、平時の自動化は行わず firebase バージョン更新時に着手する
  - 見送りのデメリット: SDK の挙動変化 (server timestamp・local echo・presence まわり) を bump 時に SDK mock テストでは検知できず、consumer 側の実機で発覚する
- **snapshot 書き込み頻度を実運用計測後に見直す**
  - 全量 snapshot の帯域・料金が問題化した時点で、復元の単純性を壊さず N request ごと等へ削減する。判断前に payload サイズ・request 頻度・復旧時間を計測する
