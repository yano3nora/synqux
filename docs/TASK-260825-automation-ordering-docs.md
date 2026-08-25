# TASK-260825: automations の rule 間に順序保証がないことの明文化

- Date: 2026-08-25
- Status: Implemented (2026-08-25)
- 由来: 導入 consumer の実験モジュール設計で「1 tick 1 rule」を前提に、演出順を `automations` 配列の並び順で固定しようとして踏んだ。ADR-0015 は自己終了契約と exactly-once なしは書いているが、rule 間の相互作用に触れていない
- 関連: ADR-0015 (automations), ADR-0002 (host 採番 seq), ADR-0007 (repeat contract), BACKLOG P2

## 問題

engine は 1 evaluation path で同一の synced state・同一の `now` に対し全 rule を走査し、`when` が成立した分を**すべて**発行する (`src/core/create-synqux.ts` の `startAutomationEngine`)。synced session では適用順は host が採番した `seq` 順だが、同時発行された request のどれが先に採番されるかは、裁定ループが `serverNow()` の await を挟んで直列ゲートを取り合う**未規定の競争**であり、**発行順・配列順からは何も保証されない**。

つまり `automations` 配列の並び順は**評価順であって適用順ではない**が、どちらのドキュメントにもその記述がない。consumer は「並べた順に 1 件ずつ発火する」と読み、演出順の仕様を rule の並び順へ埋め込む。

## 設計

ドキュメントのみの変更 (実装・API 変更なし)。

### 1. ADR-0015 に Amendment を追加する

「rule 間の適用順は保証しない」を決定として明文化し、**engine 側で直列化しない理由**まで併記する:

- 排他リソースの競合は automation 同士だけでなく automation とユーザー操作の間でも起きるため、automation の直列化では解決にならない (競合の裁定は「reducer が唯一の判定器」の原則どおり reducer が行う)
- 優先順位は domain の事実であり、engine が持てる汎用の順序規則は存在しない

推奨形は「**競合する rule を 1 本へ畳み、`action` が次の 1 件を選ぶ**」— 1 tick 1 発行になり、優先順位が domain のコードとして 1 箇所に残る。ただし `action` は synced state しか受け取らない (`now` は `when` のみ) ため、この形が表現できるのは state 由来の優先順位に限られる。時刻で候補が分かれる場合は汎用 action を 1 本発行し、reducer が `meta.dispatched` で対象を選択・検証する形を併記する。

### 2. README の automations 節に consumer 向けの記述を置く

- Behavior に「rule 間に順序保証はない」バレットを追加
- 「優先順位が仕様として存在する場合」の推奨形をコード例つきで提示
- 併せて「rule は synced action しか返せない。他端末に見せたい事実は synced state を通す — durable な事実は synced action 経由で synced state へ、各端末の決定的な追従は locals `extraReducers`、best-effort な live 演出のみ `listeners`」を 1 バレット追加 (listeners 節の contrast 記述と重複させず、automations の文脈に必要な分だけ)

## 完了条件

- [x] ADR-0015 に Amendment (2026-08-25) を追記
- [x] README automations 節に順序保証なし + 推奨形 + 全端末追従の記述を追加
- [x] BACKLOG P2 の該当 2 項目を削除
- [x] `npm run fix` / `npm test`
- [x] Codex review (順序記述の精度・listeners の保証水準・時刻由来の優先順位の 3 点を指摘 → 反映済み)
