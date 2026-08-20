# ADR-0026: defineSynqux — 定義と配線の二相 API

- Status: **Accepted**
- Date: 2026-08-21
- 関連: ADR-0025 (consumer 語彙。kit 系 Amendment 群は本 ADR が supersede)、
  ADR-0001 Decision 3 / 8、SPEC-0002、`TASK-260821-define-synqux.md`

## Context

- kit (createSynquxKit) は registry → matchers → syncedKey と段階的に責務を吸収し、
  実質「synqux の定義エンティティ」に収束していた。一方で以下の残債があった:
  1. **consumer が `SynquxState` を import して RootState を手書きしている**。
     root は「syncedKey + synced reducer + locals」から機械的に導出できる情報で、
     手書きする利点が consumer 側にない (ユーザ指摘)
  2. kit と createSynqux の間の手渡し (isSyncedAction / syncedKey /
     createSynquxRootReducer の spread) が consumer の配線 boilerplate として残る
  3. 「kit」という命名が実体 (定義エンティティ + 配線 factory) と乖離 (ユーザ指摘)
- ただし譲れない構造制約が 1 つある: **reducer モジュールは creator (runtime 関数 +
  registry 副作用) を module 評価時に import する必要がある**。instance (transport /
  store) と単一関数に畳むと reducers → instance → reducers の runtime 循環 (TDZ) に
  なるため、「全部を createSynqux に統合」は成立しない

## Decision

1. **二相 API に統合する**。
   - **定義フェーズ `defineSynqux({ syncedKey })`**: creator registry / creators
     (createSyncedAction / createSyncedSlice) / isSyncedAction / matchers /
     result helpers / 型語彙を配布する。transport / store に依存せず、reducer
     モジュールはこれだけを import する
   - **配線フェーズ `definition.createSynqux({ transport, synced, locals, ... })`**:
     rootReducer / selectSynced / isSyncedAction の接続を内部化し、instance を返す。
     group を跨ぐ際の作り直し契約 (core と同じ) のため singleton ではなく factory
2. **root 型は配線フェーズが導出する**。`SynquxRootState<TKey, TSynced, TLocals>` を
   組み立て、consumer は `ReturnType<typeof synqux.rootReducer>` で RootState を得る。
   手書き root と consumer 側の `SynquxState` import は消える。導出に伴い
   `SynquxTypes` (旧 SynquxKitTypes) から `root` を削除し `{ synced, message? }` に
   縮小、手書き root との整合検証だった `SyncedKeyOf` も削除 (検証対象が消滅)
3. **命名: `createSynquxKit` → `defineSynqux`**。define (定義) / create (配線) が
   フェーズと一対一に対応する (defineStore 系の既知 idiom)。「kit」呼称は廃止
4. **呼び出しは `defineSynqux({ syncedKey: 'game' }).withTypes<T>()` の 2 段チェーン**。
   TS は型引数の部分推論を許さない (all-or-nothing) ため、「syncedKey の literal
   値推論」と「T の明示束縛」は単一呼び出しに畳めない。withTypes は**純粋な型 cast**
   で、状態 (registry) は defineSynqux が 1 回だけ作る — 旧 withTypes を廃止した
   理由 (呼ぶたび registry が分裂する) は本形では構造的に発生しない。
   ただし同一 registry へ矛盾した型 view を付けないため **withTypes は 1 回だけ**:
   束縛後の定義には withTypes が存在せず chain での再束縛は型で封じる (base を
   変数に残した別 domain 型での再束縛は doc 契約で禁止。レビュー指摘)
5. **creators の meta.root は型付けない (any)**。root は配線フェーズまで未知で、
   部分 root を主張すると locals の addCase 注釈 (`LocalAction<P, 導出RootState>`)
   と代入不能になり従来の注釈 idiom を壊す (レビュー指摘)。root の型は読み手の
   `LocalAction<P, TRoot>` 注釈が与える。**matchers の narrow にのみ部分 root**
   (`{ synqux } & Record<TKey, TSynced>`) を使う — narrow は注釈と交差評価される
   ため部分 root で安全に root.<syncedKey> が型付く
6. **primitive 方式 (core の createSynqux / createSynquxRootReducer への述語注入) は
   維持する**。defineSynqux は推奨 facade であり、core の削除・隠蔽ではない

## Rejected Alternatives

- **createSynqux への単一統合**: 上記の runtime 循環 (TDZ) で成立しない。当初の
  「kit は型束縛のみ」定義が強いのではなく、この module 評価順の制約だけが本質
- **定義フェーズに locals の型/形も渡して root を kit 側で完結導出**: store 配線の
  locals map と重複が移動するだけで、二重供給の解消にならない
- **単一呼び出し `defineSynqux<T>({ syncedKey })`**: TKey が default (string) に
  落ちて導出 root が index signature に壊れる (TS #26242)。curried
  `defineSynqux<T>()({...})` は空呼び出しが露出するため withTypes チェーンを採用

## Consequences

- consumer のセットアップは「定義 1 ファイル + 配線 1 ファイル」に畳まれ、
  `SynquxState` / `createSynquxRootReducer` / rootReducer spread が consumer コード
  から消える。RootState は導出 (`ReturnType<typeof synqux.rootReducer>`)
- pre-1.0 の breaking (createSynquxKit / SynquxKitTypes の削除)。既知の利用は
  導入 consumer 1 repo のみで、リリース前に追従する
- ADR-0025 の Amendment 群 (registry / syncedKey / matchers 直接配布) の決定内容は
  本 ADR の defineSynqux にそのまま引き継がれる (機構は同一、命名と統合形のみ変更)
