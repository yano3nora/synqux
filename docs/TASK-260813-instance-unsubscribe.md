# TASK-260813: instance-level unsubscribe の追加

- Status: **Completed**
- 設計の正: `docs/ADR-0019-instance-unsubscribe.md`
- 発端: ADR-0018 の tutorial パターン (unsubscribe → subscribe) が、返り値 closure の持ち回りを consumer に強いる。react hook (`useSynquxSubscription`) は closure を破棄するため、hook 経由では unsubscribe 手段が存在しない

## 作業内容

### 1. 公開 API (`src/core/create-synqux.ts`)

- `Synqux` 型へ `unsubscribe: () => Promise<void>` を追加し、instance の返り値に実装を含める。契約は ADR-0019 の通り:
    - session が無く `subscribing` でもない → no-op で resolve (冪等)
    - `subscribing` 中 → `throw new Error(...)`。メッセージは「初期化中の中断は subscribe options の signal で行う」旨を含める
    - session あり → 現在の session の teardown を実行し完了まで待つ
- `subscribe()` の返り値 closure (`Promise<() => Promise<void>>`) は現状のシグネチャのまま維持する

### 2. teardown の single-flight 化 (`src/core/create-synqux.ts`)

- session 単位の teardown を single-flight にし、instance の `unsubscribe()` と返り値 closure が同一 Promise を共有するようにする
    - 例: `initializeSubscription` 内で session-scoped に `let teardownPromise: Promise<void> | null` を持ち、`teardownPromise ??= runSubscribeCleanups(cleanups, true)` で開始する。check-then-act の間に await を挟まないこと (AGENTS.md)
    - teardown 関数は session object (または instance closure の current-session 参照) に載せ、`unsubscribe()` はそれを呼ぶ
- これにより「破棄済み session の closure を後から呼ぶと cleanup が二重実行される」現状の latent bug も塞がる。新しい session が生きている状態で古い closure を呼んでも、新 session に一切作用しないこと
- teardown が cleanup 失敗で reject するケースの契約は現状維持 (`runSubscribeCleanups` は失敗しても全 cleanup を続行し、最初の失敗を rethrow)。single-flight の共有 Promise 経由で全呼び出し元が同じ結果を見る

### 3. テスト (`src/core/instance-unsubscribe.test.ts` 新規)

in-memory transport による決定的 simulation test で以下を green にする:

1. subscribe → `synqux.unsubscribe()` で、返り値 closure と同等の teardown が走る (presence 解除・requests 購読停止・phase が idle へ)
2. 未 subscribe で `unsubscribe()` → no-op で resolve する (throw しない)
3. subscribe の初期化 in-flight 中に `unsubscribe()` → throw する
4. `unsubscribe()` の並行 2 回呼び出し → teardown は 1 回だけ実行され、両方 resolve する
5. 返り値 closure で teardown 済みの session に対し、closure をもう一度呼んでも no-op。さらに再 subscribe で新 session を張った後に古い closure を呼んでも、新 session は無傷 (transport 購読・presence が生きている)
6. tutorial シナリオを instance method だけで完走する: `subscribe` (synced) → `synqux.unsubscribe()` → `subscribe({ mode: 'standalone', localSnapshots: false })` → local 分岐 → `synqux.unsubscribe()` → `subscribe` (synced) で正史復帰
- 既存 `src/core/session-mode.test.ts` の tutorial シナリオ test は閉包返り値を使ったまま残す (互換の回帰テストを兼ねる)。重複が気になっても消さないこと

### 4. ドキュメント

- `SPEC-0002`: `Synqux` 型定義へ `unsubscribe` を追記し、契約 (未 subscribe no-op / subscribing throw / closure との single-flight 共有) を 1〜2 行で記載
- `SPEC-0001`: 「tutorial (local 分岐 session)」節の `unsubscribe()` 記述を instance method 前提へ更新
- `README`: 「Run a local tutorial session」の例を `let unsubscribe` 再代入パターンから `synqux.unsubscribe()` へ書き換え。API 一覧に unsubscribe を追記
- 各所から `docs/ADR-0019-instance-unsubscribe.md` を参照させる

### 5. 仕上げ

- `npm run fix` / `npm test` を実行し green にする
- release は行わない (additive minor 0.10.0 想定。人間判断で実施)
- git commit / push も行わない

### 6. review followup (codex review 指摘対応、ADR-0019 Decision 6)

review で High 1 件が確定した: 逆順 cleanup の途中で `endSubscriptionSession` が `session = null` にした後も `sessionEnded` dispatch・`unsubscribePeers`・`transport.disconnect()`・phase idle 化が await 付きで続くため、「session は null だが teardown 進行中」の窓が存在する。この窓で `unsubscribe()` は即時 resolve で嘘をつき、`subscribe()` はガードをすり抜けて新 session を張り、旧 teardown の `disconnect()` / phase idle 化が新 session を破壊し得る。

実装修正 (`src/core/create-synqux.ts`):

- instance closure に `let teardownInFlight: Promise<void> | null = null` を追加。`createSubscriptionSession` の teardown 開始時 (teardownPromise 確定と同期的に) set し、settle 時に identity guard (`teardownInFlight === 自分` の時のみ) で clear する。clear の購読は `.then(clear, clear)` 形で行い unhandled rejection を作らない
- `unsubscribe()`: `session?.teardown() ?? teardownInFlight ?? Promise.resolve()`
- `subscribe()`: ガードを `session || subscribing || teardownInFlight` に拡張。teardown 進行中は「unsubscribe の完了を await してから subscribe する」旨の専用メッセージで throw する

テスト追加 (`src/core/instance-unsubscribe.test.ts`)。transport の遅延は公開 API を増やさず、test-local で transport を wrap して `disconnect()` を手動 resolve の pending Promise にする方式にする:

7. teardown 進行中 (disconnect pending で session null 化後) の `unsubscribe()` は即時 resolve せず、元の teardown と同時に完了する (同一 Promise の共有)
8. 同じ窓での `subscribe()` は throw し、新 session は開始されない (transport の connect が呼ばれないこと)
9. 返り値 closure と `unsubscribe()` を同一同期ターンで同時に呼んでも teardown は 1 回だけ実行される
10. cleanup の 1 つが throw しても残りの cleanup (disconnect まで) が実行され、closure / instance の両呼び出し元が同じ reject を受け取り、session は終了状態 (再 subscribe 可能) になる

ドキュメント修正 (review Medium / Low):

- `SPEC-0002`: unsubscribe 契約へ「unsubscribing 中の subscribe は throw」を追記
- `SPEC-0001` tutorial 節と `README` tutorial 節: 「standalone session は snapshot を read/write しない」の一般化を修正。standalone は transport の snapshot (正史) には触れないが、localSnapshots は既定で読み書きする。read/write しないのは「`localSnapshots: false` を指定したこの tutorial session」であることが分かる文言に限定する

仕上げは「### 5. 仕上げ」と同じ (`npm run fix` / `npm test` green、commit / release はしない)。

## 完了条件

- [x] `Synqux` 型に `unsubscribe(): Promise<void>` があり、契約 (未 subscribe no-op / subscribing throw / session teardown) が実装されている
- [x] 上記テスト 1〜6 が green で、既存テスト全量も green (`npm test`)
- [x] `npm run fix` 適用済みで diff が clean (lint / format エラーなし)
- [x] SPEC-0001 / SPEC-0002 / README が新 API と一致し、README の tutorial 例に consumer 側 mutable closure 変数が残っていない
- [x] teardown 進行中の `unsubscribe()` が in-flight teardown と同じ Promise を返し、`subscribe()` は throw する (テスト 7・8)
- [x] closure / instance 同時呼び出しと cleanup 失敗時の single-flight 契約がテストで検証されている (テスト 9・10)
- [x] SPEC-0001 / README の standalone snapshot 記述が「transport snapshot は触れない / localSnapshots は既定 on・`false` で off」を区別している
