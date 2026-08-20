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
- ~~**createSyncedSlice など RTK API の全面 wrap**: 学習コストの源泉になる。配布するのは「型が強化された既知の RTK primitive」に限定し、新しい抽象は作らない (YAGNI)~~ → Amendment (2026-08-21) で createSyncedSlice のみ採用へ転換。registry 導入後は素の createSlice が synced slice に対して罠になり、「既知の RTK primitive の型強化版」という本 ADR の基準に createSyncedSlice 自体が適合するため (全面 wrap はしない方針は維持)
- **instance (createSynqux) から束縛済み helper を配る**: reducer が instance を import する循環が生じる。型束縛だけなら kit で足りる
- **required meta の全面 1 本化 (`SynquxActionMeta` 自体を required 化)**: locals reducer には metaSetter を通らない local 起点 action も流れる (hash / dispatched を持たない) ため、wire 語彙は optional のまま残す必要がある

## Open Questions

- ~~**isSyncedAction 自体の library 導出**~~: → Amendment (2026-08-20) で決着。導入 consumer の実測で「全 synced action が createSyncedAction 経由」が既に成立していたため、creator registry 方式を採用した

## Consequences

- consumer の synqux 由来 boilerplate は「kit を呼ぶ 1 ファイル」に集約される。導入 consumer 実測で削除できるもの: `GameAction` / `GameActionOf` / `getRequiredMetaOrFail` / `AppAction` 相当の自作型、results wrapper 4 関数、テスト用 stamper、matchers への型二重供給
- consumer が `PayloadAction` を直接使う場面は消える (locals は `LocalAction`、synced は creator からの推論)
- creator の型が synqux 依存になるため、synqux を外す場合の脱出コストは上がる。素の RTK action も metaSetter fallback (ADR-0024 Decision 4) で動作は継続するため、段階的な脱出路は残る (Amendment 後の補足: kit 方式では fallback は meta 補完のみで、その type が registry に登録済みでなければ synced と判定されない。無条件に手書き predicate で拾えるのは primitive 方式のみ)

## Amendment (2026-08-20): creator registry と createSynquxKit

Open Question「isSyncedAction の library 導出」を決着し、あわせて kit を factory 化した
(実装は `TASK-260820-synced-action-registry.md`)。

1. **creator registry 方式を採用する**。判断保留の前提条件「全 synced action が
   createSyncedAction 経由」は、導入 consumer の実測で既に成立していた (synced action
   は全て createSyncedAction 経由、slice `reducers` ブロックに残るものは非同期対象のみ
   と明示済み)。kit の createSyncedAction が type を kit 内部の registry (Set) へ登録し、
   kit が registry 由来の `isSyncedAction` を返す。「createSyncedAction で定義した =
   同期対象」が定義そのものになり、手書き predicate (prefix 規約 + 除外リスト) の
   typo・保守漏れによる silent な同期漏れと、store / matchers への二重供給が消える。
   prefix 方式の fallback は残さない (二重機構になるため)
2. **`synquxKit.withTypes<T>()` → `createSynquxKit<T>()` へ改名**。withTypes は RTK idiom
   で「純粋な型付け直し・何回呼んでも無害」を約束する名前だが、registry を持つ kit は
   呼ぶたび独立した registry になりその約束を破る。factory 命名で「作ったものを使い回す。
   1 app 1 回」の意味論を名前に乗せる。Decision 4 の「束縛は型のみ」は本 Amendment で
   「型束縛 + creator registry (instance 非依存は維持、循環 import 回避もそのまま)」に改める
3. **standalone `createSyncedAction` export を削除** (kit 経由のみ)。kit 非経由の creator
   は registry に載らず「作れるのに同期されない」抜け道になるため、import 自体を構造的に
   不可能にする。primitive 方式 (手書き predicate) は core が述語注入を受け続けるため
   従来どおり成立する (typed creator は使えなくなるが実利用者はいない)
4. **kit 版 `createSyncedActionMatchers` は `{ selectSynced }` だけ受ける** (isSyncedAction
   は registry 自動束縛)。core 版は従来シグネチャのまま
5. kit の `isSyncedAction` の narrow 先は `T['synced']` の Result 束縛から推論した
   domain action union (手書き predicate が担っていた dispatchAndWait / automations /
   listeners の TAction を registry 化で失わないため)。`root` 型は含めない — 判定対象の
   action は dispatch / request 配達時点のもので meta.root を持たない (root 込みの型が
   要る文脈は matchers が担う)。実行時は RTK の creator.match と同じく type 文字列照合
   のみで、meta の実在は ADR-0024 Decision 4 の不変条件が保証する (述語は検査しない)
6. kit の createSyncedAction は `synqux/` 予約 prefix の type を定義時に throw で拒否する。
   手書き predicate が担っていた「system action の除外」責任が library 側へ移ったため、
   内部 action (synqux/restored 等) の registry 汚染 (= 内部 restore の request 化) を
   fail-fast で防ぐ

新たに明文化した契約 (トレードオフの引き受け):

- **登録は creator 定義モジュールの import 副作用**。synced reducer が
  `addCase(creator, ...)` で creator を静的参照する限り store 構築時に全登録が済む。
  creator の lazy import は「ロード前に他端末から届いた action を synced と判定できない」
  ため禁止
- **creator と isSyncedAction は同じ kit の戻りから取る** (kit を複数回作ると registry が
  分裂する)。判定は type 文字列基準 (配達 action は封筒から再構築されるため brand は不成立)

## Amendment (2026-08-21): createSyncedSlice (同期 slice の第一級サポート)

実装は `TASK-260821-create-synced-slice.md`。

registry 導入 (前 Amendment) で「素の createSlice を synced slice に使うと creator が
registry 非登録 + meta 非 stamp になる」罠が残っていた。RTK の第一 idiom を synced で
も成立させ、対応を一対一にする:

| RTK | synqux kit | 用途 |
| --- | --- | --- |
| `createSlice` | `createSyncedSlice` | slice 内 action (定義した case は全部 synced) |
| `createAction` | `createSyncedAction` | slice 外・横断 action (builder 合成の synced reducer や locals の extraReducers で消費) |

1. **`createSynquxKit` の戻りに `createSyncedSlice` を追加**。RTK createSlice の
   `{ name, initialState, reducers, extraReducers? }` サブセット互換。runtime は各
   case を `{ reducer, prepare }` object 記法へ変換して RTK createSlice へ委譲し、
   合成 prepare が生成時 stamp (ADR-0024) と registry 登録 (`${name}/${key}`) を行う。
   extraReducers は RTK 本来の意味論のまま「他所で定義された action への追従」で、
   slice は action を定義しない (レビューで一度削除したが、保証の範疇の履き違い
   としてユーザ判断で復活。下記 4. 参照)
2. 対応記法は plain case reducer と `{ prepare, reducer }` の 2 つ。RTK 2.x の
   callback creators (create.asyncThunk 等) は非対応 (YAGNI)。`name: 'synqux'` は
   予約のため定義時 throw
3. 型は kit の他 member と同じ「runtime 素通し + 手書き契約型で境界 cast」方式。
   生成 creator は required な `SyncedActionMeta<TRoot>` を持ち、case reducer の
   action 注釈 (`SyncedAction<P>` / `PayloadAction<P>`) から payload が推論される
4. 保証のスコープは「**slice が定義する (= reducers ブロックの) action は全て
   synced**」であり、「slice が非 synced action を定義する」状態は構造的に書けない。
   extraReducers はこの保証の対象外 — RTK 意味論上 action を定義する場所ではなく、
   synced かどうかは追従先 creator の定義側が決める。「synced state を変える case は
   synced action にだけ書く」は合成 reducer / primitive 方式にも共通する synced
   reducer 全般の doc 契約で、本 API 固有の保証ではない。従来 slice に残っていた
   local な抜け穴 (tutorial bootstrap 等) は ADR-0018 Amendment の `seedSynced` が
   公式経路として引き受ける
5. あわせて kit の results 系束縛 (generateResult / stateWith*) の action 型を
   `SyncedAction<any, T['root']>` から **SyncedActionOf<T> (state 自身の Result と
   同じ union)** へ変更。stateWith* は synced reducer 内 (meta.root が存在しない文脈)
   で呼ぶ helper であり、root 型を含める理由がなかった (述語の narrow と同じ整理)

## Amendment (2026-08-21): kit への selectSynced 集約

導入 consumer の追従作業で「synced の位置 (root.game 等)」を matchers 生成時にも
供給させられている残債が確認された (registry 化で二重供給を潰した後の最後の 1 箇所)。

1. **`createSynquxKit<T>({ selectSynced })` として factory が selectSynced を受ける**。
   synced key の命名は consumer の領域 (synqux が予約するのは `state.synqux` のみ) の
   ため「どこにあるかを教える責任」自体は consumer に残るが、供給点を kit の 1 箇所に
   畳む
2. **kit は matchers (isSucceededAction / isMySucceededAction) を束縛済みで直接返す**。
   kit 版 `createSyncedActionMatchers` factory は廃止 (core 版は primitive 方式用に
   従来どおり)
3. `createSynquxRootReducer` の synced record key は state 構成 (shape) の宣言で、
   kit の selectSynced は読み取り位置の宣言 — 役割が異なるため統合しない。kit は
   instance 非依存 (循環 import 回避) の構造上、store 側配線から selector を
   受け取る経路は取れない
