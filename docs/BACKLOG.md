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
- **0.15.0 release (breaking: TASK-260825) と導入 consumer の追従**。isSucceededAction / isMySucceededAction → state 述語 (isSucceededResult / isMySucceededResult)、stateWith* → with* rename。release (bump + publish) はユーザ判断・実行。consumer 側は locals の matcher 呼び出し 4 箇所を述語へ置換、synced extraReducers matcher の手書き hash 照合を `if (!isSucceededResult(state)) return` へ簡約 (誤った根拠コメントも修正)、rename やりきり
- xxx

### P2 — 文書・consumer 導入・コスト最適化
- xxx
