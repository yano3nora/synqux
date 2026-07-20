# TASK-260720: snapshot 書き込みの fencing と restore 受理条件の緩和

> BACKLOG P0「snapshot の単調性を fencing で保証する」の解消タスク。
> 設計の正は [ADR-0011](ADR-0011-snapshot-fencing.md)。

## 実装概要

1. `saveSnapshot(key, payload, fence)` → `Promise<boolean>` へ契約変更 (types.ts)。受理条件は `(epoch, appliedSeq)` 辞書順の後退拒否 (同値は受理)
2. adapter 3 実装 (firebase = runTransaction / memory-hub / local-storage) へ条件付き書き込みを実装。保存形状は `{ fence, payload }`、旧形状の後方互換なし
3. `persistSnapshot` が `false` (fenced-out) を返したら prune をスキップ
4. `restoreFromLatestSnapshot` の受理条件を `>` から `>=` へ緩和

## テスト計画

- MemoryHub 追加 fault: `holdSnapshot(peerId)` (該当端末の saveSnapshot を保留し、release() で保留順に解放)
- [x] fence unit test (memory / local-storage): 低 epoch・同 epoch 低 seq の棄却 (`false`・保存内容不変)、同値・前進の受理 (`true`) (local-storage は既存 unit test なしのため memory-hub の契約テストを正とする)
- [x] Firebase adapter unit test (SDK mock): runTransaction による条件付き書き込み
- [x] simulation (red 必須): 旧 host の遅延 saveSnapshot が host migration 後の新 snapshot を巻き戻す → fencing で棄却され `(epoch, appliedSeq)` が単調を維持
- [x] simulation: fenced-out 時に prune が走らない
- [x] simulation (red 必須): 同 seq 分岐 (dual-host 早期適用で snapshot が進まないケース) が `>=` 受理の restore で正史へ収束する
- [x] 既存 164 tests green

## 完了条件

- [x] 上記テスト全て green (red 必須のものは red を先に確認)
- [x] SPEC-0001 (snapshot と restore / transport 契約) と CHANGELOG (breaking) を更新
- [x] ADR-0011 を Accepted へ、BACKLOG の fencing 項と restore `>` 再判断の追記を解消
- [x] `npm run fix` / `npm test` pass
