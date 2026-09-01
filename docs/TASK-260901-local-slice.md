# TASK-260901: buildCreateLocalSlice (locals reducer の meta.root 型付け)

- Status: Done (2026-09-01)
- 関連: ADR-0027、fc-310 の scenes slice (第一消費者)

## 背景

fc-310 の locals slice (scenes) の extraReducers で、synced action の meta.root を
読むために `action as LocalAction` cast が散在していた。詳細は ADR-0027 Context。

## 設計

外部設計レビュー (codex) 済み。指摘の反映:

- 交差 (`& { meta?: { root?: TRoot } }`) では creator の `root?: any` に潰される
  → `WithLocalMeta` による **root 置換** (Omit + IsAny fallback) へ変更
- builder のミラー範囲を **宣言 subset** として明文化 (addAsyncThunk 対応外)
- reducers ブロックの payload 自動推論は不可能 → `LocalAction<P>` 注釈を維持し、
  `LocalActionOf` で束縛済み factory から注釈型を逆引きできるようにした

実装レビュー (codex、同スレッド) の反映:

- `ReplacedMeta` が meta 内の判別 union を共通キーへ潰す → naked conditional
  (`ReplacedKnownMeta`) で分配してから Omit する形へ修正
- guard matcher の narrow 先が非 Action 型の場合に type が消える →
  RTK 同様の `A extends Action ? A : A & Action` 正規化を追加
- 型テスト不足 (meta union 分配 / optional meta 維持 / meta なし action /
  type 文字列 addCase / 非 Action guard / action union 分配) → probe slice +
  WithLocalMeta 直接検証を追加
- TMeta の実在は synqux が保証しない (optional で宣言する契約) を JSDoc / SPEC に明記

## 実装

- `src/core/local-slice.ts`: WithLocalMeta / LocalUnknownAction /
  LocalMatcherBuilder / LocalReducerBuilder / CreateLocalSlice / LocalActionOf /
  buildCreateLocalSlice
- `src/core/local-slice.test.ts`: 型テスト (root 置換・TMeta 合流・LocalActionOf
  逆引き) + runtime テスト (createSlice 素通し・rootReducer 配下での meta.root
  読み取り)
- `src/index.ts` / `src/index.test.ts`: 公開 surface へ追加
- SPEC-0002: subpath exports 一覧へ追記
