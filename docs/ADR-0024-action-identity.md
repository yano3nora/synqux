# ADR-0024: synced action identity (hash) を公開契約にする

- Status: **Accepted**
- Date: 2026-08-20
- 関連: SPEC-0002 (SynquxActionMeta)、ADR-0007 (repeat contract)、ADR-0008 (result envelope)、ADR-0025 (consumer 型配布)、`TASK-260820-action-identity.md`

## Context

- 実運用 consumer (具体名は git 管理外の CLAUDE.local.md 参照) は `meta.hash` を同期 state の識別子 (reactions の record key、talk chain の rootHash) に採用している。「一意な synced action」を表す識別子は consumer が独自ロジックの土台にしたい情報であり、この用法は自然な要求である
- 一方 SPEC-0002 は「synced reducer が判定に使ってよい meta は requestedBy / dispatched のみ」と定めており、consumer は契約外の逸脱としてこれを使い続けるしかない
- しかし synqux 自身が hash を公開挙動に使っている: `createSyncedActionMatchers` の result 照合、`dispatchAndWait` の解決はいずれも hash の同値性に依存する。「診断専用」の整理は既に実態と合っていない
- hash は request 封筒で運ばれ全端末同値になる。response 系 meta (responsedBy / responsed / epoch / seq) が持つ「dual-host 窓で裁定候補ごとに値が変わる」非決定性を持たないため、判定利用を禁じる理由が当てはまらない
- 採番は `Date.now(base36)-連番-Math.random 8 桁` の非公開独自形式で、乱数部 ≈41bit は永続 state のキーとして契約化できる一意性水準にない
- 付与点が middleware (metaSetter) であることによる問題が 3 つある: (1) 既存 hash があると action 全体を素通しするため、prepare で hash だけ指定した action の dispatched が欠落する経路がある (2) creator の戻り値は meta を持たず、reducer 単体テストで全 consumer が metaSetter 相当の stamper を自作している (3) 「middleware を通ったので meta はあるはず」という事実を型で表現できず、reducer 側は optional chaining と runtime narrow (consumer 自作の getRequiredMetaOrFail 相当) を強いられる

## Decision

1. **hash を synced action の公開一意識別子として契約化する**。SPEC-0002 の「判定に使ってよい meta」を `requestedBy / dispatched / hash` に改める。consumer は hash を同期 state の識別子 (record key 等) に使ってよい
2. **採番を ulid (monotonic factory) に変更し、形式を契約にする**: 26 文字 Crockford base32、一意 (80bit 乱数)、同一端末内の生成順で辞書順単調。**端末間の適用順の正はあくまで seq であり、hash の辞書順を端末を跨いだ順序判定に使ってはならない** (端末時計基準のため)。sortable は「端末内生成順の目安」として提供する。採番は `generateActionHash` として公開する
3. **付与点を middleware から action creator (ADR-0025 の `createSyncedAction` が合成する prepare) へ前倒しする**。生成された action はその瞬間から `hash` / `dispatched` を持ち、型 (required な `SyncedActionMeta`) は事実の記述になる。dispatched は同期時、request 化の時点でサーバ基準時刻に上書きされる (従来どおり)
    - RTK 自身が createAsyncThunk の creator 内で nanoid を生成しており、creator 内での id 採番は対象読者に既知の idiom である
    - **「1 生成 = 1 意図」= 同一の action オブジェクトを再 dispatch してはならない**。機構は同一 hash の重複排除を**行わず**、再 dispatch は同一 identity の request の二重適用になる。再送・再実行は必ず creator を呼び直す。dispatchAndWait は同一 hash の待機中再発行を明示的に reject して誤用を検出する (silent な resolver 上書きを防ぐ)。middleware / core での同一 hash 重複排除は**導入しない** (2026-08-20 決定): 再 dispatch は consumer の契約違反 (バグ) であって分散障害モードではなく (重複配信・遅延は seq 線形化で既に守られる)、request 経路への dedup は restore replay で正当に同一 hash が再配達されるケースと区別がつかず裁定の不変条件を汚すため
4. **metaSetter middleware は fallback として残し、field 単位補完に改める**: 素の RTK createAction や手組み action が dispatch された場合に hash / dispatched の欠落分だけを補う (既存 hash の action 全体素通しは廃止 = dispatched 欠落バグの修正)。これにより不変条件「**reducer に到達する synced action は hash / dispatched を必ず持つ**」が全経路 (creator 経由 / 素の action / dispatchAndWait / automations / request 配達) で無条件に成立する
5. `SyncedActionHash` (= `string` の名前付き alias) を export し、契約の語彙とする

## Rejected Alternatives

- **hash を診断専用のまま維持する**: synqux 自身の公開挙動 (matchers / dispatchAndWait) が既に hash 依存であり、禁止は建前にしかならない。consumer は毎回逸脱するだけで、契約の意味が失われる
- **consumer が独自採番した識別子を payload に持たせる**: metaSetter との二重採番になり、result 照合 (hash) と domain 識別子が分裂する。「synced action の一意性」は同期機構が知っている情報であり、再実装を強いるのは本 ADR が解消したい構造そのもの
- **現行独自形式のまま仕様化する**: Math.random 8 桁の一意性水準を永続キーの契約として約束できない。外部仕様 (ulid) を参照できる形式の方が consumer への説明コストも低い
- **reducer 内での自動採番 (欠落時に reducer が補う)**: reducer の決定性を壊す (host の試し実行と実配達で hash が変わり同期が破綻)。付与点は creator / middleware / テストハーネスのみ
- **middleware 付与のまま「required 型」だけ配布する**: 型が「middleware を通れば真」という条件付きの嘘になり、creator の戻り値やテストで嘘が露呈する。付与点の前倒しで嘘自体を消せる

## Consequences

- 既存永続 state には旧形式 hash が残り、ulid と形式混在する。synqux は hash を不透明文字列として扱い続けるため動作影響はない。形式 (sortable 等) に依存する consumer ロジックは reset 後の新規データからを前提とする (migration は提供しない)
- runtime dependency に `ulid` を追加する
- テスト用 meta stamper という API カテゴリ自体が不要になる (creator の戻りが最初から有効な meta を持つ)
- 同一 action オブジェクトの再 dispatch は契約違反となる (機構は防がない)。creator 経由の通常実装では起きない誤用だが、検出は dispatchAndWait の同一 hash reject のみ
- consumer の runtime narrow helper (getRequiredMetaOrFail 相当) は `SyncedActionMeta` の required 型で不要になる (ADR-0025)
