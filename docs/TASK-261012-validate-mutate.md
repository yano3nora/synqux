# TASK-261012: validate-mutate

261012 validate / mutate 記法 (ADR-0031)
===

## asis

- synced reducer の validation は reducer の中にしか無く、外から呼べない。consumer の UI と AI プレイテストは同じ条件を手で写している
- locals reducer の「何もしない」分岐も外から区別できない
- automations は拒否される request を retryMs ごとに transport へ流す

## tobe

- `createSyncedAction` / `createSyncedSlice` / `buildCreateLocalSlice` に `{ validate?, mutate, prepare? }` 記法が足される。生成 creator は `validate` を持つ
- 生成 reducer は validate が拒否を返せば拒否し、null なら mutate を適用する。synced の拒否は `withErrorResult` の option 互換で、string は `{ log }` の短縮形
- automations は発行前に validate を見て、拒否される request を発行しない。止めた事実は rule ごとに遷移時 1 回だけ console.warn する
- 出典: ADR-0031

## 設計

- `src/core/action.ts`: `SyncedRejection` / `SyncedValidate` / `SyncedMutate` / `SyncedCaseHandlers` 型、`createSyncedCaseReducer` (createSyncedAction と createSyncedSlice 共用の生成 reducer)、`createSyncedAction` の第 3 / 第 4 overload (prepare 付き / 無し)。P は overload の generic で validate と mutate から束ねる
- `src/core/define-synqux.ts`: registry を `Map<type, validate | undefined>` に。`createSyncedSlice` の第 3 記法 (`SyncedValidateMutateCase`、`result` を持つ state 専用)、payload 推論 (`CasePayloadOf`: prepare → validate 第 2 引数 → mutate 注釈)、食い違い検査 (`ValidateSyncedCasePayloads` を reducers へ交差)、`SyncedSliceActionCreator` の mutate 分岐 (先頭)。配線で `validatorOf` を core へ渡す
- `src/core/local-slice.ts`: `LocalValidate` 型、`LocalSliceCaseReducers`、RTK の case 定義へ写す `RtkLocalCases` (creator の型導出は RTK に任せる)、`validate` を交差で足す `LocalValidateHandlers`。runtime は mutate 記法だけ変換して RTK `createSlice` へ委譲。validate 付き case は `meta.root` 無しで throw
- `src/core/create-synqux.ts`: `validatorOf` option。engine は `isSyncedAction` 検査の直後に validate を評価し、拒否なら発行せず `lastIssuedAt` も更新しない。pre-check の meta は `normalizeSyncedActionMeta` で stamp した hash と `now` / selfId で組み、同じ meta を dispatch する (実 request と hash を揃える)。`suppressedByValidate` (rule id の Set) で遷移時 1 回だけ warn。例外は console.error して rule を skip
- `src/index.ts`: `SyncedValidate` / `SyncedRejection` / `LocalValidate` / `LocalSliceCaseReducers` を type export

## todo

- [x] `src/core/action.ts`
- [x] `src/core/define-synqux.ts`
- [x] `src/core/local-slice.ts`
- [x] `src/core/create-synqux.ts`
- [x] `src/index.ts` / `src/index.test.ts`
- [x] tests (下記)
- [x] docs: ADR-0031、SPEC-0001 (設計ガイドライン 4)、SPEC-0002 (型・createSyncedSlice / createSyncedAction / buildCreateLocalSlice・CreateSynquxConfig・exports)、README (Usage / automations / API)、BACKLOG (harness をトリガー付きで P2 へ)
- [x] `npm run fix` → `npm test`
- [x] Codex レビュー (4 件を反映: local の拒否は `return state` (primitive state で RTK が undefined 返却を throw する) / prepare 付き記法でも prepare の payload を validate・mutate に押し付ける / standalone の pre-check と適用 action の `dispatched` を同じ `now` にする / replaceRules で消えた rule の抑止状態を engine 起動時に捨てる)
- [ ] release 0.21.0 (人間判断)
- [ ] 導入 consumer の wrapper 案を取り下げ、この記法へ移行 (別 repo)

## testcases

- `src/core/synced-slice.test.ts`
    - [x] string の拒否は log 専用 error result (state 不変、message なし)
    - [x] object の拒否は message 付き error result
    - [x] validate が null なら mutate 適用
    - [x] validate 省略時も `validate` を持ち常に null。creator は引数なし
    - [x] prepare 付きは prepare の引数・戻り。payload は prepare から推論
    - [x] validate は meta を受ける (dispatched の条件)
    - [x] 型: payload は validate 第 2 引数 → mutate 注釈の順。食い違いは `@ts-expect-error`
    - [x] 型: `result` を持たない state には書けない
- `src/core/define-synqux.test.ts`
    - [x] `createSyncedAction(type, { validate, mutate })` の creator を `builder.addCase(creator, creator.reducer)` で配線し、host 裁定で string 拒否 (console.error) / object 拒否 (message が端末へ届く) / 受理が分かれる
    - [x] 定義の registry が automations の発行前判定へ配線され、拒否される request は transport に積まれず warn が 1 回出る
    - [x] 型: prepare 付き / mutate のみ / 食い違い
- `src/core/local-slice.test.ts`
    - [x] validate は root を受け、拒否時は state 不変、result も console 出力も無い
    - [x] `createTestRootState` の root で単体実行できる
    - [x] rootReducer 配下では meta.root が注入され、適用後の synced で判定する
    - [x] validate 付き case は meta.root 無しで throw
    - [x] validate 省略時は root を要求しない
    - [x] 型: `validate` は TRoot / P。plain 記法に `validate` は無い。食い違いは `@ts-expect-error`
- `src/core/automations.test.ts`
    - [x] 拒否中は発行せず lastIssuedAt も進まない (解除後、適用時の再評価で即発行)
    - [x] warn は「発行できる → 止まる」の遷移で 1 回。止まり続けても増えず、解除→再拒否で再び 1 回
    - [x] pre-check の meta (hash / dispatched = now / requestedBy = selfId)
    - [x] validate が throw する rule は console.error して skip、他 rule は動く
    - [x] standalone でも pre-check の dispatched と適用 action の dispatched が一致する
    - [x] replaceRules で消した rule を同 id で戻すと、拒否中なら初回 warn が再び出る
- `src/core/local-slice.test.ts` / `src/core/synced-slice.test.ts` (レビュー反映)
    - [x] primitive state の local でも拒否は state を返す
    - [x] 型: prepare 付き記法で prepare の payload と mutate 注釈の食い違いは `@ts-expect-error`
- `src/index.test.ts`
    - [x] runtime export は不変。validate 型を公開

## notes

- slice 記法では mutate 内の `action.payload` は注釈が無いと any (RTK の case reducer と同じ)。推論が効くのは生成 creator と validate の側。`createSyncedAction` は overload の generic で両方に型が付く
- local の `reset: { mutate: (state) => ... }` の creator は RTK の `ActionCreatorWithoutPayload` (引数 `void`) に写る。synced 側は `PayloadArgs<void>` で `[]`
- 実装は Claude が行い、Codex はレビューのみ (2026-10-12 の方針。CLAUDE.md の旧記述は削除した)
