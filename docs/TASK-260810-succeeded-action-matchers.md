# TASK-260810: locals 用の成功判定 matcher (isSucceededAction / isMySucceededAction) の提供

- Date: 2026-08-10
- Status: Implemented
- 由来: 移植元 repo の locals reducer (シーン遷移) が「synced action が受理されたか / 自分の操作か」を result の hash 照合で判定する helper (isSucceededGameAction / isMySucceededGameAction 相当) を持っており、テンプレ移行 (Phase 2) で必要になることが確認された
- 関連: ADR-0013 (result lifecycle。Out of scope 1 を本 TASK で解禁), ADR-0001 Decision 8 (meta.root は locals 専用), SPEC-0002 (公開 API)

## 問題

移植元 consumer は locals reducer から「直前に適用された synced action が成功したか」を以下のロジックで判定している:

```
result = action.meta.root.<syncedKey>.result
成功 = result.action.meta.hash === action.meta.hash && result.type === 'success'
自分 = 上記 && (standalone なら常に true / 同期中は meta.requestedBy === selfId)
```

このロジックは synqux の内部契約 (ADR-0013 の pre-stamp、hash 照合の意味論、meta.root の付与規約、requestedBy / selfId / enabled) に全面依存しており、consumer 側に書かせると result stamping の仕様変更のたびに黙って壊れる。synqux が所有して仕様変更に追従させるべき。

また、hash 照合は standalone 時 `undefined === undefined` で恒真になるため、「synced domain action かどうか」の述語ガードなしでは非 synced action への誤判定 (false positive) が起きる。移植元は throw で防いでいたが、これは consumer のドメイン知識のため synqux に持ち込まず、consumer が既に持つ `isSyncedAction` 述語を注入して構造的に防ぐ。

## 設計

新規ファイル `src/core/matchers.ts` に factory を 1 つ追加する:

```ts
export const createSyncedActionMatchers = <
  TAction extends Action,
  TSynced extends SynquxSynced,
  TRoot extends { synqux: SynquxState },
>(config: {
  /** synced domain action の判定述語 (createSynquxRootReducer と同じもの) */
  isSyncedAction: (action: Action) => action is TAction
  /** root state から synced slice を取り出す selector (createSynquxRootReducer の返り値) */
  selectSynced: (root: TRoot) => TSynced
}): {
  isSucceededAction: (action: Action) => action is TAction
  isMySucceededAction: (action: Action) => action is TAction
}
```

- `createSynquxRootReducer` の返り値 (`selectSynced` / `isSyncedAction`) をそのまま渡せる形にする (ADR-0013 Decision 2 の「述語の single source」慣用句の踏襲)
- **isSucceededAction(action)**:
    1. `config.isSyncedAction(action)` でなければ false (hash 恒真問題のガード)
    2. `action.meta.root` がなければ false (locals 文脈以外では常に false)
    3. `selectSynced(root).result` が存在し、`result.action.meta?.hash === action.meta?.hash` かつ `result.type === 'success'` なら true
- **isMySucceededAction(action)**:
    1. `isSucceededAction(action)` でなければ false
    2. `root.synqux.enabled === false` (standalone) なら常に true (移植元踏襲。selectIsHost と同じ fallback パターン)
    3. 同期中は `root.synqux.connections.selfId` と `action.meta.requestedBy` が両方存在し一致するときのみ true
- 移植元との差分: 非 domain action で throw しない (false を返す)。throw は consumer の厳格さであり、matcher は RTK の `builder.addMatcher` へ直接渡せる必要があるため
- docstring に「**locals reducer 専用**。meta.root は locals にしか付与されない (ADR-0001 Decision 8) ため、synced reducer 内では常に false になる。synced reducer から端末ローカル情報を読むことは決定性を壊すため、そもそも行ってはならない」旨を明記する

## テスト計画

`src/core/matchers.test.ts` を新規作成。`createSynquxRootReducer` で組んだ rootReducer に action を通し、locals reducer が受け取る action (meta.root 付き) を捕捉して matcher を検証する (meta.root の付与規約と結合した現実的なテストにする)。

- [x] 受理された synced action (default success stamp) で isSucceededAction が true
- [x] `stateWithError` で拒否された synced action で false
- [x] 非 synced action (local action) で false — standalone (hash が両側 undefined) でも false になること (hash 恒真ガードの red を先に確認)
- [x] meta.root なしの action (rootReducer を通さない生 action) で false
- [x] isMySucceededAction: standalone (enabled=false) では成功 action なら常に true
- [x] isMySucceededAction: 同期中 requestedBy === selfId で true、不一致で false、selfId null で false
- [x] 型: isSucceededAction が `action is TAction` の type guard として機能する (matcher 内で payload に型安全にアクセスできる)

## 完了条件

- [x] 上記テスト green (hash 恒真ガードは red → green の順で確認)
- [x] `src/index.ts` から `createSyncedActionMatchers` を export (「ゲーム開発者層」セクション)
- [x] `npm run fix` / `npm test` pass
- [x] ADR-0013 の Out of scope 1 に「TASK-260810-succeeded-action-matchers で提供済み (テンプレ移行で必要性が確認されたため)」の追記
- [x] SPEC-0002 (公開 API) へ追記
- [x] README の公開 API 一覧へ追記
- [x] 本 TASK の Status を Implemented へ更新
