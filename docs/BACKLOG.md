# Backlogs — 未解決／積み残しタスク

> **Status: 常設 (クローズしない)**。未着手・保留・トリガー待ちのタスクを一元管理する唯一の置き場。
> 各 TASK の残項目はここに集約済みなので、過去 TASK を漁る必要はない。

## 運用ルール

1. 次の作業を始めるときは、ここから 1 件 pick して `TASK-YYMMDD-<slug>.md` を新規作成する
2. pick した項目は新 TASK へのリンクに差し替え、完了したらリンクごと項目を削除する
3. 新しい未解決事項が出たら、他の TASK には「BACKLOGへ追加」だけ書いてここへ追記する
4. ADR, SPEC の Open Questions と重複する項目は、決着時に ADR, SPEC 側も更新すること

## 次イテレーション候補

### response 欠落による seq gap の検知・自己回復

- **完了**: iteration 1 の検知は [`TASK-260718-sync-health-iteration1.md`](./TASK-260718-sync-health-iteration1.md) (ADR-0003)、iteration 2 の段階的自動回復と host 昇格群停止テストは [`TASK-260718-sync-auto-recovery.md`](./TASK-260718-sync-auto-recovery.md) (ADR-0004) で対応済み

### requests の retention (prune) が未実装

- SPEC-0001 は「snapshot 地点より古い requests の prune」を transport の retention 契約として前提に書いているが、firebase adapter に prune 実装が無く requests は無限成長する
- 復帰時の全量購読コスト・帯域・メモリがセッション長に比例して増える。長時間セッション・request 頻度の高いゲームで実害が出る
- prune の主体 (host が snapshot 永続化後に古い requests を削除する等)、直近適用窓 (200)・敗者救済・gap 回復の再購読との整合、途中参加端末が「snapshot + prune 後の requests」だけで追いつけることを設計で保証する

### 切断・再接続の presence 再登録

- firebase SDK は WebSocket を自動再接続するが、切断中に onDisconnect が発火して connections entry が消えた場合、復帰後に自分を再登録する経路が無い。他端末からは不在のままで、host にも昇格できない
- connect() 後の `.info/connected` を監視しておらず、consumer がオフラインを検知する手段も無い (移植元事故調査 B の「購読断」仮説と同型の盲点)
- `.info/connected` の true 復帰時に presence を再 set + onDisconnect 再登録する (adapter 内で完結し core の API 拡張は不要の見込み)。オンライン状態を health (上記 gap 項の器) へ載せるかは併せて検討

### 多端末同時操作の stress simulation test (CI)

- memory hub 上で N 端末 × M request の並行送信 + fault 注入 (重複・遅延・drop・host 強制切断) をシード付き乱数で回し、収束後に全端末の synced state と適用列 (seq → request id) が一致することを検証する property test を CI へ追加する
- fixture は順序敏感な state (append + running hash 等) にする。可換な counter では順序バグが素通りする
- demo の手動 stress mode (TASK-260717-demo-stress) の CI 版に相当し、「当たり前に動く」ことの継続的な担保をこちらが担う
