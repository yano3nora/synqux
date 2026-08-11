# TASK-260811: 動的 role 切替 (setRole) と observer → guest 改名

- Date: 2026-08-11
- Status: Implemented
- 由来: 消費者側で「起動時は host 候補にならない role で subscribe し、開始ボタンで player へ切り替える」実装が必要になった。移植元では presence レコードの guest フラグを in-place 更新する方式 (シーン遷移に連動) で実現していたが、synqux の role は `transport.connect` 時に固定され、後から変更する API がない
- 関連: ADR-0001 Decision 7 (host 導出), ADR-0002 (host 採番 seq / fencing), ADR-0006 (presence 再登録), SPEC-0002 決定 5 (role 改名の経緯)

## 問題

1. **role が connect 時に固定**: タイトル画面を開いたまま放置された端末が host に選定され、background throttling で裁定が止まり同期グループ全体が停止する事象が移植元で稀に発生していた。「タイトル画面では host 候補から外し、ゲーム参加時に候補へ入れる」には subscribe 後の role 切替が必要。unsubscribe → 再 subscribe では selfId が変わり (transport 再採番)、connected も新規採番されるため「切替した端末が必ず host を奪う」副作用がある
2. **observer という名前が実態と乖離**: role が制御するのは host 適格性のみ (`deriveHostId` でのみ参照)。request 発行はどの role でも制限されず、readonly の強制は「reducer が唯一の判定器」原則から core に入れない。observer / spectator 系の名前は「見てるだけ」を暗示し誤解を招く。host / guest は対概念であり「host にならない参加者」の実態と一致する (移植元の 5 年使われた語彙への回帰でもある)

## 設計

### コンセプト

「role は presence レコードの mutable な属性であり、`id` / `connected` は不変」と再定義する。切替は presence の in-place 更新のみで行い、host 導出・裁定・migration のロジックは一切変更しない。以下の既存メカニズムがそのまま切替に追従する:

- `deriveHostId` は peers プールの純粋関数 → presence の `onChanged` → `peerUpserted` でプールが更新されれば host 導出は自動で再計算される
- 裁定 fork は request ごとに「自分が host か」を監視し続ける (`create-synqux.ts` の `spawnHostFork`) → 途中昇格した端末が滞留 request を拾う動きは実装済み (`host-migration.test.ts` の「dedicated の参加 (昇格) を待って処理される」と同じ経路)
- host からの降格は「host が pool から外れた」のと同じ扱いで、既存の host migration + epoch fencing が吸収する

### 1. observer → guest 改名 (breaking, pre-1.0)

- `src/core/types.ts`: `PeerRole` の `'observer'` を `'guest'` へ。doc comment を実態に合わせて書き直す:
  「guest: host 選定から除外される参加者 (移植元の guest)。**request 発行は制限しない** — readonly が必要なら consumer が UI 層で dispatch を抑止する」
- `src/core/host.ts` のコメント、`host.test.ts` / `host-migration.test.ts` 等のテスト、`demo/` (`main.ts`, `index.html`, `README.md` の `?role=observer`)、`README.md` の公開 API 表、`docs/SPEC-0001-requests-sync.md` の host 導出記述を追従
- `docs/SPEC-0002-public-api.md`: role 定義箇所を guest へ更新。決定 5 (agent/guest → player/dedicated/observer 改名) は決定記録なので書き換えず、「その後 observer → guest へ再改名した (本 TASK)。observer は readonly を暗示するが、role の実際の作用は host 適格性のみだったため」と追記する
- `docs/ADR-0001-design.md` 等、過去の ADR 内の observer 表記は当時の決定記録なので**書き換えない**
- **SYNQUX_SCHEMA_VERSION は bump しない**: role 値は presence (ephemeral、onDisconnect で消滅) にのみ載り、versioned な封筒 (request / snapshot) には含まれない。新旧混在時も `deriveHostId` は未知の role 文字列を dedicated / player どちらのプールにも入れないため、双方から見て「host にならない」に収束し安全

### 2. transport 契約に `updateSelf` を追加

`src/core/types.ts` の `SynquxTransport` へ:

```ts
/** 自 peer の presence 属性を in-place 更新する (契約 9) */
updateSelf(patch: { role?: PeerRole }): Promise<void>
```

adapter 実装者への契約リストに **契約 9** を追記:

> 9. 【updateSelf】自 peer の presence を in-place 更新すること。`id` / `connected` は不変であること (connected を採番し直すと role 切替のたびに host 導出が変わってしまう)。更新は全端末の subscribePeers へ onChanged として配送されること。切断復帰時の presence 再登録 (契約 5 / ADR-0006) は**更新後の値**で行うこと

### 3. firebase adapter (`src/firebase/index.ts`)

- `update(selfRef, { role: patch.role ?? null })` で presence を部分更新 (undefined は null 化、既存の connect と同じ規約)
- **罠**: 切断復帰時の再登録 (ADR-0006、`.info/connected` 監視) は `session.role` で presence を書き直すため、`updateSelf` で `session.role` も更新すること。忘れると「player 昇格後に瞬断から復帰した瞬間 guest へ巻き戻る」バグになる
- 未 connect 時は既存の `assertConnected` 相当で throw

### 4. memory-hub (`src/testing/memory-hub.ts`)

- `group.peers` 内の自 peer を書き換え (`id` / `connected` は保持)、全 `peerSubscribers` へ `onChanged` を enqueue する
- `hub.inspect.peers(groupId)` で更新後の role が観測できること

### 5. core インスタンス API `setRole` (`src/core/create-synqux.ts`)

`Synqux` 型へ追加:

```ts
/**
 * 自端末の role を presence 上で切り替える (例: タイトル画面 guest → 開始で player)。
 * host 導出は presence の変更配送に追従して全端末で自動的に再計算される。
 * subscribe 中でなければ throw。standalone (enabled=false) 時は no-op
 */
setRole: (role: PeerRole) => Promise<void>
```

- 実装: session なし → `throw new Error('synqux is not subscribed. Call subscribe() before setRole().')`。standalone session → no-op で resolve。synced session → `transport.updateSelf({ role })`
- 自分の redux 側 peer エンティティは transport の onChanged → `peerUpserted` 経由で更新されるため、core から直接 dispatch しない (presence を single source に保つ)
- core に role の状態は持たない (unsubscribe → 再 subscribe 時の role は consumer が subscribe options で渡す。現状維持)

### 6. ADR

`docs/ADR-0014-mutable-role.md` を新規作成し、本 TASK の設計セクションの内容 (role = host 適格性のみ / presence mutable 属性への再定義 / guest 改名の理由 / schema bump 不要の根拠 / 契約 9) を Decision として簡潔に記録する。既存 ADR のフォーマットに合わせること。

## テスト計画 (分散制御の流儀: 先に red を確認してから実装)

- [x] `host-migration.test.ts`: guest で subscribe → dispatch で request 滞留 → `setRole('player')` → 自分が host 昇格し滞留分が適用される (昇格側)
- [x] `host-migration.test.ts`: player A (host) + player B で A が request 発行直後に `setRole('guest')` → host が B へ移譲され、滞留 request が B の裁定で適用される (降格側)
- [x] `setRole` 前後で自 peer の `id` / `connected` が不変であること (host 導出の決定性)
- [x] `memory-hub.test.ts` (または相当): `updateSelf` が全端末の subscribePeers へ onChanged を配送すること
- [x] `create-synqux.test.ts`: 未 subscribe で `setRole` → throw / standalone session で `setRole` → no-op で resolve
- [x] `src/firebase/index.test.ts`: 既存の presence 再登録テスト (ADR-0006) のパターンに合わせ、「`updateSelf` 後の切断復帰時、再登録される presence が更新後の role であること」を追加
- [x] 既存テスト・型検査が rename 後も green であること

## 完了条件

- [x] 上記テストが全て green
- [x] `npm run fix` / `npm test` が通る
- [x] `git grep -i observer` のヒットが「過去の決定記録 (ADR 本文・SPEC-0002 決定 5 の原文) と本 TASK の経緯記述」のみになる
- [x] SPEC-0001 / SPEC-0002 / README / demo が guest 表記・`setRole` 追記済み
- [x] ADR-0014 が作成済み
