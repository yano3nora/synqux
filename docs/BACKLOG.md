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
- **同一 hash の再 dispatch の機構的な検出・排除を検討する** (ADR-0024)。現状は「再 dispatch 禁止」の契約 + dispatchAndWait の同一 hash reject のみで、素の store.dispatch の再発行は二重適用される。request 経路 (端末ローカル) での同一 hash drop が実装点候補だが、request 裁定の不変条件・restore replay との干渉を要検討
- **isSyncedAction の library 導出 (creator registry 方式) を検討する** (ADR-0025 Open Questions)。createSyncedAction が type を registry へ登録すれば consumer の手書き predicate を無くせるが、「全 synced action が createSyncedAction 経由」が前提になり createSlice reducers 由来の synced action は移行が要る。導入 consumer の kit 追従の実測を見てから判断する
- **demo を createSyncedAction / synquxKit へ移行する** (TASK-260820-action-identity)。現状は素の action + metaSetter fallback で動作しており README の実例と食い違う
- **automations の rule 間に順序保証がないことを明示する** (ADR-0015 の Amendment か README のどちらか)。engine は同一 snapshot に対し全 rule を走査して成立分を全て発行し、同一 tick 発行分は `requested` も同値になるため裁定順は transport 依存になる。ADR-0015 は自己終了契約と exactly-once なしは書いているが rule 間の相互作用に触れておらず、consumer が「1 tick 1 rule」を前提に演出順を rule の並び順で固定しようとして踏む (導入 consumer の実験モジュール設計で実際に踏んだ)。engine 側で直列化しない理由 — 排他リソースの競合は automation 同士だけでなく automation とユーザー操作の間でも起きるため engine では解消できない、優先順位は domain の事実である — まで併記し、「優先順位が仕様として存在する場合は単一 rule へ畳んで `action(synced)` が次の 1 件を選ぶ」を推奨形として示す
- xxx
