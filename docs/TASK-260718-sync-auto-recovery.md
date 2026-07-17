# TASK: sync health — 自動回復 (iteration 2)

- Date: 2026-07-18
- Status: Complete
- 出自: `docs/BACKLOG.md`「response 欠落による seq gap の検知・自己回復」の iteration 2 (残スコープ)
- 前提知識 (必読): `docs/ADR-0003-sync-health.md`、`docs/SPEC-0001-requests-sync.md` 既知トレードオフ、BACKLOG 当該項「検討の方向性」、`src/core/health.test.ts` (特にテスト 4 の dual-host 早期適用シナリオは本タスクで再利用する)

## 目的

iteration 1 で検知できるようになった stall (response 欠落 / dual-host 早期適用) を、リロードより小さい単位で自動回復する。段階制御は **(a) requests 再購読 → (b) snapshot restore → (c) 回復不能通知**。回復不能のときだけ consumer がリロード案内に切り替える。

## 設計コンセプト

- **2 症状で効く段階が違う**ことを前提に設計する: (a) 再購読は「封筒を受け取り損ねた」欠落症状を治す。(b) restore は「敗者を先に適用して適用列が乖離した」dual-host 症状を治す ((a) では治らない — 破棄の原因が isApplied ガードのため、同じ封筒を何度受けても適用されない)
- **回復は 1 gap エピソードにつき 1 巡だけ** (a → 待機 → b → 待機 → unrecoverable)。無限 retry / reload loop を作らない。ok に戻って新たに stall した場合のみ次のエピソードが始まる
- **巻き戻り禁止**: restore は snapshot の appliedSeq が自端末の appliedSeq より大きいときだけ受理する
- transport interface は変更しない ((a) は既存 `subscribeRequests`、(b) は既存 `loadSnapshot` で成立する)

## 実装内容

### 1. health の phase 拡張 (`src/core/slice.ts`)

```ts
phase: 'ok' | 'stalled' | 'recovering' | 'unrecoverable'
```

- `stalled`: gap が `stallAfterMs` 継続 (iteration 1 と同じ)。次 tick から回復が始まる遷移状態
- `recovering`: 段階 (a) または (b) を実行し、効果を待っている
- `unrecoverable`: 1 巡しても gap が解消しない。consumer のリロード案内対象。**この phase でも heartbeat の監視は続け、遅着等で gap が自然解消したら ok へ戻す**
- 診断値 (expectedSeq / maxSeenSeq / gapSince) は ok 以外の全 phase で維持する

### 2. selector / hooks (`src/core/selectors.ts` / `src/react/index.ts` / `src/index.ts`)

- `selectIsSyncStalled` を「`phase !== 'ok'`」に再定義する (「同期が停止・回復中である」の意。進行表示用)
- `selectIsSyncUnrecoverable` (`phase === 'unrecoverable'`) と `useIsSyncUnrecoverable` を追加する (リロード案内の発火用)
- README の実例を `useIsSyncUnrecoverable` ベースへ書き換える (自動回復があるため、リロード案内は unrecoverable のときだけ)

### 3. `src/core/ordering.ts`

- `resetAddedGuard(): void` を追加 (seenAddedIds を clear するだけ)。再購読の再配送を `acceptAdded` が握りつぶす罠 (BACKLOG 検討の方向性 4) への対処。呼び出しは再購読の直前のみ

### 4. `src/core/create-synqux.ts` — 回復ステートマシン

heartbeat (iteration 1 の `healthTimer`) を拡張する。インスタンス内のローカル変数で管理する回復状態: `recoveryStage: 'none' | 'resubscribed' | 'restored'`、`stageStartedAt: number | null`、`recoveryInFlight: boolean` (async 段階の再入防止)。

- requests 購読は名前付き関数 (`const openRequestsSubscription = () => transport.subscribeRequests(...)` 相当) に括り出し、現在の unsubscribe を `let` で保持して再購読で差し替える
- heartbeat の遷移ロジック:
  1. gap 解消 (`maxSeen <= applied` または applied が進行) → 回復状態をリセットして ok へ (unrecoverable からでも戻す)
  2. gap が `stallAfterMs` 継続 && `recoveryStage === 'none'` → **(a) 再購読**: `ordering.resetAddedGuard()` → 現行購読を unsubscribe → 再購読。`recoveryStage = 'resubscribed'`、`stageStartedAt = now`、phase を `recovering` に
  3. `recoveryStage === 'resubscribed'` && gap のまま `stallAfterMs` 経過 → **(b) restore**: `recoveryInFlight` を立てて `transport.loadSnapshot(groupId)` (async)。完了時:
     - session が終了していたら何もしない
     - **await 後に再判定**: gap が自然解消済みなら restore せず ok へ (自然回復の勝ち)
     - snapshot が無い、または `snapshot.ordering.appliedSeq <= ordering.appliedSeq()` → 巻き戻り禁止により**受理しない** (restore 失敗扱い)
     - 受理する場合は subscribe 時の restore と同じ手順を**同期ブロックで**行う: `ordering.seed(envelope.ordering)` → `store.dispatch(synquxRestored({ synced: clearRestoredResult(envelope.synced) }))` → `waker.notify()` (seed と dispatch の間に await を挟まない — fork の適用と交錯させないため)
     - いずれの結果でも `recoveryStage = 'restored'`、`stageStartedAt = now`
  4. `recoveryStage === 'restored'` && gap のまま `stallAfterMs` 経過 → phase を `unrecoverable` に (以後この gap エピソードでは再購読も restore も行わない)
- unsubscribe closure は「現在の」requests 購読を解除する (再購読で差し替わっている可能性があるため let 参照を経由する)。heartbeat 停止は既存どおり
- restore で appliedSeq が跳んだ後は、seq 待機中の fork が isStale / isBeyondWindow / isApplied で自然に整理される (waker.notify で再評価を促す)。ここに追加の掃除ロジックを入れない (既存の判定に任せる)

### 5. テスト (`src/core/health.test.ts` に追加、または `src/core/recovery.test.ts` 新規)

技法は iteration 1 と同じ (memory hub + fake timers、実時間 sleep 禁止)。**シナリオが設計どおりに動かない場合は、無理に通そうとせず実際の挙動を本ファイル末尾に報告して停止すること。**

1. **欠落 → 再購読で自己回復**: health.test.ts テスト 1 と同じ欠落を作り、stall 後さらに時間を進めると (a) の再購読で欠落 envelope が再配送され、X が**二重適用なしで** (log を厳密比較) 収束し health が ok に戻る。restore (loadSnapshot) は呼ばれないこと (spy で確認)
2. **dual-host 早期適用 → restore で収束**: health.test.ts テスト 4 のシナリオを流用。再購読では治らず (b) の restore まで進み、A の synced が正史 (`['increment:10', 'increment:1']`) と ordering に収束し、health が ok に戻る
3. **回復中の重複・順序入れ替えでも高々 1 回適用**: シナリオ 1 の再購読中に `faults.duplicate` / `faults.delay` を注入しても、各 request の適用は全端末で高々 1 回 (log 厳密比較)
4. **巻き戻り禁止**: snapshot の appliedSeq が自端末以下の状況で restore が受理されないこと。simulation で構成しにくければ、受理判定を関数に切り出して直接テストしてもよい (その場合も「restore が synced を過去へ戻さない」ことを assert する)
5. **stall 端末の host 昇格による群停止と、restore による解除** (BACKLOG 必須テストの未消化分): テスト 4 の A を host に昇格させ (他端末の disconnect)、新規 request が裁定されないこと (群停止) を確認 → A の自動回復 (restore) 後に裁定・適用が再開されることを確認
6. **無限 loop なし**: restore でも治らない状況 (例: snapshot を返さない / 古い snapshot) で unrecoverable に到達し、以後 loadSnapshot が再呼び出しされない (spy 回数 1 のまま)。その後欠落 envelope を遅着させると ok に戻る
7. **回復中の unsubscribe**: (a)/(b) の途中で unsubscribe しても leak なし (timer 停止・二重購読なし・dispatch なし)

### 6. ドキュメント

- **`docs/ADR-0004-sync-auto-recovery.md` 新規**: 段階制御の採用理由 (2 症状と 2 段階の対応関係)、1 エピソード 1 巡の非 loop 方針、巻き戻り禁止、`resetAddedGuard` を選んだ理由 (受信ルーティングの dedup 順序変更案との比較)、棄却案 (transport への再取得 API 追加 / 即リロード案内のみ / 回復の無限 retry)
- **`docs/SPEC-0001-requests-sync.md`**: 既知トレードオフ「端末ローカル視界のズレは自動で戻らない」を改訂 — 自動回復 (再購読 → restore) を実装済みとし、リロードが必要なのは unrecoverable のみ、と現状に合わせる。改善ロードマップも更新
- **`docs/SPEC-0002-public-api.md`**: phase 拡張と selector / hooks 追加を反映
- **`README.md`**: リロード案内の実例を `useIsSyncUnrecoverable` へ更新し、「検知 → 自動回復 → 回復不能時のみリロード案内」の 1 文を添える
- **`CHANGELOG.md`**: Unreleased に追加
- **`docs/BACKLOG.md`**: 当該項を完了として本 TASK へのリンクに差し替える (運用ルール 2)。未消化だった必須テスト (host 昇格群停止) もテスト 5 で消化されることを確認してから消すこと

## 制約

- transport interface (`SynquxTransport`) と wire format は変更しない
- 依存パッケージを追加しない。demo は変更しない
- git commit しない (人間が判断する)
- コメントは既存作法。特に「(a) で治る症状と (b) でしか治らない症状の違い」「await 後の再判定がなぜ必要か」「1 巡で止める理由」を回復ロジックのコメントに残す

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存テスト、特に health.test.ts の 5 本を壊していない)
- [x] 上記テスト 1〜7 が deterministic に通る (動かないシナリオは報告を残して停止)
- [x] ADR-0004 / SPEC-0001 / SPEC-0002 / README / CHANGELOG / BACKLOG が更新されている

## 実施結果

- `src/core/recovery.test.ts` にシナリオ 1〜7 を追加。unsubscribe は再購読中 / restore 中を個別に検証したため 8 tests
- `npm run fix` 実行済み
- `npm test`: 17 files / 115 tests passed、oxlint / oxfmt / tsc / demo tsc passed
- 設計どおりに動かなかったシナリオなし
