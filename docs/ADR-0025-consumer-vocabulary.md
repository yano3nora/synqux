# ADR-0025: consumer への型付き語彙の配布 (createSyncedAction / LocalAction / synquxKit)

- Status: **Accepted**
- Date: 2026-08-20
- 関連: ADR-0024 (action identity)、ADR-0023 (react slim / api inventory)、SPEC-0002、`TASK-260820-action-identity.md`、TASK-260812 (consumer boilerplate 吸収)

## Context

- 設計ゴール: **react / redux-toolkit を知る front-end 開発者が、同期モジュールの wrapper コードを一切書かず、RTK と同じ見た目・最小の学習量で書ける**こと
- 現実には synqux が store を生成・配線するのに、action の型語彙は consumer が自作している。導入 consumer (具体名は git 管理外の CLAUDE.local.md 参照) では `PayloadAction → AppAction (meta.root 拡張) → GameAction (同期拡張)` の synqux 導入前の自作階層が残り、reducer で meta を触るたび `action: GameActionOf<typeof xxx>` の注釈と runtime narrow (`getRequiredMetaOrFail`) を書いている
- `builder.addCase` の action 型は **creator の戻り型から推論される** (builder の generics では介入できない) ため、注釈を撲滅する唯一の介入点は action creator である
- generics の再束縛も consumer 自作になっている: 導入 consumer の `results.ts` は `stateWithError` 等へ domain 型 (GameState / GameAction / GameResultMessage) を束縛するだけの wrapper 4 関数を持つ。さらに `isSyncedAction` / `selectSynced` を store 配線と matchers 生成の 2 箇所へ二重供給し、`SynquxAutomation<GameState, GameAction>` 等の型再束縛も自作している

## Decision

1. **`createSyncedAction` を提供する**: RTK `createAction` と同一シグネチャ (prepare callback 対応) で、(a) 戻り値の action 型に `meta: SyncedActionMeta` (hash / dispatched required) を含め、(b) ADR-0024 Decision 3 の生成時 stamp を prepare に合成する。consumer の synced reducer は `builder.addCase(creator, (state, action) => action.meta.hash)` と注釈ゼロで書ける
2. **`SyncedActionMeta<TRoot>` / `SyncedAction<P, TRoot>` 型を export する**: hash / dispatched required、response 系 optional (診断専用の注記維持)、`root?: TRoot` を optional で含める
    - root を含めるのは、locals reducer が同期 action へ追従する際 (extraReducers の addCase) に、同じ creator から推論される型で `action.meta.root` を読めるようにするため。**同一 creator から推論される型は文脈別に分けられない**ので、「synced reducer で root を読まない」は型でなく doc 契約とする (決定性の構造保証は runtime で従来どおり担保される — synced reducer に root は渡らない)
3. **`LocalAction<P, TRoot, TMeta>` 型を export する**: locals slice の `reducers` で `PayloadAction<P>` の代わりに使う注釈型。`meta?: { root?: TRoot } & TMeta`。TMeta は consumer 固有の dispatch 時 meta 拡張 (throttle 除外フラグ等) の差し込み口。学習コストは「PayloadAction の代わりに LocalAction と書く」の 1 点に抑える
4. **`synquxKit.withTypes<T>()` を提供する** (RTK の createAsyncThunk / createSelector と同じ idiom): consumer の domain 型 (`synced` / `root` / `message`) を一度だけ束縛し、`createSyncedAction` / `createSyncedActionMatchers` / `generateResult` / `stateWithResult` / `stateWithError` / `stateWithTransaction` を型束縛済みで返す。consumer の再束縛 wrapper を丸ごと不要にする
    - kit は型束縛のみで instance (createSynqux) に依存しない。reducer → instance の循環 import を構造的に避ける
5. 命名は用途基準で統一する: consumer が触る語彙は `SyncedAction` / `LocalAction` / `SyncedActionMeta` / `SyncedActionHash`。`SynquxActionMeta` (全 optional) は封筒・診断・adapter 実装者向けの wire 語彙として残し、consumer ドキュメントの主役から外す

## Rejected Alternatives

- **builder / createSlice の generics で action 型を差し込む**: RTK の推論構造上不可能 (addCase は creator の戻り型を使う)。builder wrapper を作っても per-case の型付け直しが必要になり、注釈撲滅の目的に反する
- **文脈別 (synced / locals) に action 型を分ける**: 同一 creator から推論される型は 1 つしかなく、分けるには per-case wrapper (`inLocals(creator)` 等) が必要で本末転倒。root は optional 1 本化し doc 契約で守る
- **createSyncedSlice など RTK API の全面 wrap**: 学習コストの源泉になる。配布するのは「型が強化された既知の RTK primitive」に限定し、新しい抽象は作らない (YAGNI)
- **instance (createSynqux) から束縛済み helper を配る**: reducer が instance を import する循環が生じる。型束縛だけなら kit で足りる
- **required meta の全面 1 本化 (`SynquxActionMeta` 自体を required 化)**: locals reducer には metaSetter を通らない local 起点 action も流れる (hash / dispatched を持たない) ため、wire 語彙は optional のまま残す必要がある

## Open Questions

- **isSyncedAction 自体の library 導出**: createSyncedAction が type を registry (Set) へ登録すれば、consumer の手書き predicate (`game/` prefix + system action 除外など) を無くせる。配達 action は封筒から再構築されるため brand は使えず type 文字列照合になる点は registry でも成立する。ただし**全 synced action が createSyncedAction 経由であること**が前提になり、createSlice の `reducers` ブロック由来の synced action は移行が必要。prefix 方式を fallback に残すか含めて、consumer 追従の実測を見てから判断する (BACKLOG 管理)

## Consequences

- consumer の synqux 由来 boilerplate は「kit を呼ぶ 1 ファイル」に集約される。導入 consumer 実測で削除できるもの: `GameAction` / `GameActionOf` / `getRequiredMetaOrFail` / `AppAction` 相当の自作型、results wrapper 4 関数、テスト用 stamper、matchers への型二重供給
- consumer が `PayloadAction` を直接使う場面は消える (locals は `LocalAction`、synced は creator からの推論)
- creator の型が synqux 依存になるため、synqux を外す場合の脱出コストは上がる。素の RTK action も metaSetter fallback (ADR-0024 Decision 4) で動作は継続するため、段階的な脱出路は残る
