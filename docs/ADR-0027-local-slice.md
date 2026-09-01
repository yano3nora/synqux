# ADR-0027: buildCreateLocalSlice — locals reducer の meta.root 型付け

- Status: **Accepted**
- Date: 2026-09-01
- 関連: ADR-0001 Decision 8 (meta.root チャネル)、ADR-0026 (二相 API・root 導出)、
  SPEC-0002、`TASK-260901-local-slice.md`

## Context

- locals reducer には createSynquxRootReducer が `meta.root` (直前実行後の root
  state) を付与するが、locals slice は素の RTK createSlice で定義されるため、
  extraReducers (synced creator への addCase / isSyncedAction matcher) の action
  型に root が乗らず、consumer は `action as LocalAction` の cast や無理な注釈で
  読んでいた (fc-310 の scenes slice で顕在化)
- 「locals reducer なら meta.root が読める」は synqux の契約そのものであり、
  cast の散在は契約の表現失敗である
- ADR-0026 の帰結として、root 型 (consumer の RootState) は**配線フェーズの
  生成物** (locals 宣言後に `ReturnType<typeof synqux.rootReducer>` で導出)。
  定義フェーズ (defineSynqux) はこれを知り得ない

## Decision

1. **locals slice 用の createSlice factory `buildCreateLocalSlice<TRoot, TMeta>()`
   を standalone export する** (RTK buildCreateSlice の命名慣習)。runtime は RTK
   createSlice への素通しで、仕事は型だけ: extraReducers の builder を
   `LocalReducerBuilder<TState, TRoot, TMeta>` として見せ、addCase / addMatcher /
   addDefaultCase の action に root 型付き meta を与える
2. **meta.root は交差ではなく置換で型付ける** (`WithLocalMeta`)。synced creator の
   meta は既に `root?: any` を持ち、交差では `any & TRoot = any` に潰れる。
   runtime の withRootMeta も root を上書き注入しているため、置換が事実に忠実。
   meta 全体が any の場合も IsAny 判定で丸ごと差し替える
3. **defineSynqux からは配らない**。TRoot を withTypes へ渡すと
   「定義 const の型 ← T ← RootState ← typeof synqux ← createSynqux ← 定義 const」
   の自己参照になり、切断点がなく TS7022 系で破綻する。consumer 側束縛なら循環は
   locals reducer の `Reducer<State>` 明示注釈 (既存の切断点) を通るルートに乗る。
   束縛は consumer のセットアップ層で 1 回:
   `export const createLocalSlice = buildCreateLocalSlice<RootState, TMeta>()`
4. **TMeta で consumer 固有の dispatch 時 meta 拡張** (throttle 除外フラグ等) を
   受ける。`LocalActionOf<typeof createLocalSlice, P>` で束縛済み factory から
   LocalAction 注釈型を逆引きでき、TRoot / TMeta の供給点は束縛 1 箇所に保たれる
5. **builder は RTK ActionReducerMapBuilder の宣言 subset**: addCase (creator /
   type 文字列) / addMatcher (guard / boolean) / addDefaultCase。**addAsyncThunk は
   対応外** (locals の thunk 追従は isPending 等の matcher で書ける)。reducers
   ブロックは RTK object 記法のみ (createSyncedSlice と同じ線引き)、payload は
   従来どおり `LocalAction<P>` 注釈で宣言する (自動推論は原理的に不可能)
6. **root は型上も optional のまま**。creator 単体生成・slice reducer の単体実行
   では root が存在せず、required にすると嘘になる。null 安全は従来どおり
   consumer のガードが担う

## Rejected Alternatives

- **accessor 案 (`createActionRootSelector<TRoot>()`)**: cast を helper 1 箇所へ
  封じ込められ保守は最小だが、呼び出しが散在し「locals reducer の第一級契約」と
  しては表現が弱い。consumer 数箇所の対症には有効なため、採らなかった理由は
  「テンプレ消費者全体で locals を第一級 API にする」判断による
- **synced action 型 (SyncedAction) へ RootState を焼く案**: synced reducer 内でも
  meta.root が型上読めてしまい、「synced では root が構造上渡らない」決定性の
  signature 保証 (ADR-0024 / isMySucceededResult の設計) を壊すため不採用
- **defineSynqux.withTypes へ root を渡す案**: 上記 Decision 3 の型循環。回避には
  RootState 手書きの復活 (ADR-0026 が捨てた供給点重複) が必要になるため不採用

## Consequences

- consumer の locals slice から `action as LocalAction` cast が消え、
  `action.meta.root` が型付きで読める
- builder subset のミラー保守が発生する (RTK peer range `^2.0.0` との整合は
  subset を最小に保つことで吸収。addAsyncThunk 等の追加要望は subset 拡張で対応)
- 素の RTK createSlice による locals 定義も引き続き有効 (buildCreateLocalSlice は
  推奨 facade であり強制ではない)
