# TASK-260903: peer-shape-guard

260903 subscribePeers の契約外形状 (id なし残骸) の drop
===

## asis

- firebase adapter の `heartbeat()` (update) や `demotePeer()` は、切断削除と競合すると削除済み `connections/<groupId>/<id>` へ `{ lastSeenAt }` / `{ role: 'guest' }` だけの残骸 object を再生成し得る (demotePeer 側は existence check 済みだが競合窓は残る)
- `subscribePeers` は `snap.val() as Peer` を無検証で core へ配送するため、残骸が `peerUpserted` → `entities['undefined']` に入る
- 影響:
    - consumer の `selectPeers` に `id: undefined` の peer が混ざる (fc-310 では React の key 警告として顕在化)
    - `deriveHostId` は `role: undefined` を player 扱いで pool に入れるため、`connected` undefined の NaN sort や `a.id.localeCompare` の TypeError まであり得る

## tobe

- adapter の受信境界で契約外形状 (string の id を欠く値) を配送せず drop する
- transport 契約として明文化する (契約 17)

## todo

- [x] 再現テスト先行 (`src/firebase/index.test.ts`: 残骸 3 形状を onAdded / onChanged / onRemoved へ流し、配送されないこと)
- [x] `subscribePeers` に `toPeer` guard を実装
- [x] `core/types.ts` の契約列挙へ 17 を追記、`SPEC-0002` の subscribePeers へ反映
- [x] npm run fix / npm test

## testcases

- [x] 残骸 (`{ role }` / `{ lastSeenAt }`) は onAdded / onChanged / onRemoved いずれも配送されない
- [x] id を持つ Peer は従来どおり配送される

## notes

- 発見経緯: fc-310 の `Cursors` (selectPeers の map) で `key={undefined}` による React 警告
- 残骸レコード自体の物理削除は契約 11 と同じく group 終了時の data lifecycle (consumer 責務) に委ねる。heartbeat 側への existence check 追加は TOCTOU が残るため採らず、受信境界の drop を正とした
- fc-310 への反映は release + 依存更新待ち (min-release-age 注意)。それまで警告は dev データの残骸掃除でのみ消える
- Codex レビュー反映: drop 判定を id string のみ → id string + connected number へ強化 (connected を欠く peer は host 導出の NaN sort を起こすため)。SPEC-0002 の契約一覧はダイジェストのため番号追加はせず、subscribePeers のコメントから types.ts (契約の正) を参照させた
