# TASK-260825: dispatchAndWait の解決点を「適用直後」へ移す (nested dispatch による取り逃し修正)

- Date: 2026-08-25
- Status: Implemented (2026-08-25)
- 由来: TASK-260825 (result 述語化) のレビューで Codex が指摘した BACKLOG P1「standalone の dispatchAndWait × automation nested dispatch で pending が解決されない疑い」。再現テストで実在を確認した
- 関連: ADR-0015 (automations / dispatchAndWait), ADR-0018 (standalone session), ADR-0024 (hash による解決), SPEC-0001 設計ガイドライン (check-then-act)

## 問題

`dispatchAndWait` の standalone 分岐は「`store.dispatch()` から戻った後に `selectSynced(state).result` を読み、hash 照合して resolve する」後読み方式だった。standalone は request 化しないため middleware に await が入らず、dispatch は同期的に完了する — この「同期だから戻り値の時点で自分の result が state に載っている」という前提が、**nested dispatch で崩れる**。

```
dispatch(A) ─┬─ reducer で A 適用 (result = A)
             ├─ fireListenersAfterApply
             └─ evaluateAutomationsAfterApply
                  └─ standalone の evaluate は await を挟まないため同期継続
                       └─ dispatch(B) → reducer で B 適用 (result = B)  ← A を上書き
  ↓ return
selectSynced(state).result を読む → B の result → hash 不一致 → A の resolver が孤立
```

再現条件は「待っている action の適用によって automation の `when` が true になる」こと。導入 consumer は tutorial を standalone session で走らせ (ADR-0018)、automations は instance 設定のため standalone でも評価される。thunk が `dispatchAndWait` を使う構成と合わせて 3 点が揃っており、実配置で踏み得る。

症状は永久 pending。ただし README / 導入 consumer の推奨形どおり `AbortSignal.timeout()` を渡していれば timeout reject に縮退するため、**「適用は成功しているのに thunk が失敗として扱う」**という形で表面化する。

同型の穴は request 経路にもある (`selfId` 未確定の synced session は同じ local 適用経路へ落ちる) が、synced mode では automation の `evaluate` が `transport.serverNow()` を await するため同期の nested dispatch は起きない。

## 設計

### 解決点を「適用直後」へ移す (単一化)

`actionRequestMiddleware` の適用後ブロックで、**listener 発火・automation 評価より前**に `resolvePendingDispatch` を呼ぶ。この時点の `selectSynced(root).result` は適用中の action のものであることが契約で保証される (TASK-260825 設計 1.5「result に積む action は適用中の action」)。

```ts
const applied = next(action)

if (isSynced) {
  const root = store.getState() as TRoot
  emitAppliedResultLog(root, action as UnknownAction)
  resolvePendingDispatch(config.selectSynced(root).result)  // ← nested dispatch より前
  fireListenersAfterApply(root, action, true)
  evaluateAutomationsAfterApply()
}
```

- **後読みを全廃する**。`dispatchAndWait` の standalone 分岐 (dispatch 直後の resolve) と、request 配達 fork の適用後 resolve (`listener.dispatch` の直後) はどちらも同じ middleware ブロックを通るため削除する。解決点は「適用直後の 1 箇所」+「log 専用 error で dispatch を省略する経路の 1 箇所」の 2 つだけになる
- hash 照合は維持する。middleware は「誰が待っているか」を知らないため、`pendingDispatches` の map と hash による突き合わせは従来どおり必要 (ADR-0024)
- 契約 (ADR-0015 Decision 6「自端末でその action の裁定結果の処理が完了した時点で resolve」) は不変。resolve は microtask のため、consumer の継続は**現在の同期スタックが正常終了した後**に走る (通常経路では `markApplied` / determinism check / listener の同期実行の完了後)。ただし determinism check 等が throw した例外経路では `markApplied` 未実行のまま resolve 済みになり得る。**async listener / synced automation の継続との microtask 順は保証しない**

### 非対応 (既知の制約として残すもの)

- **nested dispatch が `synced.result` を上書きすること自体**は残る。`result` は「最後に適用された synced action の 1 件」を持つ transient な通知スロットであり (ADR-0008)、consumer が chain の外 (listener / dispatch 戻り後) で `result` を読む場合は同じ罠を踏む。action identity が必要な機構は hash で照合すること、という既存契約を ADR-0015 へ明文化する
- listener effect からの nested dispatch は `SynquxListener` の契約で既に禁止 (`effect から dispatch しないこと`) のため、対応しない

## タスク

- [x] `dispatch-and-wait.test.ts`: 再現テストを追加 (standalone + automation の nested dispatch で outer の result が resolve される)
- [x] `create-synqux.ts`: middleware の適用後ブロックで resolve、後読み 2 箇所を削除
- [x] `ADR-0015`: Amendment として解決点と「result は最新 1 件」の制約を追記
- [x] `BACKLOG.md`: P1 の当該項目を削除
- [x] `npm run fix` / `npm test`
- [x] Codex レビュー

## 影響

- breaking change なし (public API・契約とも不変。patch release 相当)
- 解決タイミングが微小に前倒しになる。通常経路の観測順 (適用後処理 → consumer 継続) は変わらないが、他の非同期 effect の継続との相対順は変わり得る
- 副次的な堅牢化: listener effect の同期 throw や determinism check の例外で fork の適用後処理が抜けても、resolve 済みのため pending が孤立しない (その場合 `markApplied` は未実行のまま resolve される)

## Codex レビュー (codex exec, 2026-08-25)

- 観点 1-3 (fork 側 resolve 削除の安全性 / markApplied より前の resolve / 再現テストの十分性) はいずれも問題なしと確認。`listener.dispatch` は RTK の `MiddlewareAPI.dispatch` で store 先頭から全 middleware を再通過するため適用後ブロックへ到達する、production code に同型の result 後読みは残っていない、との独立確認を得た
- 指摘 (軽微): docs が「consumer からの観測順は不変」と言い切りすぎ。async listener / synced automation の継続との microtask 順は変わり得るし、determinism check が throw すれば resolve 済みでも markApplied は未実行になる
    - → 反映済み。TASK / ADR とも「現在の同期スタックの正常終了後に走る。非同期 effect との順序は保証しない」へ限定した
