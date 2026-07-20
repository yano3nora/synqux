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

> 2026-07-20 の P1 評価で再構成。入力検証の設計は縮小 (ADR-0009 で tamper 耐性は対象外と
> 決定済みのため、同一 schema の壊れた封筒への深い検証は YAGNI と判断)、request id 契約と
> emulator gate は P2 へ降格。waiter メモリ増加は [TASK-260720-waker-timeout-cleanup](TASK-260720-waker-timeout-cleanup.md)、
> wire / adapter 境界の失敗系は [TASK-260720-wire-adapter-failure-handling](TASK-260720-wire-adapter-failure-handling.md) (ADR-0012) で解消済み

- **primitive 方式 (手書き rootReducer) を正式契約化する**
  - 方針決定済み (2026-07-20): `createSynquxRootReducer` と手書き rootReducer の両方を受け入れる。よって `synquxRestored` / `PendingRequest` の export は継続し、「再判断」ではなく契約化タスクに縮小
  - SPEC-0002 の公開一覧へ追加し、primitive 方式の契約を明文化する — mount 位置は `state.synqux` 固定、rootReducer での `synquxRestored` match 処理が必須、consumer が自分で dispatch するのは禁止 (自端末だけ synced が差し替わり desync する) を危険性として明記
  - `src/index.ts` の export 一覧を assert する公開 surface 回帰テストを追加する
  - 見送りのデメリット: 未文書の内部 API が事実上の公開契約として固定され、0.3.0 publish 後の変更は semver major になる。文書化が最安なのは publish 前の今
- **firebase peer 範囲 (`>=9`) の宣言が実証済みか検証する**
  - ランタイムで弾く機構は作らない (バージョン不整合の警告は npm の peer 解決に任せる)。adapter が使う modular API (`runTransaction` / `startAfter` / `orderByKey` 等) が宣言最低版で型ごと通るかを一度検証する話
  - scratch dir に firebase@9.0.0 を入れて adapter の tsc が通るか確認し、通らなければ宣言を実証済みの範囲 (例: `>=10`) へ狭める。RTDB の `startAfter` は v9 系追加 API のため 9.0.0 当初から存在したかが特に怪しい
  - 見送りのデメリット: 未実証の peer 範囲のまま publish され、古い firebase を使う consumer で install 後に型エラー・実行時エラーとして発覚する

### P2 — 文書・consumer 導入・コスト最適化

- **Firebase の本番 rules / data lifecycle checklist を用意する**
  - ADR-0009 のとおり cheat / tamper 耐性は対象外だが、意図しない room 間アクセスや情報漏えいを防ぐ認可、data shape、group 終了時の connections / requests / games / logs 削除は consumer 責務として残る
  - demo の全 read/write rules を流用せず、最初の consumer 導入時に実際の認証・room membership モデルへ合わせて checklist と rules 例を作る
- **完了済み ADR / 現実装との文書不整合を解消する**
  - ADR-0003 の「自動回復は未解決」、ADR-0001 の廃止済み `selectLatestResult`、ADR-0002 の旧 `error & console` 語彙、README の ADR-0008 欠落と demo の CI 対象説明、Firebase test の旧 `prevKey` コメントを更新する
  - transport の request id 契約も seq 方式へ合わせて修正する (P1 から統合・降格): core は id 順を correctness に使っていない (dedup の set membership のみ) のに「挿入順で辞書順単調」を要求している。group 内で一意・安定へ緩和し、SPEC・型コメント・adapter contract test を揃える
  - 見送りのデメリット (request id 契約): 現 adapter は firebase のみで push id が単調のため実害はないが、将来の adapter 実装者が不要な単調 id 採番を作り込むコストと、契約と実装の乖離が残り続ける
- **Firebase adapter の emulator conformance gate を用意する (P1 から降格・firebase バージョン bump 時がトリガー)**
  - SDK mock だけでなく、server timestamp、local echo が ack より先に届く順序、presence 再登録、retention query / archive を emulator で確認する小さな release gate を作る
  - AGENTS.md の「emulator 依存テストを増やさない」方針と、bs-template 実導入 (Phase 2) が事実上の conformance gate になることから、平時の自動化は行わず firebase バージョン更新時に着手する
  - 見送りのデメリット: SDK の挙動変化 (server timestamp・local echo・presence まわり) を bump 時に SDK mock テストでは検知できず、consumer 側の実機で発覚する
- **consumer repo の action repeat contract を CI へ組み込む**
  - 全 synced action を `idempotent` / `rejects-repeat` / `repeatable` の table に載せ、無自覚な toggle は set 型へ移行する
- **snapshot 書き込み頻度を実運用計測後に見直す**
  - 全量 snapshot の帯域・料金が問題化した時点で、復元の単純性を壊さず N request ごと等へ削減する。判断前に payload サイズ・request 頻度・復旧時間を計測する
