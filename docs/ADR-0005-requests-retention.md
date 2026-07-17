# ADR-0005: requests retention を適用窓の外側に揃える

- Status: **Accepted**
- Date: 2026-07-18
- 関連: `TASK-260718-requests-retention.md`、ADR-0002 Decision 4/5、ADR-0004

## Context

requests は削除経路がなく、復帰時の全量購読コスト・帯域・DB サイズがセッション長に比例して増えていた。一方、core は restore 後に古い requests を全量受信し、有限の適用窓より古い envelope を適用済み扱いで破棄している。

## Decision

1. prune の境界を `appliedSeq - APPLIED_WINDOW_SIZE` とし、数値 `seq < beforeSeq` の envelope だけを削除する。seq なしの未裁定 envelope は削除しない
2. host が snapshot 永続化の ack 後に prune する。境界は ack 前に固定した snapshot と同じ ordering state から求め、live ordering は読み直さない
3. prune は correctness のクリティカルパスに含めず fire-and-forget とする。失敗は許容し、後続 snapshot 後の新しい境界で再試行する
4. transport は optional な `pruneRequests?(beforeSeq)` を持つ。seq 閾値なら、host 交代直後でも前任 host の request id を知らずに全履歴を prune できる

適用窓の外は、restore 後の再配送でも適用済み扱いで破棄され、dual-host 敗者の救済対象でもない。gap 回復も窓内は requests 再購読、窓外は snapshot restore が担う。したがって、この領域の envelope を削除しても端末挙動は変わらない。

## Rejected Alternatives

- **adapter 内の TTL prune**: snapshot payload は adapter にとって不透明で、安全な snapshot 地点・適用窓境界を判断できない
- **窓から溢れた id を host が記憶して id 指定削除**: 交代直後の新 host は前任時代の id を知らず、古い歴史を削除できない
- **保持件数の config 化**: 敗者救済・gap 回復とは別の定数になり、整合を壊しやすい。現時点では YAGNI
- **削除しない**: 長時間セッションほど購読コスト・帯域・DB サイズが無限成長する

## Consequences

- transport 上には境界を含む直近 `APPLIED_WINDOW_SIZE + 1` 件が基本的に残る (`seq < beforeSeq` のため)
- retention 未実装の既存 transport は削除されないだけで互換性と correctness を維持する
- requests export だけでセッション全履歴を replay する運用はできなくなる。事故調査で全履歴が必要なら、prune が進む前に export を取得する

## 2026-07-18 追記: 調査ログ退避 option

Firebase adapter に `archivePrunedRequests` option を追加する。有効時は prune 対象の封筒を物理削除せず、root-level multi-path update 1 回で `requests/{groupId}/{requestId}` から `logs/{groupId}/{requestId}` へ退避する。これにより、実適用順の ground truth である seq 付き封筒を prune 後も保全し、全量 replay 調査を可能にする。

退避先は storage の関心事であり、core の retention 契約は requests から取り除くことまでのため、core option ではなく adapter option とする。`logs/` は購読・restore ・公開 API のいずれにも載せず、export ベースの調査にだけ使う。監査ログとして無限成長する容量と、ゲーム破棄時の `logs/{groupId}` 削除は consumer のデータライフサイクル運用に委ねる。
