# ADR-0003: seq gap の検知と sync health

- Status: **Accepted**
- Date: 2026-07-18
- 関連: `TASK-260718-sync-health-iteration1.md`、`SPEC-0001-requests-sync.md` 既知トレードオフ

## Context

response の永久欠落と、dual-host 窓で敗者を先に適用した端末は、原因は違っても「観測した後続 seq を適用できず、`appliedSeq` が進まない」という同じ停止状態になる。現在の回復経路はリロードによる snapshot restore だけだが、consumer には停止を判定する材料がなかった。

一方、transport では最大約 1 分の遅配が観測されている。時刻だけで欠落を断定したり、自動 restore したりすると、一時遅配を correctness の判断へ混ぜてしまう。

## Decision

1. `ordering` が追跡済みの観測最大 seq を公開し、「`maxSeenSeq > appliedSeq` のまま `appliedSeq` が `stallAfterMs` 進まない」を stall とする
2. 既定の `stallAfterMs` は 30 秒、heartbeat は 1 秒間隔とする。端末ローカルの `Date.now()` はヒステリシスと診断表示にだけ使い、適用順の correctness には使わない
3. 結果は `state.synqux.health` に置き、静的 selector と `synqux/react` hooks で読む。dispatch は phase 遷移時と stalled 中の診断値変更時だけ行い、ok 継続中は行わない
4. iteration 1 は検知と consumer 通知だけに留める。回復手段はリロードで、自動回復は BACKLOG iteration 2 とする (→ その後 [ADR-0004](ADR-0004-sync-auto-recovery.md) で実装済み)

## Rejected Alternatives

- **fork 滞留数などの間接指標**: host 不在や dual-host 敗者待ちでも増え、seq gap 以外を誤検知する
- **`appliedSeq + 1` の envelope 不在を条件にする**: dual-host 早期適用の stall では、再裁定 envelope が entities に残ったまま適用済み扱いで破棄されるため検知できない
- **iteration 1 で requests 再購読や snapshot restore まで行う**: 再購読は `acceptAdded` が再配送を握りつぶす罠があり、restore は二重 dispatch・巻き戻り・host migration 競合のテストが不足している。段階回復は iteration 2 で設計する
- **transport event / callback / plugin 機構**: 既存の Redux 読み取り作法で十分であり、API 表面積を不必要に増やす

## Consequences

- consumer は停止時にリロード案内へ切り替えられる
- 一時遅配との区別は設定値に依存するため、stalled は診断・運用シグナルであって欠落の証明ではない
- 自動回復、回復不能通知、retry/backoff は未解決のまま BACKLOG iteration 2 に残る (→ 解消済み: [ADR-0004](ADR-0004-sync-auto-recovery.md) が再購読 → snapshot restore の 1 巡自動回復と `unrecoverable` 通知を実装。無限 retry/backoff は同 ADR で意図的に不採用)
