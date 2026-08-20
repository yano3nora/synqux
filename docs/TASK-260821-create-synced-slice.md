# TASK-260821: createSyncedSlice (同期 slice の第一級サポート)

- Date: 2026-08-21
- 関連: ADR-0025 (consumer 語彙) の Amendment、TASK-260820-synced-action-registry

## 背景 / 決定

registry 導入で「synced action の定義経路は kit の createSyncedAction のみ」になったが、
RTK の第一 idiom である createSlice が synced slice に対して罠のまま残っている
(reducers ブロック生成の creator は registry 非登録 + meta 非 stamp)。シンプルなアプリは
「slice 1 個だけの synced 実装」が妥当な規模であり、「RTK 知識で同期アプリを実現」
というコンセプトに合わせて **createSlice の synced 版を kit が提供する**:

1. **`createSynquxKit` の戻りに `createSyncedSlice` を追加**。RTK createSlice の
   `{ name, initialState, reducers, extraReducers? }` サブセット互換。extraReducers はレビュー指摘で一度削除したが、「保証は reducers ブロック (= slice が定義する action) にだけ掛かる。extraReducers は RTK 意味論上 action を定義しない追従口で保証の範疇外」というユーザ判断で復活
2. runtime は各 case を `{ reducer, prepare }` object 記法へ変換して RTK createSlice に
   委譲する。合成した prepare が生成時 stamp (normalizeSyncedActionMeta) を行い、
   type (`${name}/${key}`) を kit registry へ登録する (定義 = 同期対象の宣言)
3. 対応する case 記法は plain case reducer と `{ prepare, reducer }` の 2 つ。
   RTK 2.x の callback creators (`create.asyncThunk` 等) は非対応 (YAGNI、doc 明記)
4. `name: 'synqux'` は予約のため定義時 throw (createSyncedAction の prefix 拒否と同じ)
5. 型は kit.ts と同じ「runtime 素通し + 手書き契約型で cast」方式。生成 creator は
   `SyncedActionMeta<TRoot>` required の戻り型を持ち、case reducer の action 注釈は
   `SyncedAction<P>` / `PayloadAction<P>` どちらでも payload が推論される
6. RTK との対応を一対一にする: `createAction` ⇔ `createSyncedAction` (slice 外・横断)、
   `createSlice` ⇔ `createSyncedSlice` (slice 内。定義した action は全部 synced)。
   synced slice に非 synced action の case を書ける構造自体を消す

## 作業項目

- [x] `action.ts`: `PreparedMetaOf` を内部 export (kit から再利用)
- [x] `kit.ts`: `createSyncedSlice` 実装 (runtime + 契約型)
- [x] テスト: 生成時 stamp / registry 登録 / prepare 変種 / 予約 name 拒否 /
      型推論 (expectTypeOf) / memory hub e2e (slice だけで同期が成立)
- [x] demo を単一 slice 実装へ書き換え (規模的に slice が妥当な実例として)
- [x] README (Typed vocabulary 節・API 表・Quick Start)・SPEC-0002・ADR-0025 Amendment
- [x] `npm run fix` / `npm test`
- [x] Codex レビュー → **Approve** (2026-08-21)。指摘対応の経緯:
    - 予約 namespace: name の完全一致だけでなく `synqux/` prefix も定義時 throw
    - extraReducers: 「任意 action の追従口は保証の抜け穴」指摘で一度削除 →
      ユーザ裁定で復活 (保証は reducers ブロックにスコープ。上記 1. 参照)。
      外部 synced creator を追従するテストを追加
    - SPEC の Synqux generic 順序 / react シグネチャの不整合を実装へ追従

## 完了条件

- demo が createSyncedSlice 1 個で書け、素の createSlice を synced に誤用する経路が
  ドキュメント上も API 上も主役から消える
- 公開 surface 回帰テストが新一覧で green
