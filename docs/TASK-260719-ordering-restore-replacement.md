# TASK-260719: snapshot restore で ordering を完全置換し、未適用の裁定済み envelope を再評価する

> BACKLOG P0「snapshot recovery で ordering を完全置換する」の解消タスク。

## 背景 / 問題

- `ordering.seed()` (src/core/ordering.ts) が `appliedWindow` / `appliedIds` へ**加算**するだけで、正史 snapshot へ state を戻しても端末が誤適用 (dual-host 敗者の早期適用) した request id が `appliedIds` に残る
- 残留 id を持つ request の再裁定 envelope (seq > snapshot.appliedSeq) は `isApplied` で適用済み扱いされ破棄される
- さらに調査で判明: **purge だけでは不十分**。再裁定 envelope を破棄した responseListener fork は `isApplied` ガードで即 `break` して死んでおり (create-synqux.ts:680)、recovery の resubscribe (stage a) は restore (stage b) より前に走るため、restore 後にその envelope を再処理する主体がいない
- 実害: 通常は次の gap エピソードで新しい snapshot (再裁定を含む) に到達して収束するが、**stall した端末自身が host の場合は snapshot が進まず恒久 unrecoverable** になる。SPEC-0001 の「snapshot restore で正史へ戻り、群の裁定も再開する」という主張が破れている

## 設計決定

### 1. `ordering.seed()` → `ordering.restore()` へ改名し、完全置換の契約を定義

| 状態 | restore 時の扱い | 理由 |
|---|---|---|
| `appliedSeq` | snapshot 値で置換 | snapshot が正史の ground truth |
| `appliedWindow` / `appliedIds` | **clear してから snapshot の窓で再構築** | 誤適用 id の残留が本タスクのバグ本体 |
| `maxSeenEpoch` | `max(現在値, snapshot.epoch)` で単調維持 | fencing は後退させない |
| `myEpoch` | 触らない | `beginHosting` が観測最大を跨ぐので不変条件は保たれる |
| `maxIssuedSeq` | 触らない (観測高水位として維持) | restore が跨いだ自分の発行は appliedSeq 前進で自然消滅する |
| `seenAddedIds` | 触らない | added dedup は再購読 (resetAddedGuard) の責務 |
| `processing` | 触らない | 処理中ガードは await を挟まない同期区間なので、同期ブロックの restore と交差し得ない |

- 置換で失われる「snapshot 窓より古い局所窓エントリ」は `isBeyondWindow` の適用済み扱い破棄が引き受けるため安全 (受理ガードにより snapshot.appliedSeq > local applied が保証されている)

### 2. restore 受理後、未適用の裁定済み envelope を再評価する

- `restoreFromLatestSnapshot` の受理ブロック内 (`ordering.restore` + `synquxRestored` dispatch + `waker.notify()` の後) で、`synqux.requests.entities` のうち `seq` 確定済みかつ `!ordering.isApplied(id)` の entity へ `requestChanged` を再 dispatch し、fork を再生成する
- 二重 fork は既存ガード (isApplied / isProcessing / entity 消滅 / 決定的 tiebreak) が吸収する

## スコープ外 (BACKLOG へ追記済み)

- restore 受理条件 `snapshot.appliedSeq > applied` が「同値 snapshot による早期適用是正」を拒否する問題は、snapshot の信頼性 (P0 fencing) と同じ ADR で判断する

## 完了条件

- [x] ordering unit test: restore の完全置換 (残留 id の purge、epoch 単調、appliedSeq 置換) が green
- [x] simulation test: 「再裁定 seq が restore snapshot より先にある」シナリオで、restore 後に再裁定が適用され全端末が収束する (修正前は red = 再裁定が破棄され不収束を確認済み)
- [x] SPEC-0001 の restore 記述を新契約へ更新
- [x] `npm run fix` / `npm test` pass (20 files / 156 tests)
