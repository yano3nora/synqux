# TASK-260719: host 裁定の失敗状態分離と fork の適用完了までの生存

> BACKLOG P0「host 裁定の失敗状態を分離し、response 確定後の上書きを禁止する」
> と P0「未裁定 request の response 失敗を retry し、fork を適用完了まで生存させる」の解消タスク。
> 両者は `spawnHostFork` の同一 catch 構造が根のためセットで扱う。
> 設計の正は [ADR-0010](ADR-0010-response-immutability-and-fork-survival.md)。

## 実装概要

`spawnHostFork` (src/core/create-synqux.ts) の裁定部を再構成する:

1. 試し実行までで response 封筒を凍結 (成功 / reducer throw の error 拒否のどちらも)
2. 凍結済み response を ack まで同一内容で再送 (間隔 WAKE_FALLBACK_MS)。離脱条件: 適用済み / entity 消滅 / host 交代 / session 終了 (離脱時 retractIssue)
3. snapshot / prune は確定後の後処理として分離。snapshot 失敗は log のみ + prune スキップ
4. 裁定後も break せず、isApplied まで fork を生存させる

## テスト計画 (MemoryHub へ failure injection を追加して固定)

- MemoryHub 追加 fault: `failRespond(requestId, { times })` (未コミットで reject) / `loseAck(requestId)` (コミット・配送するが reject = ack 喪失) / `failSnapshot({ times })`
- [x] snapshot 失敗が success を error で上書きしない (全端末が success を適用、分岐なし)
- [x] ack 喪失で同一内容が再送され、error は一度も配信されず収束する
- [x] respond 連続失敗 → 後に成功で裁定が完了し、未裁定滞留が起きない
- [x] 再送中の host 交代で旧 fork が退場し、新 host の裁定で収束する
- [x] ack 前 local echo + 同一 seq 衝突でも dual-host 敗者が再裁定される
- [x] 既存 156 tests green (裁定成功パスの挙動不変)

## 完了条件

- [x] 上記テスト全て green (バグ再現テストは red を先に確認)
- [x] SPEC-0001 の関連記述 (対策済み表・host fork・不変条件) を更新
- [x] ADR-0010 を Accepted へ更新
- [x] `npm run fix` / `npm test` pass
