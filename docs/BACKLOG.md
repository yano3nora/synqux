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

- **snapshot の単調性を fencing で保証する**
  - `saveSnapshot(key, payload)` が無条件上書きのため、旧 host の遅延書き込みが新 host の snapshot を巻き戻し、その後の prune と組み合わさると復元不能になる
  - `(epoch, appliedSeq)` の後退を拒否する CAS / transaction 等を ADR で決め、transport 契約と Firebase / memory adapter の競合テストへ反映する
  - 併せて restore の受理条件 `snapshot.appliedSeq > applied` を再判断する。現状は「同値 snapshot による早期適用是正」を拒否しており、snapshot の信頼性が fencing で確保されるなら `>=` 受理に緩められる (TASK-260719-ordering-restore-replacement で発見)
- **subscribe 初期化を transactional にし、途中失敗を rollback する**
  - connect 後の peer 購読、snapshot load/parse、request 購読の途中で失敗すると presence・購読・Redux session が残り、standalone も再試行不能になり得る
  - 各段階を逆順 cleanup し、失敗後の再 subscribe 成功までテストする
- **公開前の法務・version・配布物 gate を整える**
  - MIT を宣言しているが `LICENSE` 本文がないため追加する
  - 現在の `0.2.0` に breaking な Result API / wire v3 が混在している。`0.3.0` と `1.0.0` のどちらで出すか、README の「breaking は major」と 0.x 運用を含め人間が決める
  - stale `dist` を pack しないよう build → tarball を対象に main / react / testing / firebase の runtime import・型・schema version を smoke test する

### P1 — 本番境界と公開契約

- **wire / adapter 境界の入力検証と失敗通知を設計する**
  - 同一 schema の壊れた request / snapshot、Firebase 禁止文字や `/` を含む `groupId`、permission denied、offline 起動の無期限待機を扱う契約がない
  - reject / session 停止 / consumer 通知のどれにするかを ADR で決め、timeout・購読 cancel callback・副作用なしの拒否テストを追加する
- **main entry の内部 API 公開範囲を再判断する**
  - `synquxRestored` / `PendingRequest` は request 語彙と synced state 全量差替え action を公開しており、ADR-0001 の隠蔽方針と SPEC-0002 の一覧に一致しない
  - primitive 方式に本当に必要なら危険性を含め正式契約化し、不要なら export から外す。公開 surface の回帰テストを追加する
- **transport の request id 契約を seq 方式へ合わせる**
  - core は id 順を correctness に使わないのに「挿入順で辞書順単調」を要求している。group 内で一意・安定だけで十分か再判断し、SPEC・型コメント・adapter contract test を揃える
- **Firebase adapter の conformance gate を用意する**
  - SDK mock だけでなく、server timestamp、local echo が ack より先に届く順序、presence 再登録、retention query / archive を emulator で確認する小さな release gate を作る
  - `firebase >=9` / React 18+ を維持するなら最低対応版の import・型検査も行い、維持できないなら peer 範囲を実証済みに狭める
- **host 不在時の waiter メモリ増加を止める**
  - `createWaker().wait()` の timeout 済み callback が次の notify まで配列に残る。長時間 host 不在でも waiter 数が有界になるよう削除し、simulation test を追加する

### P2 — 文書・consumer 導入・コスト最適化

- **Firebase の本番 rules / data lifecycle checklist を用意する**
  - ADR-0009 のとおり cheat / tamper 耐性は対象外だが、意図しない room 間アクセスや情報漏えいを防ぐ認可、data shape、group 終了時の connections / requests / games / logs 削除は consumer 責務として残る
  - demo の全 read/write rules を流用せず、最初の consumer 導入時に実際の認証・room membership モデルへ合わせて checklist と rules 例を作る
- **完了済み ADR / 現実装との文書不整合を解消する**
  - ADR-0003 の「自動回復は未解決」、ADR-0001 の廃止済み `selectLatestResult`、ADR-0002 の旧 `error & console` 語彙、README の ADR-0008 欠落と demo の CI 対象説明、Firebase test の旧 `prevKey` コメントを更新する
- **consumer repo の action repeat contract を CI へ組み込む**
  - 全 synced action を `idempotent` / `rejects-repeat` / `repeatable` の table に載せ、無自覚な toggle は set 型へ移行する
- **snapshot 書き込み頻度を実運用計測後に見直す**
  - 全量 snapshot の帯域・料金が問題化した時点で、復元の単純性を壊さず N request ごと等へ削減する。判断前に payload サイズ・request 頻度・復旧時間を計測する
