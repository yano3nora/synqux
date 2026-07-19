# ADR-0007: action repeat contract を mode 宣言で検査する

- Status: **Accepted**
- Date: 2026-07-18
- 関連: `TASK-260718-action-repeat-contract.md`、ADR-0001 Decision 4

## Context

従来の `assertActionIdempotency` は synced state 全体を比較していた。このため、2 回目を reducer の validation が `stateWithError` で拒否する execute-once 型は、domain state が安全に不変でも `result` の success → error だけで失敗した。一方、チャット投稿や増分のように「N 回の dispatch = N 回の意味」を持つ無限実行型へ冪等性を一律強制するのはカテゴリエラーである。

繰り返しには 2 種類ある。①同一 request の二重適用は同期機構が防ぐ (不変条件 2)。②再クリックや state 監視 retry による「同じ意図の別 request」は機構から識別できず、domain semantics で扱う必要がある。ハーネスが検出すべきなのは、②で 2 回目も成功したまま domain を壊す無自覚な toggle・二重加算である。

## Decision

1. 冪等性を「1 回適用時と 2 回適用時で domain state が不変」と定義する。比較前に top-level の `result` を `null` にし、canonical JSON で比較する。`result` は transient な通知であり、restore でも復元されない前提と揃える
2. 既存名 `assertActionIdempotency` を維持し、optional な `mode` を追加する。省略時は後方互換の `'idempotent'` とする
3. action を次の 3 契約に分類し、宣言した契約だけを検査する
    - `'idempotent'`: set 型。domain state が冪等であること
    - `'rejects-repeat'`: execute-once 型。初回受理、2 回目の domain 不変、2 回目の明示的 error reject
    - `'repeatable'`: 無限実行型。レビュー済みであることを table に残すための明示的な検査除外
4. 検出網の目的を「全 action の一律冪等化」ではなく「無自覚な toggle 混入の検出」に限定する

## Rejected Alternatives

- **`result` 込みの全量比較を維持する**: 安全な execute-once 型を誤検知する
- **全 synced action に冪等性を一律強制する**: 無限実行型という正当な domain semantics を誤りとして扱ってしまう
- **新しい API 名へ rename する**: 意味の明確化に対して consumer の移行 churn が大きい。optional mode で十分である
- **nonce 化 helper を提供する**: 一意 key の生成単位・保持期間・重複時の挙動は consumer の domain 判断であり、共通化は YAGNI である

## Consequences

- execute-once 型は `result` の遷移に影響されず、意図した契約を直接検査できる
- 無限実行型は `'repeatable'` と明示され、意図せず検査 table から漏れた状態と区別できる
- 同じ意図の別 request による実害は機構もハーネスも自動判定しない。実害があれば payload の一意 key と validation reject で execute-once 化する責任が consumer に残る
