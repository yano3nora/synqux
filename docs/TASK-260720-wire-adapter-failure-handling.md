# TASK-260720: wire / adapter 境界の失敗系を整える

> BACKLOG P1「wire / adapter 境界の失敗系を整える」の解消タスク。
> 設計の正は [ADR-0012](ADR-0012-transport-failure-and-abort.md)。
> 方針決定 (ユーザ判断): ① 接続待機の打ち切りは AbortSignal (省略時は無期限待機)、
> ② 購読死亡時は unrecoverable health で consumer に委ねる、③ 0.3.0 (未リリース) に含める。

## 実装概要

1. transport 契約 8 (失敗通知) を追加 (types.ts): `subscribePeers` / `subscribeRequests`
   handlers の `onError?(error: unknown)`。optional は caller 都合で、渡された onError の
   発火は adapter の義務 (型では強制できないため契約文書で課す)
2. core: onError → `unrecoverable` health (即時 dispatch + heartbeat で維持)。
   gap なしの ok 巻き戻しより優先。自動リトライなし、回復は unsubscribe → 再 subscribe。
   teardown 後の遅延 onError は `torndown` フラグで無視
3. `subscribe` / transport `connect` に `signal?: AbortSignal` を追加。core は初期化の
   各 await 境界で検査し、既存の transactional rollback で後始末。省略時は無期限待機
4. Firebase adapter: `.info/connected` 待ちを abort と race、presence 書き込み後の
   abort は登録を取り消して reject。購読 (onChildAdded / onChildChanged / onChildRemoved)
   に cancel callback を登録して onError へ引き渡し。groupId の RTDB key 禁止文字ガード
5. memory hub: `faults.cancelSubscriptions(peerId)` (打ち切り注入)、connect の
   abort 検査 (同期完了のため入口のみ)

## テスト計画

- [x] simulation (red 必須): 購読打ち切り → unrecoverable、heartbeat で ok へ巻き戻されない、
  他端末は同期継続 (`src/core/transport-failure.test.ts`)
- [x] simulation: 打ち切り後 unsubscribe → 再 subscribe で回復
- [x] simulation: abort 済み signal は即 reject / 初期化中 abort は rollback され presence が残らず、
  再 subscribe できる
- [x] Firebase unit (SDK mock): groupId 禁止文字の入口拒否、offline 中 abort での
  接続待ち打ち切り + リスナー解除、presence 書き込み後 abort の登録取り消し、
  requests / peers 購読 cancel → onError
- [x] 既存 180 tests green (計 189)

## 完了条件

- [x] 上記テスト全て green (red 必須のものは red を先に確認)
- [x] ADR-0012 作成、SPEC-0001 (対策済み表)・SPEC-0002 (subscribe / transport 型)・
  CHANGELOG (breaking 含む) を更新
- [x] BACKLOG の該当項目を削除
- [x] `npm run fix` / `npm test` pass
