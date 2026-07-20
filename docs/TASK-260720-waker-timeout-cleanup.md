# TASK-260720: waker の timeout 済み waiter 残留を解消

> BACKLOG P1「host 不在時の waiter メモリ増加を止める」の解消タスク。
> あわせて同日の P1 評価に基づく BACKLOG 再構成 (縮小・降格・見送りデメリット追記) を実施。

## 問題

`createWaker().wait()` の timeout 済み callback が `waiters` 配列から除去されず、
次の `notify()` の全消しまで残留していた。host 不在で notify が来ない静止状態では
fallback loop (`WAKE_FALLBACK_MS` = 1000ms) が毎秒 1 closure を積み続け、
waiter 数が無限成長する (放置タブで約 8.6 万個/日/fork)。

## 実装概要

1. `waiters` を配列から `Set` へ変更し、timeout 経由の resolve 時に自分自身を
   `delete` する (notify 経由では新 Set へ差し替え済みのため delete は no-op)
2. テスト用に `waiterCount()` を追加し、`createWaker` を named export 化
   (公開 API `src/index.ts` には含めない)

## テスト計画

- [x] unit (red 必須): notify なしで timeout → 再 wait を 100 回繰り返しても
  waiter が残留しない (修正前: 100 残留の red を確認)
- [x] unit: notify が待機中の全 waiter を起こして解放する
- [x] 既存 178 tests green (計 180)

## 完了条件

- [x] 上記テスト全て green (red 必須のものは red を先に確認)
- [x] BACKLOG の該当項目を削除し、P1 評価の方針 (縮小・降格) を反映
- [x] `npm run fix` / `npm test` pass
