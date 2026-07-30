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
- xxx

### P1 — 本番境界と公開契約
- xxx

### P2 — 文書・consumer 導入・コスト最適化
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
