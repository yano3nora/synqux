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
- コードベース全体の refactoring (残件)
    - `SynquxProvider` 存廃と engine 状態の所有権整理は [TASK-260816-provider-removal-and-state-ownership](TASK-260816-provider-removal-and-state-ownership.md) で完了 (ADR-0022 で Provider / result hooks / `Synqux.selectSynced` を削除、session 寿命の状態を `SessionSyncState` へ集約、所有権表を SPEC-0001 に明文化)
    - 公開 API 表面積の棚卸し: 消費者 repo 群での実利用実績と突き合わせ、未使用 export の deprecate 候補を洗い出す (YAGNI 方針の再適用)
    - `src/react/` の `state as WithSynqux` キャスト前提の整理 (context 前提は ADR-0022 で解消済み)

### P2 — 文書・consumer 導入・コスト最適化
- xxx
