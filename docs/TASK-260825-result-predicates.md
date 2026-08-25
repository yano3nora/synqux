# TASK-260825: 成功判定 matcher の state 述語化 (isSucceededResult / isMySucceededResult) と result helper の with* rename

- Date: 2026-08-25
- Status: Implemented (2026-08-25)
- 由来: 導入 consumer の synced extraReducers matcher が「自 action が error になった適用」を手書きの hash 照合で除外していた。isSucceededAction が locals 専用 (meta.root 依存) で synced reducer では使えないための代替だったが、契約を深掘りした結果、matcher (action 述語) という形自体が冗長と判明した
- 関連: TASK-260810 (本 TASK が置換する matcher の導入経緯), ADR-0013 (pre-stamp), ADR-0024 (hash の creator 付与), ADR-0001 Decision 8 (直列 rootReducer / meta.root), ADR-0026 (定義の戻りへの一本化), SPEC-0002 (公開 API)

## 問題

TASK-260810 の `isSucceededAction` / `isMySucceededAction` は「RTK の `builder.addMatcher` へ直接渡せる action-only 述語」として設計され、state を `action.meta.root` から暗黙に読む。この形には以下の問題がある:

1. **synced reducer で使えない**: meta.root は locals にしか付与されない (Decision 8) ため synced では常に false。consumer は synced matcher 内で hash 照合を手書きしており、synqux 内部契約 (pre-stamp / hash) への依存が consumer 側に漏れている — TASK-260810 が防ごうとした状況の再発
2. **action アンカーが冗長**: **pre-stamp (ADR-0013) + 直列 rootReducer + 「result に積む action は適用中の action」契約 (本 TASK 設計 1.5 で新設)** の 3 点により、**同一 rootReducer chain 内** (pre-stamp → synced → locals の直列実行中) では synced / locals どちらの文脈でも `result` は必ず適用中の action A のもの。hash 照合・isSyncedAction ガード・action 引数はすべて「result がこの action のものである」ことの保証だったが、chain 内ではこの 3 点により**契約上保証される**。chain の外 (listener / nested dispatch 後の読み取り) は「最後に適用された synced action の result」であり、そこで action identity が必要な機構 (dispatchAndWait) は従来どおり hash で照合する (複合経路の pending 未解決疑いは BACKLOG P1 参照) — 本 TASK の述語は reducer 内ガード用であり、その領分を侵さない
3. **addMatcher 直渡しの実績がない**: 導入 consumer の全 4 使用箇所は synced creator の `addCase` 内の `if` ガードであり、action-only signature の設計根拠 (TASK-260810「RTK の builder.addMatcher へ直接渡せる必要がある」) は実消費で使われていない
4. **requestedBy も state から読める**: `result.action` は封筒として適用 action を丸ごと保持する (generateResult) ため、my 判定に必要な `meta.requestedBy` も action 引数なしで取得できる

## 設計

### 1. matcher を廃止し、state 述語 2 つへ置換する

```ts
/** synced state の result 述語。binding 不要のため standalone export (isResultForPeer と同族) */
isSucceededResult = (synced: SynquxSynced): boolean =>
  synced.result?.type === 'success'

/** root が必要 (synqux.connections / mode)。defineSynqux が syncedKey で束縛して配布 */
isMySucceededResult = (root: TRoot): boolean =>
  isSucceededResult(selectSynced(root)) &&
  (root.synqux.mode === 'standalone' ||
    (selfId !== null && result.action.meta.requestedBy === selfId))
```

- **isSucceededResult**: `src/core/results.ts` へ standalone export + defineSynqux の戻りに型束縛版を echo (stateWithResult 系と同じ扱い)。result が null (初期状態) は false
- **isMySucceededResult**: defineSynqux の戻りのみ (syncedKey 束縛が必要なため)。selfId null / requestedBy 欠落は false。standalone は成功時 true (従来踏襲)
- `src/core/matchers.ts` の `createSyncedActionMatchers` と `MatchedSyncedActionOf` 型は削除。`isSynquxAction` / `isDeliveredSyncedAction` は残す
- type guard 機能 (`action is TAction`) は廃止 — narrowing は `isSyncedAction` (registry 由来の type guard) が担う。移行イディオムは「`builder.addCase(<synced creator>, ...)` 内で述語を呼ぶ」または `builder.addMatcher(isSyncedAction, (state, action) => { if (!isSucceededResult(...)) return; ... })`。この合成で narrowing が維持されることを型テストで表明する

### 1.5. 新設する公開契約: 「result に積む action は適用中の action」

「chain 内の result は適用中の action のもの」という不変条件は、pre-stamp だけでは閉じない — `withResult` / `generateResult` は任意の action を受けられるため、consumer が別 action を積めば破れる。本 TASK でこれを**公開契約として明文化**する:

- `withResult` / `withErrorResult` / `generateResult` に渡す action は**適用中の action そのもの**であること (封筒の hash / requestedBy の同一性はこれに依存する)。docstring と SPEC-0002 に明記する
- 契約違反は consumer のバグであり、synqux は機構で防御しない (ADR-0024 の「同一 hash の再 dispatch は契約違反、dedup は導入しない」と同じ姿勢)。旧 matcher の hash 照合はこの違反を偶発的に検出していたが、防御のために action アンカーという API 複雑性を維持する価値はない
- `isMySucceededResult` の成立条件はこの契約 + 「request / host 試し実行 / 実配達の全経路で `requestedBy` が封筒に保持される」こと (実装で保証済み、テストで表明)。契約違反や手組み result で requestedBy が欠落した場合は false に落ちる (安全側)

### 2. signature が決定性境界のドキュメントになる

- `isSucceededResult(synced)` — synced domain のデータのみで判定するため、**synced reducer (extraReducers matcher) でも locals でも呼べる** (決定的)
- `isMySucceededResult(root)` — 端末ローカル情報 (selfId / mode) が必要なため、root を持たない synced reducer では**物理的に呼べない**。「locals 専用」が docstring の警告から型による構造的保証に変わる

### 3. docstring に載せる契約

- 述語は「**直前に適用された synced action の result**」の記述である。result と action の対応付けが保証されるのは**同一 rootReducer chain 内のみ**で、根拠は pre-stamp + 直列実行 + 設計 1.5 の result-action 契約の 3 点 (構成だけでは閉じない)。特定 action への追従は synced action の `addCase` / `isSyncedAction` matcher の**中で**呼ぶこと (local action の処理中に呼ぶと残留 result を読む。reducer 外での action identity 照合は本述語の領分外 — dispatchAndWait 等の hash 解決を使う)
- synced reducer 内では **chain 途中の暫定値** — 後続 matcher がまだ withErrorResult を積める。「失敗時 domain 不変」を守るため、follow-up を書く matcher は先頭で `if (!isSucceededResult(state)) return` ガードすること (特に standalone は適用がそのまま正史になる)
- hash 照合は不要である理由 (pre-stamp + 直列実行 + result-action 契約の 3 点により、chain 内の result は今回の action のもの) を明記し、consumer の手書き照合を不要にする

### 4. rename: `stateWith*` family を `with*` へ統一する

| 旧 | 新 |
| --- | --- |
| `stateWithResult` | `withResult` |
| `stateWithError` | `withErrorResult` |
| `stateWithDefaultResult` | `withDefaultResult` |
| `stateWithTransaction` | `withTransaction` |

- 「state を受けて state を返す」ことは**第 1 引数が担う**ため、名前の `state` prefix は冗長 — `withErrorResult(state, action)` は「state に error result を載せたもの」と読める。`withTypes` と同じ with* 語彙になり、呼び出し頻度が最も高い helper 群の記述量が減る
- `stateWithError` のみ Result 語彙を追加する (`withError` ではなく `withErrorResult`)。result を書く helper で唯一 Result を持たない名前だったため
- **`generateResult` は rename しない**。「generate* = Result object を作る / with* = state を返す」の対比が両者の区別を担うため、with prefix 自体は削らない (`errorResult()` 等は不採用)
- export 点 (results.ts / define-synqux.ts / index.ts)・tests・docs (SPEC-0001 / SPEC-0002 / README / 既存 TASK・ADR の本文は歴史記録のため原則そのまま、現行仕様を語る箇所のみ) を grep で追従する。特に SPEC-0002 の primitive 契約「synced reducer 前段で stateWithDefaultResult を呼ぶ義務」の記述は `withDefaultResult` へ更新する

### 5. rename / 新設後の提供表

| export | main (index.ts) | definition の戻り (型束縛) |
| --- | --- | --- |
| `withResult` | ○ | ○ |
| `withErrorResult` | ○ | ○ |
| `withDefaultResult` | ○ (primitive 契約用) | × (配線フェーズが内部で呼ぶ — 現状踏襲) |
| `withTransaction` | ○ | ○ |
| `generateResult` | ○ | ○ |
| `isSucceededResult` | ○ (binding 不要) | ○ |
| `isMySucceededResult` | × (syncedKey 束縛が必要) | ○ |

### Breaking (0.x refactor!)

- `isSucceededAction` / `isMySucceededAction` の削除 (state 述語へ置換)
- `stateWith*` family 4 つの rename (旧名の alias は残さない — 消費者は自社 repo のみ、二重語彙は害)
- consumer 側の追従 (導入 consumer の locals 4 箇所 + synced matcher の手書き hash 照合の置換、rename やりきり) は**ライブラリ外**。ユーザが version bump に合わせて consumer repo 側で実施する

## テスト計画

`src/core/matchers.test.ts` の該当分を置換 (isSynquxAction / isDeliveredSyncedAction のテストは残す)。TASK-260810 と同じく `createSynquxRootReducer` で組んだ rootReducer に action を通す現実的テストとする。

- [x] isSucceededResult: 受理 (default success stamp) 後の synced state で true / withErrorResult 適用後 false / result null (初期状態) で false
- [x] synced matcher 文脈: case reducer が withErrorResult → 同一 action の後続 matcher 内で false (pre-stamp と結合し「hash 照合なしで今回の action の error を検出できる」ことの表明)
- [x] locals 文脈: meta.root から selectSynced した synced に対して判定できる (同一 dispatch 内の result 一致の表明)
- [x] isMySucceededResult: standalone で成功なら true / 同期中 requestedBy === selfId で true / 不一致 false / selfId null で false / requestedBy 欠落 false / error result なら requestedBy 一致でも false (同期中の拒否 request はそもそも適用されないため、error / 欠落ケースは実 session の state に result 差し替えを加えて表明した)
- [x] requestedBy の全経路保持: memory hub の multi-peer simulation で request → host 裁定 → 配達 (serialize/parse 経由) 後、依頼元・他端末それぞれの locals で isMySucceededResult が正しく判定される。あわせて hub の serialized request 封筒の `result.action.meta.requestedBy` を直接検査し「host 試し実行で保持」も表明する
- [x] restore: 実 subscribe / recovery の restore 経路 (core が clearRestoredResult で result を null 化する) を通した後、両述語が false
- [x] nested dispatch (standalone automation): 外側 action の dispatch が戻ったあとの state は内側 action の result — 「chain 外では最後に適用された action の result」の表明。なお automation × dispatchAndWait の pending 未解決疑い (この挙動の帰結) は本 TASK と独立の潜在問題のため BACKLOG (P1) へ切り出した
- [x] local action 処理中の locals では残留 result を読む (isSyncedAction gate / addCase 文脈が必要なことの表明。旧 matcher が false を返していた状況の挙動変化を記録するテスト)
- [x] 型テスト: `addMatcher(isSyncedAction, ...)` 合成で narrowing が維持される / 旧名 (`isSucceededAction` / `isMySucceededAction` / `stateWith*`) が main・definition 両面から消えている

## 完了条件

- [x] 上記テスト green
- [x] `npm run fix` / `npm test` pass
- [x] `src/index.ts` の提供コメント (matchers は定義の戻りのみ、の記述) を更新
- [x] SPEC-0002 (公開 API) の matcher 節を述語 2 つへ差し替え、with* rename と「result に積む action は適用中の action」契約を追記
- [x] README の公開 API 一覧へ追従
- [x] ADR-0013 へ「result に積む action は適用中の action」契約 (設計 1.5) を Amendment として追記
- [x] TASK-260810 に「本 TASK で state 述語へ置換 (superseded)」を追記
- [x] 本 TASK の Status を Implemented へ更新
