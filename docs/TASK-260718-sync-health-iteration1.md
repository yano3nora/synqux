# TASK: sync health — seq gap (stall) の検知と consumer 通知 (iteration 1)

- Date: 2026-07-18
- Status: Completed
- 出自: `docs/BACKLOG.md`「response 欠落による seq gap の検知・自己回復」の iteration 1
- 前提知識: `docs/SPEC-0001-requests-sync.md` (特に「既知トレードオフ」)、`docs/ADR-0002-host-seq.md`、BACKLOG 当該項の「検討の方向性」を必ず読むこと

## 目的

端末のローカル視界が正史から乖離して停止する 2 症状 — (a) response の永久欠落、(b) dual-host 窓で敗者を先に適用した端末の stall — を**単一の検知器**で検知し、consumer が「リロード案内」へ切り替えられる材料 (health) を公開する。

**自動回復 (再購読 / snapshot restore) は本タスクの対象外** (iteration 2)。transport interface も変更しない。

## 設計コンセプト

- 検知条件は構造的シグナル + ヒステリシス: 「観測済み最大 seq が appliedSeq を超えたまま、appliedSeq が `stallAfterMs` (既定 30s) のあいだ進まない」。封筒の在否を条件にしない (症状 (b) では封筒が entities に居座るため)
- 時刻は `Date.now()` (端末ローカル) でよい。ヒステリシスと表示にのみ使い、correctness には使わない
- 通知は event/callback API を増やさず、`state.synqux.health` に積んで既存作法 (静的 selector + `synqux/react` hook) で読ませる
- 平常時のノイズゼロ: health の dispatch は「phase 遷移時」と「stalled 中に数値が変わったとき」だけ。ok 中は一切 dispatch しない

## 実装内容

### 1. `src/core/ordering.ts`

- `maxSeenSeq(): number` を Ordering interface に追加する (既存の内部変数 `maxIssuedSeq` を返すだけの accessor。`observe()` が既に追跡している)

### 2. `src/core/slice.ts`

- `SynquxHealth` 型を追加して export:

  ```ts
  export type SynquxHealth = {
    /** 'stalled' = 適用が進まない停止を検知 (SPEC-0001 既知トレードオフの 2 症状)。回復手段はリロード */
    phase: 'ok' | 'stalled'
    /** stalled 時のみ数値が入る診断値。ok 時はすべて null */
    expectedSeq: number | null   // appliedSeq + 1
    maxSeenSeq: number | null    // 観測済み最大 seq
    gapSince: number | null      // gap 開始の端末ローカル時刻 (Date.now)
  }
  ```

- `SynquxState` に `health: SynquxHealth` を追加。初期値 `{ phase: 'ok', expectedSeq: null, maxSeenSeq: null, gapSince: null }`
- reducer `healthChanged: (state, action: PayloadAction<SynquxHealth>)` を追加 (`state.health = action.payload`)。`sessionEnded` は initialState へ戻すので既存実装のまま health もリセットされる

### 3. `src/core/create-synqux.ts` — heartbeat 検知器

- `CreateSynquxConfig` にオプション追加:

  ```ts
  /**
   * stall 判定のヒステリシス ms。「観測済み最大 seq が appliedSeq を超えたまま
   * appliedSeq がこの時間進まない」で health.phase が 'stalled' になる。
   * 一時遅配 (実測で最大 ~1 分) を誤検知しない値にすること。correctness には使わない
   */
  stallAfterMs?: number   // 既定 30_000
  ```

- subscribe() の synced 経路 (requests 購読開始後) で `setInterval` の heartbeat (間隔 1000ms、定数 `HEALTH_CHECK_INTERVAL_MS`) を開始し、unsubscribe closure で必ず `clearInterval` する。standalone 経路では起動しない
- heartbeat のロジック (instance 内のローカル変数 `gapStartedAt: number | null` と `lastAppliedSeq: number` で管理):
  1. `state.synqux.enabled === false` (runtime off) なら gap 追跡をリセットして ok 扱い
  2. `applied = ordering.appliedSeq()`、`maxSeen = ordering.maxSeenSeq()` を読む
  3. `applied` が前回 tick から進んでいたら `gapStartedAt = null` (進行中は常に健康)
  4. `maxSeen <= applied` なら `gapStartedAt = null`
  5. `maxSeen > applied` かつ `gapStartedAt === null` なら `gapStartedAt = Date.now()` (この時点ではまだ発火しない)
  6. `gapStartedAt !== null` かつ `Date.now() - gapStartedAt >= stallAfterMs` なら stalled。payload `{ phase: 'stalled', expectedSeq: applied + 1, maxSeenSeq: maxSeen, gapSince: gapStartedAt }`
  7. dispatch は現在の `state.synqux.health` と比較して**差分があるときだけ**行う (ok→ok は dispatch しない、stalled 中の数値更新は dispatch する)。stalled → 条件解消時は initialState 相当の ok payload を dispatch する

### 4. `src/core/selectors.ts` / `src/react/index.ts` / `src/index.ts`

- selector 追加 (既存と同じ静的関数の作法):
  - `selectSyncHealth(root): SynquxHealth`
  - `selectIsSyncStalled(root): boolean` (`phase === 'stalled'`。standalone / enabled=false では常に false になることが 3-1 で保証される)
- `synqux/react` に hook 追加 (既存 hook の作法に合わせる。Provider 不要な useSelector 直系):
  - `useSyncHealth(): SynquxHealth` (shallowEqual)
  - `useIsSyncStalled(): boolean`
- main entry (`src/index.ts`) から `selectSyncHealth` / `selectIsSyncStalled` / 型 `SynquxHealth` を export

### 5. テスト (deterministic simulation。memory hub + fake timers)

新規ファイル `src/core/health.test.ts` を基本とし、テスト技法 (store 構築・memory hub・fake timers の使い方) は既存の `src/core/create-synqux.test.ts` / `src/core/host-migration.test.ts` / `src/core/characterization.test.ts` に倣うこと。実時間 sleep 禁止。

1. **欠落検知**: 3 端末。端末 X への特定 response (`changed`) を `faults.drop` → 後続 request が裁定され X が後続 seq を観測 → fake timer を `stallAfterMs` 進めると **X だけ** `phase: 'stalled'` になり、expectedSeq / maxSeenSeq / gapSince が正しい。他端末は ok のまま
2. **遅配の誤検知なし**: `faults.delay` で保留し `stallAfterMs` 未満で release → health は一度も stalled にならず、全端末が収束する
3. **stalled 後の遅着で通常復帰**: stalled 発火後に欠落 response を配送 → X は二重適用なしで追いつき、health が ok に戻る
4. **dual-host 早期適用 stall の検知**: SPEC-0001 既知トレードオフに 2026-07-18 追記した机上分析 (「敗者を先に適用した端末は勝者を適用できず、再裁定 seq を適用済み扱いで破棄して stall する」) を memory hub で再現し、その端末で stalled が発火することを確認する。dual-host 窓の作り方は `host-migration.test.ts` の dual-host テストと `characterization.test.ts` の fencing テストを参考にする。**重要: このシナリオは机上分析の裏取りを兼ねる。もし記載どおりに再現しない (stall にならない・挙動が異なる) 場合は、無理に通そうとせず実際の挙動を TASK ファイル末尾に報告として書き残して停止すること** (SPEC の記述修正が必要になるため)
5. **リソース管理**: unsubscribe 後に heartbeat が止まっている (fake timer を進めても dispatch されない)。standalone (enabled=false) では heartbeat 自体が起動しない

### 6. ドキュメント

- **`docs/ADR-0003-sync-health.md` を新規作成**: 採用 (構造的 gap + ヒステリシスの検知、health による通知のみ) と棄却案 (fork 滞留数などの間接指標 / 封筒不在を条件にする案 / iteration 1 での自動回復 — acceptAdded の罠と競合テスト不足が理由 / transport event・plugin 機構) を、BACKLOG「検討の方向性」の内容を正として記録する
- **`docs/SPEC-0001-requests-sync.md`**: 既知トレードオフ「端末ローカル視界のズレは自動で戻らない」の項に「検知は health (`selectSyncHealth`) で提供済み、自動回復は BACKLOG iteration 2」と追記。改善ロードマップにも 1 行追加
- **`docs/SPEC-0002-public-api.md`**: `SynquxState` の記載に `health` を追加し、`stallAfterMs` / selector / hooks を API 一覧・subpath exports 表に反映
- **`README.md`**: 「ゲーム開発者が覚えること 3 つ」の直後に短い節を追加し、検知 → リロード案内の実例を載せる:

  ```tsx
  const stalled = useIsSyncStalled()  // react なしなら selectIsSyncStalled(store.getState())

  useEffect(() => {
    if (stalled && window.confirm('同期が停止しました。リロードして復帰しますか?')) {
      window.location.reload()
    }
  }, [stalled])
  ```

  リロード (snapshot restore) が唯一の回復経路であること、UI 文言・発火方法は consumer 責務であることを 1〜2 文で添える
- **`CHANGELOG.md`**: Unreleased に追加 (version は上げない)
- **`docs/BACKLOG.md`**: 当該項の iteration 1 相当を「→ 本 TASK で対応済み」とし、iteration 2 (自動回復: 再購読 → snapshot restore → 回復不能通知) を残スコープとして整理する。検討の方向性のうち回復系 (3〜5) は残す

## 制約

- transport interface (`SynquxTransport`) と wire format は変更しない
- 自動回復・再購読・restore は実装しない (iteration 2)
- 依存パッケージを追加しない
- demo は変更しない (stall の手動再現が困難なため、検証は simulation test に寄せる)
- git commit しない (人間が判断する)
- コメントは既存作法 (意図 + やっていること。特に「なぜ封筒の在否を条件にしないか」「なぜ Date.now でよいか」を検知器のコメントに残す)

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存テストを壊していない)
- [x] 上記テスト 1〜5 が deterministic に通る (テスト 4 も机上分析どおり再現)
- [x] ADR-0003 / SPEC-0001 / SPEC-0002 / README / CHANGELOG / BACKLOG が更新されている

## 実装結果

- テスト 4 は memory hub で再現できた。対象端末は dual-host 敗者を seq 1 で先に適用し、勝者 seq 1 を stale として待機、その後の敗者再裁定 seq 2 を request id の適用済み判定で破棄した。結果、`appliedSeq = 1` / `maxSeenSeq = 2` のまま進まず stalled が発火した
- 2026-07-18 実行: `npm run fix` 成功、`npm test` 成功 (16 files / 107 tests)
