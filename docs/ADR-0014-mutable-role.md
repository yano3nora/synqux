# ADR-0014: role を mutable presence 属性として扱う

- Status: **Accepted** (2026-08-11 実装)
- Date: 2026-08-11
- 関連: ADR-0001 Decision 7 (host 導出), ADR-0002 (host 採番 seq / fencing), ADR-0006 (presence 再登録), SPEC-0002 (公開 API)

## Context

role は transport の `connect` 時に固定されていた。タイトル画面の端末を host 候補から外し、ゲーム参加時に候補へ入れるには再購読が必要だったが、再購読は `id` と `connected` を採番し直して host 序列を変え、接続失敗の窓も作る。

また、従来名の `observer` は readonly を暗示するが、role が制御するのは host 適格性だけである。request 発行はどの role にも許され、拒否判定は reducer に集約する。

## Decisions

1. role を presence レコードの mutable 属性とし、`id` / `connected` はセッション中不変とする。core は presence の `onChanged` → `peerUpserted` に追従して既存の純粋な host 導出を再実行し、role 状態を別途保持しない。
2. `PeerRole` の非 host 候補を `observer` から `guest` へ改名する。guest は host 選定から除外されるだけで、request 発行を制限しない。readonly が必要なら consumer が UI 層で dispatch を抑止する。
3. `SynquxTransport.updateSelf` を契約 9 として追加する。adapter は自 presence を in-place 更新し、全端末の peer 購読へ `onChanged` を配送する。切断復帰時の再登録にも更新後の値を使う。
4. core の `setRole` は subscribe 中の synced session だけ `updateSelf` を呼ぶ。未 subscribe は明示的に拒否し、standalone は no-op とする。自 peer を core から直接 dispatch せず、presence を single source に保つ。
5. `SYNQUX_SCHEMA_VERSION` は変更しない。role は ephemeral な presence にだけ存在し、versioned な request / snapshot 封筒には含まれない。新旧混在時の未知 role はどの host 候補 pool にも入らず、安全側の「host にならない」へ収束する。

## Consequences

- role 切替は再購読せずに host migration を起こし、既存の request fork と epoch fencing が昇格・降格を吸収する。
- Firebase adapter は更新後の role を session に保持しないと、切断復帰で旧 role へ巻き戻るため、再登録テストを必須とする。
- `PeerRole` と transport 契約の変更は pre-1.0 の breaking change となる。

## Amendment (2026-08-12): setRole の冪等化

TASK-260812 で、consumer が `setRole` の多重発火を module 変数で抑止していた責務を
core へ移した。state 上の自 role を `'player'` へ正規化した値が指定 role と同じなら、
`setRole` は `updateSelf` を呼ばず no-op とする。

presence echo 前は自 peer が未反映または旧 role のため重複 write が残り得る。ただし
transport 契約の in-place 同値書き込みで無害であり、consumer は独自の抑止状態を
持たなくてよい。
