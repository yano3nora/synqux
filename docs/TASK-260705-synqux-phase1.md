# synqux Phase 1: 公開 API 境界の確定と core の移植・インスタンス化

- Status: **完了 (2026-07-05)**
- 根拠: `ADR-0001-design.md` Decision 3 / 7 / 8 / 10 / 11。API 境界の正は `SPEC-public-api.md`
- 合格基準: Phase 0 characterization test の新 API 移植が通ること + `npm test` 全 pass

## 進行順序とマイルストーン

依存関係: **A (型合意) → B (テスト基盤) → C1〜C4 (移植) → C5 (characterization) → C6 (バグ修正) → C7 (migration 境界) → D → E**。「忠実移植を C5 で固定してから C6 で直す」順序が Phase 0 の投資を活かす要点だった。

### A: 公開 API 境界の確定 → `SPEC-public-api.md`

- A1 型シグネチャ / A2 transport interface (firebase セマンティクスで机上検証、対応表を SPEC に記載) / A3 封筒 wire format (schemaVersion 含む)
- 実装契約の正: `src/core/types.ts` (adapter 実装者向けの 6 契約を doc comment に焼き込み)
- **レビュー決定 (2026-07-05)**:
    1. `agent`/`guest` → 排他 enum `role: 'player' | 'dedicated' | 'observer'` (+ `label`)。dedicated = 常駐プロセスを強制 host にする用途
    2. `selectLatestResult` 廃止 — result は consumer の synced state 直読み (`s.game.result`)。react の `useLatestResult` のみ提供
    3. standalone の local 永続化をライブラリ責務に内包 — `SnapshotStore` 契約を transport と共有、`localSnapshots` config + `localStorageSnapshotStore` 同梱
    4. `@yano3nora/ts-utils` は内製化せず dependencies に含める (publish 前提: public + ライセンス整合)

### B: テスト基盤 → `src/testing/memory-hub.ts`

- `createMemoryHub()`: 複数仮想端末が共有する決定的 in-memory バックエンド。FIFO + setTimeout(0) 配送、fault injection 5 種 (duplicate / delay→release / drop / **holdAck** / disconnect)。holdAck (ack だけ保留、local echo は先行) が①の再現に必須
- **codex exec へ委譲した唯一のタスク**。指示書: `TASK-260705-phase1-b1-memory-hub.md`。レビュー修正 2 点: oxfmt 除外 workaround の revert / `respondRequest` の `result: null` を RTDB update 同様「キー除去」へ (dual-host 境界で実インフラと乖離しないため)
- **計画変更**: B2 (simulation ハーネス) は createSynqux 依存のため C へ統合 → 最終的に専用ハーネスは**公開しない**と決定 (memory hub + 自前 store 構築で成立。実例は `create-synqux.test.ts` / `host-migration.test.ts`)

### C: core の移植・インスタンス化 → `src/core/`

| ファイル | 内容 |
| --- | --- |
| `ordering.ts` | 順序判定の隔離 (Decision 10 保険 1)。prev チェーン / revisions / acceptAdded (重複配送ガード) / processing ガード。Phase 3 の seq 化はこのモジュール差し替えで行う |
| `host.ts` | host 導出純粋関数。**意図的な移植元からの変更**: 同時刻接続の tiebreak (id 辞書順) を追加 — 列挙順依存で端末間の結論が割れ得たため |
| `slice.ts` | `state.synqux` 内部 slice (モジュール変数の全廃、Decision 3)。`synquxRestored` action で synced 全量差し替え |
| `create-synqux.ts` | 4 middleware (metaSetter → 2 listener → actionRequest) + 受信ルーティング + subscribe/restore。移植元で firebase 層にあった at-least-once 対応 3 点 (prevKey 重複破棄 / responsedBy 付き added の振り分け / 先頭 prev 補完) を core へ移設 |
| `snapshot.ts` | canonical JSON 封筒 (key 辞書順) + schemaVersion 検証 (不一致は明示的拒否、Decision 10/11) |
| `characterization.test.ts` | Phase 0 の 16 シナリオを新 API へ移植 (C5) |
| `host-migration.test.ts` | dual-host 窓 / 未応答 request 引き継ぎ / host 不在滞留 → dedicated 昇格 (C7、Decision 4 の必須カバレッジ) |

- **C6 既知の問題の修正** (再現テストが落ちることを確認してから修正):
    - ①: snapshot へ載せる revisions を respondRequest の ack await **前**に評価固定
    - ①′: `ordering.beginProcessing` を dispatch 直前 (同期的) に立て finally で解放。prev 待機 loop 内で立てるの禁止 (fork 死で誰も処理できなくなる)
    - ②: 再現テスト + 明文化のみ (根治は Phase 3)

### D: consumer 層 API → `src/core/root-reducer.ts` ほか

- `createSynquxRootReducer`: 「synqux 内部 → synced (**meta.root なし**) → locals (宣言順・meta.root 付き)」の直列実行 (Decision 8)。返り値を createSynqux config へ spread。root 引き渡しは `withRootMeta` に隔離 (将来の ctx 引数方式への移行余地)。synced slice は v1 で 1 エントリ限定
- `results.ts`: generateResult / stateWithResult / stateWithError (Phase 0 characterization を移植して固定)
- `src/react/index.ts`: SynquxProvider + useIsHost / usePeers / useSelfId / useLatestResult。react / react-redux は optional peerDependencies
- 決定性検出網 `devDeterminismCheck` (Decision 8 残余クラス): host 試し実行と実適用後の canonical JSON 比較で非決定 reducer を dev 検出

### E: testing 公開 + パッケージ体裁 + docs

- `verifyActionIdempotency` / `assertActionIdempotency` (SPEC 改善ロードマップ 1 の実装)
- subpath exports (`synqux` / `synqux/react` / `synqux/testing`)、`tsconfig.build.json` で d.ts ビルド。**publish (private 解除) は Phase 2**
- `Synqux` instance に `rootReducer` を追加 (spread 方式だと configureStore へ渡す rootReducer が手元に残らないため)
- SPEC-requests-sync.md のコード参照を synqux 実体へ張り替え、①①′を対策済み表へ移動。README / CHANGELOG 整備

## スコープ外 (経緯つき)

- `synqux/firebase` adapter → Phase 2 (A2 の机上検証まで実施済み)
- `reproduce` ツール / `LAST_RESET` (リセット検知 reload) → UI 密結合のため除外、Phase 2 で要否確定
- `connections.isNotFoundGame` / query 読み取り / toast 表示 → consumer 責務

## コミット列

`1c927e6` A → `fd73bb8` B → `eb5b625` C1-C4 → `4754333` C5-C7 → `d4fc1bf` D → `bf35729` E
