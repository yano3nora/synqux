# TASK-260821: defineSynqux — 定義と配線の二相 API への統合

- Date: 2026-08-21
- 関連: ADR-0026 (新規)、ADR-0025 の kit 系 Amendment 群 (本 TASK で supersede)、
  TASK-260821-kit-select-synced の続き

## 背景 / 決定 (ユーザ合意済み)

- consumer が `SynquxState` を import して RootState を手書きする利点がない —
  root は「syncedKey + synced reducer + locals」から synqux 側で導出できる
- kit は registry → matchers → syncedKey と「synqux の定義エンティティ」へ収束
  しており、当初の「型束縛のみ」の定義に固執する理由がない。instance 生成まで
  統合する
- ただし **reducer モジュールが transport / store なしで import できること**
  (creator の module 評価時 import) は譲れない構造制約のため、単一関数への統合は
  runtime 循環 (TDZ) で成立しない。**二相**に分ける:
  1. **定義フェーズ `defineSynqux({ syncedKey }).withTypes<T>()`**: creators / registry /
     matchers / result helpers / 型語彙。reducers はこれだけを import する
  2. **配線フェーズ `definition.createSynqux({ transport, synced, locals, ... })`**:
     rootReducer / selectSynced / isSyncedAction の接続を内部化し、root 型を
     `SynquxRootState<TKey, TSynced, TLocals>` として導出して instance を返す。
     consumer の RootState は `ReturnType<typeof synqux.rootReducer>` で得る
     (手書き root と SynquxState import が消える)
- **命名**: 「kit」は道具袋の呼称で実体と乖離したため廃止 (ユーザ指摘)。
  `createSynquxKit` → `defineSynqux`、`SynquxKitTypes` → `SynquxTypes`
  ({ synced, message? } に縮小 — root は削除)。定義/配線のフェーズ名と
  define/create が一対一に対応する
- 定義フェーズの creators / matchers の root 型は、定義時点で判明している部分
  root (`{ synqux } & Record<TKey, TSynced>`) を使う。sibling locals まで読む
  文脈は従来どおり `LocalAction<P, TRoot>` 注釈 (TRoot は導出 RootState)
- **primitive 方式 (core の createSynqux / createSynquxRootReducer への述語注入)
  は従来どおり維持** (注意点 1)。defineSynqux は推奨 facade
- root 導出により `SyncedKeyOf` の整合検証は不要になり削除 (検証対象の手書き
  root が存在しない)

## 作業項目 (synqux 側のみ。310 追従は別タスク)

- [x] `src/core/kit.ts` → `src/core/define-synqux.ts` へ改名・再設計
      (defineSynqux / SynquxTypes / SynquxDefinition / createSynqux member)。
      NOTE: TS の型引数部分推論不可 (#26242) により、呼び出しは
      `defineSynqux({ syncedKey }).withTypes<T>()` の 2 段チェーンとした
      (withTypes は純粋な型 cast で registry は分裂しない — ADR-0026 Decision 4)
- [x] `src/index.ts` / `src/index.test.ts` 公開 surface 更新
- [x] テスト追従 (kit-integration → define-synqux.test / kit-slice → synced-slice.test) + 二相 e2e / 導出 RootState の型テスト
- [x] demo 追従 (手書き DemoRootState / SynquxState import の削除)
- [x] ADR-0026 新規、ADR-0025 へ supersede 注記、SPEC-0002、README
- [x] `npm run fix` / `npm test` (394 tests / lint / tsc / tsc-demo 全 green)
- [ ] Codex レビュー
