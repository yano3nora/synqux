# ADR-0004: seq gap の段階的な自動回復

- Status: **Accepted**
- Date: 2026-07-18
- 関連: `TASK-260718-sync-auto-recovery.md`、ADR-0003、SPEC-0001 既知トレードオフ

## Context

sync health が検知する stall には原因の異なる 2 症状がある。response の配送欠落は requests の再購読で封筒を取り直せる。一方、dual-host 窓で敗者を早期適用した端末は、その request id を `isApplied` と判断するため、同じ封筒を再配送しても正史へ戻らない。後者には snapshot による synced state と ordering の一体復元が必要になる。

## Decision

1. 1 gap エピソードにつき **requests 再購読 → 待機 → snapshot restore → 待機 → unrecoverable** を 1 巡だけ行う。gap が自然解消すればどの段階からも `ok` へ戻り、新しい stall だけが次のエピソードを開始する
2. 再購読の直前だけ `ordering.resetAddedGuard()` で `seenAddedIds` を clear し、既存 requests の全量再配送を受け直す。通常配送の重複ガードは維持する
3. restore は snapshot の `appliedSeq` が自端末より大きい場合だけ受理する。load の await 後に gap を再判定し、遅着による自然回復を古い snapshot で上書きしない
4. restore の `ordering.seed` と `synquxRestored` dispatch は await を挟まない同期ブロックにする。待機 fork は既存の `isStale` / `isBeyondWindow` / `isApplied` と `waker` で自然に再評価させ、専用の掃除処理は追加しない
5. 1 巡で解消しなければ `unrecoverable` とし、consumer がリロードを案内する。ただし heartbeat は継続し、遅着で解消すれば `ok` へ戻す

## Why resetAddedGuard

代案の「responded 済み added を dedup より先に changed 経路へ回す」は、受信 routing の通常時の順序を変え、同一 added の重複 dispatch 面を広げる。再購読という明確な境界で guard だけを reset する方が影響範囲が小さく、既存の処理中・適用済み guard もそのまま働く。

## Rejected Alternatives

- **transport に request 再取得 API を追加**: 既存 `subscribeRequests` の全量再配送で足り、adapter と公開契約を増やす必要がない
- **検知後すぐリロード案内**: 配送欠落は再購読だけで戻せるため、画面全体のリロードは過剰
- **回復を無限 retry**: transport 障害時に帯域消費と reload loop を作る一方、dual-host 乖離や古い snapshot の correctness は改善しない
- **再購読だけで完結**: dual-host 早期適用は `isApplied` が再配送を破棄するため回復できない

## Consequences

- 通常の response 欠落は再購読、適用列の局所乖離は新しい snapshot で自動回復する
- `selectIsSyncStalled` は回復中を含む `phase !== 'ok'`、リロード案内は `selectIsSyncUnrecoverable` の責務になる
- requests retention 導入後も、snapshot 地点より新しい requests を再購読できる契約が必要になる
