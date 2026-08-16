# TASK-260816: ADR-0021 実装 (restore replay の非発火保証と `fire: 'persisted'`)

- 対象 ADR: `docs/ADR-0021-replay-suppression-and-persisted-fire.md` (実施決定に伴い Status を Accepted へ更新する)
- 目的: reset reload 無限ループの構造的排除。機構・棄却案の背景は ADR を正とする
- 本書は**下位エージェントへの実装指示書**。コードレベルの変更点・罠・テスト移行手順まで含む。迷ったら ADR-0021 の Decision 本文に従う

## 前提 (調査済みの現状)

- `src/core/create-synqux.ts` (~2300 行) が engine 本体。重要な現状:
  - `initializeSubscription` の synced 経路は `openRequestsSubscription()` から `changePhase(store, 'live')` まで **await なしの同期ブロック**。transport の初回一括配送 (MemoryHub は setTimeout 経由) は必ず live 遷移後に届く = ADR の「穴 3」
  - listener 発火点は `fireListenersAfterApply(root, action, isSynced)`。`actionRequestMiddleware` の `next(action)` 直後に呼ばれ、`root.synqux.phase !== 'live'` でスキップ (phase ゲート)
  - 裁定済み envelope の受信 routing は `requestHandlers.onAdded` 内の `if (request.responsedBy) { dispatch(requestChanged) }` 分岐 (ここが Decision 2 の印付け点)
  - 適用は `responseListener` の fork 内。`withDeliveryMeta(entity.action, {...})` で meta を焼いて `listener.dispatch` → `ordering.markApplied(seq, id)`
  - host 裁定 fork (`spawnHostFork`) は `respondRequest` の ack 後に `persistSnapshot(synced, orderingState)` → 成功時のみ `pruneRequests`
  - standalone は `persistLocalSnapshot(root)` が fire-and-forget で local save。**effect (listener) は save より先に同期実行される** (Decision 3 の standalone 対応点)
  - engine 起動順 (現状): `startAutomationEngine` → `startHostLivenessEngine` → `changePhase('live')`
- `src/core/ordering.ts`: `maxSeenSeq()` = 観測済み最大 seq、`appliedSeq()`、`restore()`、`beginHosting()` (myEpoch を maxSeenEpoch+1 へ)、`state()` は `{ epoch: myEpoch ?? maxSeenEpoch, appliedSeq, applied }`
- `src/testing/memory-hub.ts`: 配送は subscriber ごとの FIFO queue + `setTimeout(0)`。**自然配送では同一 child の added → changed 順が構造的に保証されている** (violate するのは faults の drop/delay のみ)
- `src/firebase/index.ts`: `subscribeRequests` は `onChildAdded`/`onChildChanged` を attach するだけ。`saveSnapshot` は `runTransaction` (applyLocally 指定なし = local echo あり)
- テスト: `vi.useFakeTimers()` + `test-fixtures.ts` の `settle()` (100ms × n advance)。**backlog がある group への `await subscribe(...)` は、barrier 導入後は settle 併走がないとデッドロックする** (下記「既存テストの移行」参照)

## 設計 (ADR からの具体化と意図的逸脱)

### 定数 (create-synqux.ts に追加)

```ts
/** Decision 1: 初回 backlog 配送完了待ちの上限。onReady を呼ばない旧 adapter の縮退線 */
const INITIAL_BACKLOG_TIMEOUT_MS = 10_000
/** Decision 3: persisted watermark 未達 effect の warn + drop までの上限 */
const PERSISTED_FIRE_TIMEOUT_MS = 30_000
/** Decision 4: checkpoint 保存失敗の backoff retry (有限回で諦める) */
const CHECKPOINT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
```

### Decision 1: 初回購読 barrier

- transport 契約: `subscribeRequests` の handlers に `onReady?(): void` を追加 (optional・契約 12 として types.ts の契約コメントに追記)。「初回一括配送 (と changed buffer の flush) 完了後、1 購読につき高々 1 回。unsubscribe 後は発火しない。get 失敗は onError へ」
- core (`initializeSubscription` synced 経路):
  - `requestHandlers` に `onReady` を実装: 初回購読の onReady だけを消費 (closure flag)。`ready = true; readyTargetSeq = ordering.maxSeenSeq(); waker.notify()`
  - 購読開始〜live の間に barrier 待機を挿入:
    ```ts
    const deadline = Date.now() + INITIAL_BACKLOG_TIMEOUT_MS
    while (!(ready && ordering.appliedSeq() >= readyTargetSeq)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break // 縮退: live へ進み health / recovery に委ねる
      await waker.wait(Math.min(remaining, WAKE_FALLBACK_MS))
      signal?.throwIfAborted()
    }
    ```
    ※ループ条件を wait より**先**に検査すること (backlog 空 + 同期 onReady のとき await ゼロで通過 = fake timers の既存テストを壊さない)
  - 順序変更: barrier → `barrierPassed = true` → `changePhase('live')` → `startAutomationEngine` → `startHostLivenessEngine` → checkpoint 評価 (Decision 4 (a)) → return。engine 起動を live 後ろへ移すのは ADR の指示 (catch-up 途中 state での automation 発行防止)
  - recovery の再購読 (`openRequestsSubscription` 再呼び出し) では onReady を消費しない (barrier は初回のみ)
  - standalone 経路は変更なし
- `barrierPassed` は instance 変数 (Decision 4 が responseListener から参照するため session closure では不可)。session cleanup で false に戻す

### Decision 2: replay 印

- `SynquxActionMeta` に追加:
  ```ts
  /** 既裁定のまま added で届いた envelope の適用 (= restore・途中参加・再購読の再配送)。端末ローカルの配送経路判定で、封筒には書かない (ADR-0021) */
  replay?: boolean
  ```
- instance 変数 `const replayDeliveredIds = new Set<RequestEnvelope['id']>()`
  - add: `requestHandlers.onAdded` の `if (request.responsedBy)` 分岐 (requestChanged dispatch の直前)
  - delete: `requestHandlers.onChanged` 受信時 (契約 3 強化により「added より後の changed = 購読後の新裁定 (敗者再裁定)」なので live 扱いへ戻す)、および responseListener での適用完了後 (`markApplied` 後)。session cleanup で clear
- `responseListener` の dispatch 時: `replayDeliveredIds.has(id)` なら delivery meta に `replay: true` を足す (`DeliveryMeta` 型を `Required<Pick<...>> & Pick<SynquxActionMeta, 'replay'>` に拡張)
- `fireListenersAfterApply`: 冒頭の early return 条件に `(action.meta as SynquxActionMeta | undefined)?.replay === true` を追加。phase ゲートは防衛線としてそのまま残す
- 副作用に注意: `restoreFromLatestSnapshot` の requestChanged 再 dispatch は印を変更しない (印が付いていれば replay のまま、なければ live のまま。これで正しい)
- host 試し実行・envelope 直列化経路に replay が混入しないことを確認 (entity.action.meta は封筒由来なので混入しない。serializeResult は変更不要)

### 契約 3 の強化と MemoryHub (意図的逸脱)

- types.ts 契約 3 に追記: 「**同一購読内では、同一 child の added が changed より先に配送されること** (adapter が能動的に保証する。ADR-0021)」
- **MemoryHub には buffer を実装しない**: 自然配送 (subscriber FIFO) が既に契約を満たす。buffer を足すと faults の `drop`/`delay` (added 対象) が changed まで封じ、fault 注入 (契約外の敵対ケースに対する core 頑健性の検証) が無意味化するため。memory-hub.ts の doc comment にこの整理を 1 行残すこと
- buffer が必要なのは firebase adapter のみ (attach + get() で順序が本当に乱れ得る)

### Decision 3: `fire: 'persisted'`

- `SynquxListenerBase` に `fire?: 'applied' | 'persisted'` を追加 (既定 `'applied'`)。createSynqux の検証ループに不正値 throw を追加 (`Invalid SynquxListener fire: ...`)
- JSDoc に docs 契約 (Decision 5) を書く: blocking UI / navigation を含む effect は `'persisted'` 必須・rule 配列の最後・終端イベント限定。`'persisted'` でも保証されないこと (発火 ≠ 正史確定、timeout drop あり、cross-device 同時性なし)
- instance 状態:
  ```ts
  let persistedWatermark: SnapshotFence = { epoch: 0, appliedSeq: 0 }
  type PendingPersistedEffect = { fence: SnapshotFence; fire: () => void; timer: ReturnType<typeof setTimeout> }
  const pendingPersistedEffects = new Set<PendingPersistedEffect>()
  const pendingStandalonePersisted: (() => void)[] = []
  ```
  fence 比較 helper `compareFence(a, b): number` ((epoch, appliedSeq) 辞書順)。`updatePersistedWatermark(fence)` は単調 max 更新 + queue flush (`compareFence(entry.fence, watermark) <= 0` のエントリを実行・timer clear・削除)
- watermark の情報源 (3 つ。(c) は ADR 外の追加だが「load できた = 耐久化済み」の事実なので正当):
  - (a) `spawnHostFork` 内 `persistSnapshot` が true を返したら `updatePersistedWatermark({ epoch: orderingState.epoch, appliedSeq: orderingState.appliedSeq })`
  - (b) `transport.subscribeSnapshotFence?.(groupId, handler)` を initializeSubscription で購読 (存在時のみ)。cleanup へ unsubscribe を push。handler は `updatePersistedWatermark(fence)` するだけ (重複・逆順イベントは単調 max が吸収)
  - (c) subscribe 時 / `restoreFromLatestSnapshot` の loadSnapshot 成功時、`envelope.ordering` の (epoch, appliedSeq) で update
- `fireListenersAfterApply` の変更: rule ごとに match / host 判定 / ctx 捕捉は**適用直後のまま**行い、`fire === 'persisted'` の rule は effect 実行だけを遅延する:
  - synced session の synced action (meta.seq あり): fence `{ epoch: meta.epoch, appliedSeq: meta.seq }` で queue へ。enqueue 時点で watermark 既達なら即実行。timer = `setTimeout(() => { 削除 + console.warn }, PERSISTED_FIRE_TIMEOUT_MS)`
  - standalone session の synced action: `session.localSnapshots` があれば `pendingStandalonePersisted` へ push (`persistLocalSnapshot` が save 試行 settle 後に splice して実行)。なければ即実行
  - local action (scope 'all'、meta.seq なし): `'applied'` と同義で即実行
  - effect 実行 closure は既存 `fireListener` の失敗隔離 (try/catch + Promise catch) と同等にすること
- `persistLocalSnapshot`: 冒頭で `pendingStandalonePersisted.splice(0)` を capture し、save promise の settle 後 (then/catch 両方) に実行する形へ変更
- session cleanup: queue 全 entry の timer clear + clear、`pendingStandalonePersisted` clear、watermark を `{epoch: 0, appliedSeq: 0}` へ reset
- transport 契約: `subscribeSnapshotFence?(key: string, handler: (fence: SnapshotFence) => void): Unsubscribe` を optional で追加 (契約 13)。契約文言: 「fence 購読イベントは server 確定値のみを配送。購読開始時に現在値があれば配送してよい。未実装 adapter では非 host 端末の `'persisted'` は実質 timeout drop になる」

### Decision 4: checkpoint

- instance 変数 `let checkpointInFlight = false`
- 評価関数 (instance level):
  ```ts
  const maybeCheckpoint = (root: TRoot): void => {
    if (!session || session.mode !== 'synced' || !barrierPassed || checkpointInFlight) return
    if (!isSelfHost(root)) return
    const local = ordering.state()
    if (compareFence({ epoch: local.epoch, appliedSeq: local.appliedSeq }, persistedWatermark) <= 0) return
    checkpointInFlight = true
    void (async () => { try { /* 下記 */ } finally { checkpointInFlight = false } })()
  }
  ```
  - 実行本体: `ordering.beginHosting()` で hosting epoch を確立 → `ordering.state()` を取り直し → `persistSnapshot(config.selectSynced(root), state)` を retry loop (CHECKPOINT_RETRY_DELAYS_MS、`await new Promise(r => setTimeout(r, delay))`) で試行。各 await 後に `session` が同一か・自分がまだ host かを再検査して中断。true が返ったら `updatePersistedWatermark(fence)`。false (fenced-out) は「他所でより新しい保存が確定」なので即終了。prune は行わない (retention は裁定経路の責務のまま)
  - **同値 fence では保存しない** (`<= 0` ガード) — epoch インフレと無駄 write の抑止。「barrier 通過時に必ず保存」ではない点が ADR (a) の字面より狭いが、fence 同値 = 保存すべき進行が無い、として整合
- 呼び出し点:
  - (a) barrier 通過後 (live 遷移・engine 起動の後): `maybeCheckpoint(store.getState())`
  - (b) responseListener で replay 印付き envelope の `markApplied` 直後: `maybeCheckpoint(listener.getState() as TRoot)` (barrier 縮退 (timeout) 後に届く backlog にも効く)

### firebase adapter

- `subscribeRequests`:
  - per-subscription 状態: `let active = true`, `const seenAdded = new Set<string>()`, `const pendingChanged = new Map<string, RequestEnvelope[]>()`
  - `deliverAdded(envelope)`: `seenAdded.add(id)` → `handlers.onAdded(envelope)` → buffered changed を到着順に flush
  - `onChildAdded` callback → `deliverAdded`。`onChildChanged` callback → seenAdded 未達なら buffer、達なら `handlers.onChanged`
  - attach 後に同一 query を `get()` → 各 child を `seenAdded` 未達のものだけ `deliverAdded` → `handlers.onReady?.()`。get() reject は `handlers.onError?.(error)` へ (onReady は呼ばない)。`active === false` (unsubscribe 済み) なら get 結果・onReady とも配送しない
  - unsubscribe で `active = false` + 各 off
- `saveSnapshot`: `runTransaction(ref, updater, { applyLocally: false })` (楽観 local event の根絶。ADR-0011 の性能説明への注記は docs 側で)
- `subscribeSnapshotFence(key, handler)`: `onValue(ref(db, \`games/${key}/fence\`), snap => { val を epoch/appliedSeq が number の場合のみ handler へ })`。cancel callback は `console.error` (fence 購読の喪失は sync 自体を止めない。persisted rule が timeout drop に縮退するだけ)

### MemoryHub

- `subscribeRequests`: 既存 backlog の enqueue 後、`onReady` を配送する。**backlog が空なら同期呼び出し** (fake timers 下の `await subscribe` を壊さないため必須)、あれば queue 末尾に enqueue
- `subscribeSnapshotFence(key, handler)`: 購読リスト (`{ key, handler, active }[]`) を hub に持つ。購読開始時に保存済み fence があれば setTimeout(0) で配送。`saveFencedSnapshot` の成功時 (= holdSnapshot の release 経由を含む「確定」時のみ) に該当 key の購読へ setTimeout(0) で fence を配送。unsubscribe で active=false
- `inspect.snapshotFence(key): SnapshotFence | null` を追加 (checkpoint テスト用)

## 実装手順 (この順で)

1. [x] 調査 (完了。上記「前提」に記録)
2. [x] **再現テスト先行 (red 確認)**: `src/core/replay-suppression.test.ts` を作成し、現行コードで fail することを確認してから実装に入る
   ```
   シナリオ: hub に client A を subscribe → hub.faults.holdSnapshot('peer-1') で
   snapshot 永続化を殺す → A が game/increment を dispatch → settle。
   次に listeners: [everyone rule (match: game/increment)] 付きの新 client B
   (hub.createTransport()) を subscribe (backlog 再配送で追いつく)。
   期待: B の count は 1 (適用はされる) / effect は呼ばれない (replay 非発火)。
   現行コードでは live 遷移が同期のため backlog 適用が live 後になり effect が
   発火して fail する (= インシデントの機構)
   ※ barrier 導入後は subscribe が backlog 適用を待つため
     `const p = b.sync.subscribe(...); await settle(); await p` の併走形で書くこと
   ```
3. [x] types.ts (契約 3 強化 / 契約 12 onReady / 契約 13 subscribeSnapshotFence / SynquxActionMeta.replay)
4. [x] MemoryHub (onReady / subscribeSnapshotFence / inspect.snapshotFence / doc comment)
5. [x] core Decision 1 (barrier + 順序変更)
6. [x] core Decision 2 (replay 印) — ここで手順 2 のテストが green になる
7. [x] core Decision 3 (fire option / watermark / queue / standalone)
8. [x] core Decision 4 (checkpoint)
9. [x] firebase adapter (backlog get + onReady / changed buffer / applyLocally: false / subscribeSnapshotFence)
10. [x] 追加テスト (下記一覧)
11. [x] 既存テストの移行 (下記)
12. [x] docs 更新 (下記)
13. [x] `npm run fix` → `npm test` 全通過
14. [x] `codex exec` でレビュー依頼 → 指摘反映
    - [重大] live 中の host migration で checkpoint が起動しない → peerUpserted / peerRemoved で `maybeCheckpoint` を再評価するトリガーを追加 (再現テスト: checkpoint.test.ts「live 中の host 昇格でも checkpoint」)
    - [中] checkpoint の in-flight ガードが session 境界を越えて新 session をブロックし得る / await 後の session 再検査不足 → 走行中ガードを session 識別子に変更し、watermark 反映 (checkpoint / host 裁定 fork) に session 一致検査を追加 (再現テスト: 同「未解決の checkpoint 保存が残っても〜」)
    - [重大・第 2 ラウンド] 裁定 fork の session 捕捉が respondRequest の await 後で遅く、ack 待ち中の session 切替で旧裁定の保存が新 group を汚染し得る → session 捕捉を裁定土台の state 読み取りと同期化し後処理全体をゲート。合わせて checkpoint に「session 内で同期の証拠 (snapshot load / envelope 受信) を観測済み」の適格条件を追加 (再現テスト: 同「respondRequest の ack 待ち中に session が替わっても〜」)
    - [重要・第 3 ラウンド] persistSnapshot の await 中の session 切替で、旧裁定の閾値の pruneRequests が新 group を削り得る → watermark 反映と prune を保存 await 後の session 再照合の内側へ畳んだ
    - 第 4 ラウンドで LGTM (2026-08-16)

## 追加テスト一覧

- `src/core/replay-suppression.test.ts` (Decision 2):
  - 上記再現シナリオ (backlog replay で非発火 + live dispatch では発火する対照)
  - recovery 再購読の再配送でも非発火 (resubscribe で戻った既裁定 envelope)
  - **onReady を呼ばない legacy adapter で barrier が timeout 縮退しても** replay
    適用 (phase='live') で非発火 (= Decision 2 が phase 非依存の正であること)。
    transport を wrap して handlers.onReady を握りつぶす + `advanceTimersByTimeAsync(10_000)`
- `src/core/subscribe-barrier.test.ts` (Decision 1):
  - `onPhaseChanged` で live 遷移時点の state を capture し、backlog 適用済み (count 反映済み) であること
  - automation (`when: synced.count === 0` で increment を発行する rule) が catch-up 途中 state で発行されないこと (最終 count 1 / hub.inspect.requests が増えない)
  - onReady なし transport で timeout 後に live へ縮退すること
  - barrier 待機中の signal abort で subscribe が reject し rollback されること
- `src/core/persisted-fire.test.ts` (Decision 3):
  - host 端末: holdSnapshot 中は effect 保留 → release で発火 (情報源 a)
  - 非 host 端末: host の save が release されたら fence 購読経由で発火 (情報源 b)
  - `failSnapshot({ times: Infinity })` + `advanceTimersByTimeAsync(30_000)` で console.warn + 非発火 (timeout drop)
  - ctx / match の評価が適用直後に固定されること (hold 中に 2 件適用 → release 後、各 effect の ctx.synced が各適用時点の値)
  - standalone: 制御可能な SnapshotStore を注入し、save resolve 後に発火。`localSnapshots: false` では即発火
  - scope 'all' の local action + persisted は即発火
  - fire 不正値で createSynqux が throw
- `src/core/checkpoint.test.ts` (Decision 4):
  - 昇格 checkpoint: A が holdSnapshot で snapshot 未永続のまま disconnect → 新 client B subscribe → barrier 後に B が checkpoint し `hub.inspect.snapshotFence` の appliedSeq が進む (トリガー a)
  - barrier timeout 縮退後の replay 適用でも checkpoint される (トリガー b)
  - 保存失敗が retry され、`CHECKPOINT_RETRY_DELAYS_MS` 全滅で諦める (failSnapshot times 指定)
  - 非 host / barrier 前 / fence 同値では保存しない
- `src/testing/memory-hub.test.ts` 追記: onReady (backlog 後・空なら同期)、subscribeSnapshotFence (保存確定時のみ・holdSnapshot 中は配送されない・release で配送)
- `src/firebase/index.test.ts` 追記: subscribeRequests が attach → get → 手動 onAdded → onReady の順で呼ぶ / unsubscribe 後の get 結果と onReady を配送しない / changed 先行を buffer して added 後に flush / get 失敗を onError へ / saveSnapshot が `applyLocally: false` を渡す / subscribeSnapshotFence のパスと値検証

## 既存テストの移行 (barrier 導入の影響)

- **影響パターン**: 「既に requests が存在する group」へ subscribe して直接 `await` するテストは、backlog 配送 (setTimeout) を進めないと barrier で止まりデッドロック (vitest timeout) する
- **修正パターン**: `const pending = client.sync.subscribe({...}); await settle(); await pending` に書き換える (test-fixtures.ts に helper `subscribeSettled(client, options)` を追加してよい)
- 対象の当たりを付ける grep: subscribe より前に同一 group への dispatch / hub 操作があるテスト。少なくとも `listeners.test.ts` (restore replay テストの `releaseLoad(); await subscribing` 部)、`recovery.test.ts`、`retention.test.ts`、`snapshot-fencing.test.ts`、`host-migration.test.ts`、`session-mode.test.ts`、`instance-unsubscribe.test.ts`、`stress.test.ts`、`protocol-latency.test.ts`、`determinism-check.test.ts`、`transactional-subscribe.test.ts` を確認。**まず `npm test` を回し、timeout したテストを機械的に上記パターンへ直すのが速い**
- `listeners.test.ts` の「restore replay では発火しない」既存テストは phase ゲート検証として残し、Decision 2 の検証は新ファイルに書く
- `protocol-latency.test.ts` / `stress.test.ts` は subscribe 所要時間が変わる。閾値 assert があれば「barrier で backlog 適用完了を待つ仕様変更」として妥当な値へ調整してよい (コメントに ADR-0021 を引く)

## docs 更新

- `docs/ADR-0021-*.md`: Status を Accepted (2026-08-16 実施) へ。実装ノートとして「MemoryHub は自然配送が契約を満たすため buffer 非実装 (faults を殺さないため)」「checkpoint は fence 同値では保存しない」「watermark 情報源に load 済み snapshot fence を追加」を Consequences 末尾に追記
- `docs/ADR-0017-listeners.md`: Amendment 追記 — Decision 3 の「live 配信のみ発火」は「replay 印のない適用でのみ発火 (ADR-0021 Decision 2) + phase ゲートは防衛線」へ読み替え
- `docs/ADR-0011-snapshot-fencing.md`: Amendment 追記 — `applyLocally: false` により「実質 set と同等」の性能説明は購読側の可視性 (local echo なし) については成立しない
- `docs/SPEC-0001-requests-sync.md`:
  - 「前提知識 > snapshot と restore」に checkpoint 経路を追記
  - 「既知の問題 > 対策済み」表に本件 (reset reload 無限ループ) を追加: 対策 = 初回購読 barrier + replay 印 + fire: 'persisted' + checkpoint (ADR-0021)、再現テスト = replay-suppression / subscribe-barrier / persisted-fire / checkpoint
  - 設計ガイドライン 7 (listeners) に fire: 'persisted' の使い分けと「graceful でない effect は process を止めるな」契約を追記
  - Trouble Shooting に無限リロードの機構と調査手順 (snapshot fence と requests の appliedSeq 差を見る) を追記
- `docs/SPEC-0002-public-api.md`: SynquxListener の fire option / transport optional メソッド 2 点の差分を確認して追記 (公開 API 表面積の変化は fire option と transport optional 2 点のみ)
- release/version 操作はしない (人間判断)

## 完了条件

- 手順 2 の再現テストが「現行で red だったこと」を確認済みで、新実装で green
- ADR-0021 の 4 防衛線それぞれに対応するテストが存在し green
- 既存テスト全通過、`npm run fix` / `npm test` 通過
- docs 更新一式が完了し、ADR-0021 が Accepted
- codex exec レビューの指摘を反映済み (または不採用理由を本書に記録)
