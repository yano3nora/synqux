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

## Amendment (2026-08-20): 2 回目適用の meta 再生成と、契約の宣言単位

### Context

- 従来のハーネスは同一 action オブジェクト (= 同一 hash) を 2 回 reduce していた。しかし①同一 request の二重適用は同期機構が防ぐため、これは現実の同期経路に存在しない事象である。検査対象の②「同じ意図の別 request」は別 hash で届く
- ADR-0024 で hash が state 識別子として契約化されたことで、この差は偽陰性になる: hash による重複排除 (`includes(hash)` / `record[hash] = ...`) が同一 hash の 2 回目を無害化し、別 hash なら起きる二重加算・履歴重複を隠す
- また payload によって振る舞いが変わる汎用 dispatcher action (導入 consumer 実例: 数十種の意思決定 key を運ぶ汎用実行 action) は、action type として単一の repeat contract を持てない。分類 table が「1 action type = 1 mode」を前提とする以上、これは検査の穴ではなく action 設計への信号として扱う必要がある

### Decision

1. `assertActionIdempotency` / `verifyActionIdempotency` は **2 回目の適用前に hash / dispatched を再生成する** (②の忠実な再現)。1 回目は未付与の meta を補完し、焼き込み済みの hash / dispatched は尊重する (ADR-0024 により通常は creator が生成時に付与済み)
2. **repeat contract の宣言単位は action type である**ことを明文化する。汎用 dispatcher action は `'repeatable'` と宣言し (単一契約を持たないことの明示)、個別のガード (演出中拒否など) は通常のシナリオテストで検査する
3. **execute-once が仕様である操作は、state から一意に実行可否を判定できる専用 action + reducer validation で構成する**ことを推奨形とする (導入 consumer 実例: phase timer の期限確定 action — 汎用実行 action を直接発行せず、reducer が synced state から実行段階を導出し、済んでいれば拒否する)。迷ったら専用 action へ切り出す側に倒す

### Consequences

- 2 回目の meta が変わるため **breaking**: 同一 hash の重複排除に依存して `'idempotent'` を通していた宣言は fail し得る。それは本 Amendment が検出したかった偽陰性そのものであり、宣言の見直し (repeatable 化 or 専用 action 化) を促す
- Rejected Alternatives の「nonce 化 helper は YAGNI」判断は維持する。meta 再生成はハーネス内部の関心に留まり、公開 API は増やさない
