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
- `SynquxProvider` と context 依存 hooks (`useLatestResult` / `useMyLatestResult`) の存廃を再検討する
    - 先行導入 consumer は `useSynquxSubscription` (Provider 不要) と core selectors (`selectIsHost` / `selectSelfId` / `isResultForPeer`) を自前の typed selector に組み込むだけで完結しており、`SynquxProvider` を配線していない
    - Provider の役割は result 系 2 hooks への `selectSynced` 解決のみだが、consumer は synqux instance を module から直接 import できるため context 経由にする動機が薄い。call-site で `<TAction, TMessage>` を毎回指定する generics も、typed selector を 1 つ書く方式に DX で劣る
    - 対応案: 2 hooks と Provider を deprecate → 削除 (breaking のため minor で deprecate, major で削除)。README には core selectors + typed selector の組み合わせを canonical として記載する
    - トリガー: テンプレート移行 (Phase 2) で Provider 無しの配線が成立することを確認してから着手。下記「コードベース全体 refactoring」とセットで実施する
- コードベース全体の refactoring (上記 `SynquxProvider` 存廃とセットで実施)
    - 公開 API 表面積の棚卸し: 消費者 repo 群での実利用実績と突き合わせ、未使用 export の deprecate 候補を洗い出す (YAGNI 方針の再適用)
    - `src/react/` の `state as WithSynqux` キャスト前提と context 前提が混在している構造の整理
    - breaking を伴う削除は deprecate (minor) → 削除 (major) の 2 段階で、Provider 存廃と同じ major に同梱する

### P2 — 文書・consumer 導入・コスト最適化
- xxx
