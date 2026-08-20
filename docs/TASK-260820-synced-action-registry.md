# TASK-260820: isSyncedAction の library 導出 (creator registry) と kit の factory 化

- Date: 2026-08-20
- 関連: ADR-0024 (action identity)、ADR-0025 (consumer 語彙) の Open Question 決着、BACKLOG「isSyncedAction の library 導出」「demo を createSyncedAction / synquxKit へ移行する」

## 背景 / 決定

ADR-0025 の Open Question「isSyncedAction の library 導出」を実装に昇格する。
判断保留の条件だった「全 synced action が createSyncedAction 経由であること」は、
導入 consumer の実測で既に成立している (synced action は全て createSyncedAction 経由、
slice `reducers` ブロックに残るものは非同期対象のみと明示済み)。

決定事項 (ユーザ合意済み):

1. **creator registry 方式を導入する**。kit が発行する `createSyncedAction` が
   type 文字列を kit 内部の registry (Set) へ登録し、kit が registry 由来の
   `isSyncedAction` を返す。consumer の手書き predicate (prefix 規約 + 除外リスト)
   と matchers / store への二重供給を丸ごと不要にする
2. **`synquxKit.withTypes<T>()` → `createSynquxKit<T>()` へ改名する**。withTypes は
   RTK idiom で「純粋な型付け直し・何回呼んでも無害」の約束の名前だが、registry を
   持つ kit はその約束を破る (呼ぶたび別 registry)。factory 命名で「作ったものを
   使い回す。1 app 1 回」の意味論を名前に乗せる
3. **standalone `createSyncedAction` export を削除する** (kit 経由のみに絞る)。
   kit 非経由の creator は registry に載らず「作れるのに同期されない」抜け道に
   なるため、import 自体を構造的に不可能にする。breaking (0.x)
4. **kit 版 `createSyncedActionMatchers` は `{ selectSynced }` だけ受ける**
   (isSyncedAction は registry 自動束縛)。core 版 (primitive 方式) は従来
   シグネチャのまま
5. **core (createSynqux / createSynquxRootReducer / core 版 matchers) は predicate
   注入のまま無変更**。registry は kit に閉じ、モジュール変数のグローバル状態を
   作らない。primitive 方式 (手書き predicate) は従来どおり成立する

## 新しく明文化する契約 (デメリットの引き受け)

- **registry への登録は creator 定義モジュールの import 副作用**。synced reducer が
  `addCase(creator, ...)` で creator を静的参照する限り store 構築時に全登録が
  完了する。creator の lazy import は「ロード前に他端末から届いた action が
  synced と判定されない」ため禁止 (doc 契約)
- **creator と isSyncedAction は同じ kit の戻りから取る**。`createSynquxKit` を
  複数回呼ぶと registry が分裂する (factory 命名で誤用を抑止)
- 判定は type 文字列基準 (配達 action は封筒から再構築されるため brand は不成立)。
  HMR 等で古い Set を掴んでも type 名が変わらない限り実害はない

## 作業項目

- [x] 設計・ユーザ合意 (本文書)
- [x] `src/core/kit.ts`: `createSynquxKit` 実装 (registry + isSyncedAction +
      matchers 自動束縛)。`synquxKit` 削除。述語の narrow 先は `T['synced']` から
      推論した domain action union (root 型は判定時点で実在しないため含めない。
      matchers 側でのみ root 型を焼き直す)
- [x] `src/index.ts` / `src/index.test.ts`: 公開 surface 更新
      (`createSyncedAction` 削除、`synquxKit` → `createSynquxKit`)
- [x] `src/core/action.test.ts`: kit テスト改名 + registry の挙動テスト
      (登録 / 未登録 / kit 分離 / matchers 自動束縛)
- [x] demo を kit へ移行 (BACKLOG 項目吸収): `demo/synqux.ts` 新設、
      counter / ledger に creator 定義、main.ts の素の dispatch を creator 呼びへ。
      action 型も ADR-0024 の不変条件へ追従 (meta: SyncedActionMeta 必須)
- [x] README: Quick Start の手書き predicate を kit 由来へ、
      Typed action vocabulary 節と API 表の更新
- [x] SPEC-0002: kit 節と export 一覧の更新
- [x] ADR-0025: Amendment (Open Question 決着、withTypes 廃止理由、kit の
      状態保有、standalone export 削除)
- [x] ADR-0024: Decision 3 の「同一 hash 重複排除は BACKLOG 管理」を
      「導入しない」へ更新 (ユーザ決定)
- [x] BACKLOG: 「同一 hash 排除」「isSyncedAction 導出」「demo 移行」を削除
- [x] `npm run fix` / `npm test` (oxlint / oxfmt / tsc / tsc-demo すべて green)
- [x] Codex レビュー (1 回目) と対応
    - High「述語の虚偽 narrowing (`SyncedAction<any>` を主張するが実行時は type 照合のみ)」
      と Medium「domain action union の喪失」は表裏として一括対応: narrow 先を
      `T['synced']` の Result 束縛から推論した domain union (`SyncedActionOf<T>`) に変更。
      実行時 type 照合のみは RTK creator.match と同じ契約 (meta は ADR-0024 Decision 4 の
      不変条件が保証) としてコメント・ADR に明文化
    - High「`synqux/` 予約 type を registry へ登録できる」: kit の createSyncedAction が
      定義時に throw で拒否 (fail-fast)
    - Medium「registry 述語での分散経路テスト不足」: `kit-integration.test.ts` 新設
      (request 化 → host 裁定 → 封筒再構築の全端末適用 / 登録済み type の素 action への
      metaSetter fallback / 途中参加の snapshot restore)。予約 prefix 拒否と narrowing の
      型テストも action.test.ts へ追加
    - Docs「metaSetter fallback で動作継続の記述が Amendment 後は条件付き」: ADR-0025
      Consequences に限定を追記
- [x] Codex 再レビュー (2 回目) と対応
    - 「domain union narrowing は自由な creator 登録と型論的に両立しない (blocker)」:
      指摘の事実関係は認めた上で narrow は維持。理由 — (a) 手書き predicate
      (`a is DomainAction` + prefix 照合) が元々持っていた不健全性と同型で、
      status quo からの後退ではない (b) union 外の creator を登録した時点で
      受理 action が積まれる Result<A> の型宣言自体が破綻しており、「登録
      creator ⊆ union」は narrowing が新設した義務ではなく synced state 型宣言の
      既存義務。この契約を kit.ts コメント / SPEC-0002 に明文化し、型テストも
      整合した creator で branch を実走させる形へ修正
    - 「kit 版 matchers で domain union が再び失われる」: narrow 先を
      `SyncedActionOf<T> & SyncedAction<any, T['root']>` の交差型へ変更
    - 「integration test が別 realm 相当の独立 registry を再現していない」:
      端末ごとに独立した kit で同一 creator 定義を評価するテストを追加
    - 「docs の古い型判断 / SPEC 未記載」: TASK 記述を修正、SPEC-0002 に
      narrowing 契約と `synqux/` prefix 拒否を追記
- [x] Codex 最終確認 → **Approve** (2026-08-21)。nit のテスト header comment の
      矛盾も修正済み

## 完了条件

- kit だけで「creator 定義 = 同期対象の登録」が成立し、手書き predicate なしで
  createSynquxRootReducer / matchers が配線できる
- demo が素の action dispatch を持たず、README の実例と一致する
- 公開 surface 回帰テスト (`src/index.test.ts`) が新しい一覧で green
