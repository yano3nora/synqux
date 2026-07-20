# TASK-260720: subscribe 初期化の transactional 化 (途中失敗の rollback)

> BACKLOG P0「subscribe 初期化を transactional にし、途中失敗を rollback する」の解消タスク。

## 問題

`src/core/create-synqux.ts` の `subscribe` は、初期化のどの段階で throw しても cleanup を行わない。

- **synced 経路**: `connect` → `subscribePeers` → `sessionStarted` dispatch → `loadSnapshot` / `parseSnapshotPayload` / `ordering.restore` → `subscribeRequests` → `session` 代入 → healthTimer。途中失敗すると presence・peers 購読・Redux session (`sessionStarted` 済み) が残る。さらに `session` 代入が最後尾のため、失敗後の再 subscribe は二重購読ガードを素通りして **二重 connect** になる
- **standalone 経路**: `session = { groupId }` を立ててから `localSnapshots.loadSnapshot` を await するため、ここで reject すると `session` が残り、以後 `'synqux is already subscribed'` で**再試行不能**になる
- **二重購読ガード自体の check-then-act**: `if (session)` 判定から `session` 代入まで複数の await を挟むため、並行 subscribe 呼び出しが両方通過し得る (AGENTS.md「check-then-act の間に await を挟まない」違反)

## 実装方針

1. **同期的な購読中ガード**: インスタンス変数 `let subscribing = false` を追加。subscribe 冒頭 (最初の await より前) で `if (session || subscribing) throw` → `subscribing = true`。成功時・rollback 完了時に必ず false へ戻す (`session` の代入位置・意味は変えない — `actionRequestMiddleware` の `shouldRequest` 挙動を維持するため)
2. **cleanup スタック方式の rollback**: 各段階が成功するたびに undo 関数を配列へ push し、途中で throw したら **逆順に実行**してから元の error を rethrow する
   - synced 経路の undo 対応: `connect` → `transport.disconnect()` / `subscribePeers` → `unsubscribePeers()` / `sessionStarted` → `sessionEnded` dispatch / `subscribeRequests` → `unsubscribeRequests()` / healthTimer → `clearInterval`
   - rollback 中の個々の cleanup 失敗は `console.error` で握って続行し、**元の error を throw する** (握りつぶさない)
   - `session` を自分の subscriptionSession が持っている場合のみ null へ戻す
3. **standalone 経路**: `loadSnapshot` / parse の失敗時に `session = null` + `sessionEnded` dispatch して rethrow
4. **ordering の残留は rollback しない**: 失敗前に `ordering.restore` 済みでも、再 subscribe 時の restore が全量置換する (a02947c) ため無害。コメントで明記する
5. 返り値の unsubscribe closure と rollback で cleanup 手順が二重実装にならないよう、可能なら共通化する (無理に共通化して読みにくくなるなら重複可、ただし手順・順序は一致させる)

## テスト計画 (red 必須: 各失敗段階の再現テストを先に書いて fail を確認)

テスト用に `createMemoryHub` の client transport を decorate し「指定メソッドを 1 回だけ throw させる」wrapper を **テストファイル内 helper** として作る (MemoryHub の公開 API は変更しない)。

- [x] `connect` 失敗 → `sessionStarted` が dispatch されず state 不変、再 subscribe が成功して通常同期できる
- [x] `subscribePeers` 失敗 → `disconnect` が呼ばれ presence が残らない (別端末の peers 観測で確認)、再 subscribe 成功
- [x] `loadSnapshot` reject → peers 購読解除・`sessionEnded`・`disconnect` 済み、再 subscribe 成功
- [x] 壊れた snapshot payload (`parseSnapshotPayload` throw) → 同上の rollback、再 subscribe 成功
- [x] `subscribeRequests` 失敗 → 同上の rollback (以後 request が届いても dispatch されない)、再 subscribe 成功
- [x] standalone: `localSnapshots.loadSnapshot` reject → `session` 解放 + `sessionEnded`、再 subscribe 成功
- [x] 並行 subscribe (await を挟んだ 2 連呼び出し) → 2 つ目が同期的に throw し、1 つ目は正常完了
- [x] 既存テスト全件 green

## 完了条件

- [x] 上記テスト全て green (red → green の順で実施)
- [x] `docs/SPEC-0001-requests-sync.md` に「subscribe 初期化は transactional (途中失敗は逆順 cleanup + rethrow、再 subscribe 可能)」の契約を追記
- [x] `CHANGELOG.md` の Unreleased / Fixed へ追記
- [x] `npm run fix` / `npm test` pass
