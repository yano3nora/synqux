# TASK-260720: primitive 方式 (手書き rootReducer) の正式契約化

> BACKLOG P1「primitive 方式 (手書き rootReducer) を正式契約化する」の解消タスク。
> 方針決定 (ユーザ判断): `createSynquxRootReducer` と手書き rootReducer の両方を受け入れる。
> よって `synquxRestored` / `PendingRequest` の export は継続し、隠蔽ではなく契約化で解決する。

## 実装概要

1. SPEC-0002 へ「primitive 方式の正式契約」を追加: `synquxReducer` の mount 位置は
   `state.synqux` 固定、rootReducer での `synquxRestored` match が必須、consumer からの
   dispatch は禁止 (request 経路を通らない差し替えは自端末にしか起きず静かに desync する)。
   公開一覧 (subpath exports 表) に `synquxRestored` / `PendingRequest` を追記
2. `src/core/slice.ts` の `synquxRestored` docstring に dispatch 禁止と理由を明記
3. 公開 surface 回帰テストを追加 (`src/index.test.ts`): main entry の runtime export
   一覧を SPEC-0002 と突合し、export の無自覚な増減を検出する

## 完了条件

- [x] SPEC-0002 と export 実体 (`src/index.ts`) の不整合が解消されている
- [x] 公開 surface 回帰テスト green
- [x] CHANGELOG に記録
- [x] BACKLOG の該当項目を削除
- [x] `npm run fix` / `npm test` pass
