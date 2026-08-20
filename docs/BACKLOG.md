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
- **automations の rule 間に順序保証がないことを明示する** (ADR-0015 の Amendment か README のどちらか)。engine は同一 snapshot に対し全 rule を走査して成立分を全て発行し、同一 tick 発行分は `requested` も同値になるため裁定順は transport 依存になる。ADR-0015 は自己終了契約と exactly-once なしは書いているが rule 間の相互作用に触れておらず、consumer が「1 tick 1 rule」を前提に演出順を rule の並び順で固定しようとして踏む (導入 consumer の実験モジュール設計で実際に踏んだ)。engine 側で直列化しない理由 — 排他リソースの競合は automation 同士だけでなく automation とユーザー操作の間でも起きるため engine では解消できない、優先順位は domain の事実である — まで併記し、「優先順位が仕様として存在する場合は単一 rule へ畳んで `action(synced)` が次の 1 件を選ぶ」を推奨形として示す
- ↑ 同じく全端末でやりたい local action などがある場合は host に synced を実行させてから extra reducer で全端末にすることを検討させるとか
- xxx
