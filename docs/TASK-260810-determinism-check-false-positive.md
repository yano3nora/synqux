# TASK-260810: Determinism check の false positive (照合タイミング起因) の修正

- Date: 2026-08-10
- Status: Resolved (unreleased — 次 release に含める)
- 由来: 導入プロジェクトの実機検証で「1 秒未満の間隔の連続操作 (nextTalk 連打など) のたびに Determinism check failed が出る」観測。v0.4.0 の diff 診断で `result.action.meta.dispatched` の divergence として特定された

## 原因

`requestListener` の適用 fork が、照合 (`verifyDeterminism`) を「内部 entities 消滅待ち」の**後**に行っていた:

```
listener.dispatch(action_N)            // 同期適用
ordering.markApplied → waker.notify()
await waitUntilOrFail(entity 消滅, { intervalMillis: WAKE_FALLBACK_MS })  // ← ここ
verifyDeterminism(id, getState())      // ← poll 通過後の「現在の」state を読む
```

- `waitUntilOrFail` (ts-utils) は `setInterval` 実装で**初回判定が interval (1000ms) 経過後**。
  entity は dispatch 内で同期消滅しているのに、必ず 1000ms 待ってから照合していた
- その 1000ms の間に次の request N+1 が適用されると、`getState()` は N+1 適用後の state を返し、
  N の期待値 (host 試し実行) と比較して divergence になる
- 観測される divergence が「actual(N) == expected(N+1) の連鎖」「バースト最後の request だけ
  失敗しない」「in-memory 逐次テストでは再現しない」のはすべてこの機序で説明される

## 修正

照合を `listener.dispatch` 直後 (await を挟まない同期位置) へ移動した。dispatch は同期のため、
この時点の `getState()` だけが「この request 適用直後」の state を正確に指す。
markApplied / waker.notify / entity 消滅待ちの順序は従来のまま。

- `src/core/create-synqux.ts` — verifyDeterminism の呼び出し位置を移動
- `src/core/determinism-check.test.ts` — 回帰テスト追加
  「entity 消滅待ち poll より速く後続 request が適用されても false positive にならない」
  (poll 初回判定 (1000ms) 前に 2 つ目の request を適用させる。旧実装で red を確認済み)

## 検証

- `npm test` 全緑 (198 tests)
- 導入プロジェクトの実機 repro (firebase emulator + headless Chrome、
  クリック間隔 ~900ms で nextMessage/nextTalk 26 連打 + executeAction):
  修正前 24 件 → 修正後 0 件
