# TASK-260719: MemoryHub の drop/duplicate fault を「to 省略時は全端末対象」の仕様と一致させる

> BACKLOG P1「MemoryHub の fault injection 契約を実装と一致させる」の解消タスク。

## 背景 / 問題

- `src/testing/memory-hub.ts` の `FaultTarget.to` は「省略時は全端末への配送が対象」と宣言している
- しかし `drop` / `duplicate` は `OneShotFault.consumed: boolean` により、**最初にマッチした subscriber の配送 1 件**で消費され、他 subscriber へは適用されない (`enqueueRequest`)
- `delay` は released フラグ方式のため全端末に効いており、ズレは drop / duplicate のみ
- P0 各項目 (host 裁定の fault injection、snapshot 競合テスト等) はこのハーネスの上に検証を積むため、ハーネス自体の契約不一致を先に解消する

## 設計決定

- **仕様コメント側を正とする**: `to` 省略時、fault は「1 つのメッセージ (1 回の fan-out) の全 subscriber への配送」に適用され、その 1 メッセージで消費される (one-shot は **fan-out 単位**)
- `to` 指定時の挙動は現状維持 (その端末への配送 1 件で消費)
- 単一端末指定の必須化は不採用。全端末 drop は「全端末がイベントを取りこぼす」stress シナリオとして有用で、既存 API も維持できるため
- 実装方針: fan-out ごとに単調増加の `deliveryId` を採番し、`OneShotFault.consumed` を `consumedDeliveryId: number | null` へ置換。null なら採用、同一 deliveryId なら同じ fan-out として適用継続、異なれば消費済み

## 完了条件

- [x] `to` 省略の drop / duplicate が全 subscriber に適用され、次のメッセージには適用されない (one-shot) テストが green
- [x] `to` 指定時の既存挙動が不変 (既存テスト全 pass)
- [x] `npm run fix` / `npm test` pass (20 files / 152 tests)
