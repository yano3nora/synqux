# TASK-260813: session 固定 mode への統合 (setEnabled 廃止)

- Status: **Completed**
- 設計の正: `docs/ADR-0018-session-mode.md`
- 発端: 導入 consumer の tutorial 実装で standalone instance + `setEnabled(false)` の併用時に localSnapshots (本編セーブ) が上書き破壊されるバグ。根因は `synqux.enabled` の二義性 (ADR-0018 Context)

## 作業内容

### 1. state / slice (`src/core/slice.ts`)

- `SynquxState.enabled: boolean` を削除し `mode: 'synced' | 'standalone'` を追加 (初期値 `'synced'`)
- `sessionStarted` の payload を `{ selfId, mode }` へ変更
- `setEnabled` reducer / action を削除

### 2. 公開 API (`src/core/create-synqux.ts`)

- `CreateSynquxConfig.enabled?: boolean` → `mode?: 'synced' | 'standalone'` (既定 `'synced'`)。instance mode は subscribe 時の既定値
- `SynquxSubscribeOptions` へ追加:
    - `mode?: 'synced' | 'standalone'` — session 単位で instance 既定を上書き
    - `localSnapshots?: false` — session 単位で standalone 永続化を無効化 (`false` のみ。差し替えは instance config のまま)
- `actions.setEnabled` の export を削除

### 3. 内部 refactor (`src/core/create-synqux.ts`)

- closure の `instanceEnabled` 全参照を「session の実効 mode」参照へ置換する。対象: request 化判定 (shouldRequest)・`isSelfHost`・`persistLocalSnapshot` ガード・automations の `serverNow` 分岐・`setRole` の standalone no-op・`dispatchAndWait` の standalone 分岐・subscribe の standalone 経路分岐
- middleware は construction 時に作られるため、実行時は `state.synqux.mode` (sessionStarted で反映済み) を参照する
- session object に実効 localSnapshots (config 既定 or `false` 上書き) を保持し、`persistLocalSnapshot` はそれを使う
- `persistLocalSnapshot` のガードは「session mode が standalone かつ session の localSnapshots が有効」

### 4. selectors (`src/core/selectors.ts`)

- `selectIsHost`: `enabled === false → true` を `mode === 'standalone' → true` へ (公開挙動は全ケース不変)

### 5. テスト

- `src/core/set-enabled.test.ts` を `src/core/session-mode.test.ts` へ書き換え:
    1. standalone session (instance mode 指定) の synced action は request 化されず local 即時適用 + localSnapshots へ保存する (既存挙動の維持)
    2. `subscribe({ localSnapshots: false })` の session は localSnapshots へ保存しない (バグ再現の裏返し)
    3. synced instance で `subscribe({ mode: 'standalone' })` すると transport に触れず local 完結する (push も presence 登録も発生しない)
    4. tutorial シナリオ: synced で subscribe → unsubscribe → `subscribe({ mode: 'standalone', localSnapshots: false })` → local 分岐 → unsubscribe → subscribe (synced) で snapshot の正史へ復帰する (既存「再 subscribe による正史復帰」の置換)
    5. standalone session 中の `selectIsHost` は true
- 既存テストの `enabled: false` / `setEnabled` 利用箇所を新 API へ機械的に置換 (`local-snapshots-default.test.ts` / `slice.test.ts` ほか grep で全量拾う)
- 端末離脱 → host migration は既存テストでカバー済みのため追加しない

### 6. ドキュメント

- `SPEC-0001`: 「setEnabled の契約」節を削除し、「tutorial (local 分岐 session)」節へ差し替え: unsubscribe → subscribe パターン・遷移窓で synced action を dispatch しない責務・復帰 = subscribe の再実行 (マージは非提供)
- `SPEC-0002`: config / subscribe options / state shape (`enabled` → `mode`) / `selectIsHost` の記述更新
- `README`: tutorial How-to を unsubscribe → subscribe パターンの thunk 例へ書き換え

### 7. 仕上げ

- `npm run fix` / `npm test`
- release 0.9.0 (breaking: `setEnabled` / `config.enabled` / `SynquxState.enabled` の削除。人間判断で実施)

## 完了条件

- [x] `setEnabled` / `config.enabled` / `SynquxState.enabled` がコード・テスト・docs から消えている (`grep -rn "setEnabled\|enabled" src docs` で二義的な残骸がない)
- [x] 上記テスト 1〜5 が green で、既存テスト全量も green (`npm test`)
- [x] `subscribe({ mode: 'standalone', localSnapshots: false })` の session が localStorage の既存セーブ key に read / write いずれも行わない
- [x] SPEC-0001 / SPEC-0002 / README が新 API と一致している
