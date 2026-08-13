# TASK-260813-listener-scope: listeners の local action 監視 (scope opt-in)

- Status: **Completed** (codex レビュー済み。README の role 既定値の誤誘導・ADR-0020 の host ゲート根拠の陳腐化・型テストの widening 未検証・本書 ctx 表記の矛盾、の 4 指摘を反映)
- 関連: ADR-0020 (設計の正), ADR-0017

## 目的

listeners に rule 単位の `scope?: 'synced' | 'all'` (既定 `'synced'`) を追加し、
local action (`isSyncedAction` が false) の dispatch でも発火できるようにする。
設計判断と根拠は `ADR-0020-listener-scope.md` を正とする。

## 実装指示

### 1. 型と validation (`src/core/create-synqux.ts`)

- `SynquxListener<TSynced, TAction>` を discriminated union 化する:
  - `scope?: 'synced'` (省略可): `match: (action: TAction) => boolean` /
    `effect: (action: TAction, ctx) => void | Promise<void>` (従来どおり。ctx は
    当初 `{ synced }` で、のちの追補で `SynquxListenerContext` = `{ synced, self }` へ拡張)
  - `scope: 'all'`: `match` / `effect` の action 型を `Action` に広げる
  - `id` / `mode` は両 variant 共通。JSDoc に「`'all'` は local action でも発火する。
    synqux 内部 action では発火しない。live ゲート・host ゲートは scope によらず適用」を記載
- createSynqux の既存 validation (duplicate id / invalid mode で throw) に
  「`scope` が `undefined` / `'synced'` / `'all'` 以外なら throw」を追加

### 2. 発火経路 (`src/core/create-synqux.ts`)

- `fireListenersAfterApply(root, action, isSynced)` に変更し、
  actionRequestMiddleware の `next(action)` 直後で **local action でも呼ぶ**。
  `emitAppliedResultLog` / `evaluateAutomationsAfterApply` / `persistLocalSnapshot` は
  従来どおり synced のみ (呼び出し順も現状維持: emitAppliedResultLog → listeners → automations)
- `fireListenersAfterApply` 内:
  - 早期 return: `phase !== 'live'` (従来)、
    `!isSynced && !hasAllScopeListeners` (instance 生成時に
    `listeners.some((l) => l.scope === 'all')` を precompute して毎 dispatch の
    走査コストを避ける)、
    `!isSynced && isSynquxAction(action)` (内部 action 除外、`matchers.ts` の既存 helper)
  - rule ごと: `!isSynced && rule.scope !== 'all'` なら skip。
    host ゲート・match の try/catch・effect の fire-and-forget は従来のまま scope 共通

### 3. テスト (`src/core/listeners.test.ts` に追記)

既存の test-fixtures (`GameAction` = `game/${string}` が synced、それ以外は local) を使う。
local action は `{ type: 'ui/opened' }` 等で良い (fixtures の reducer は未知 type を無視する)。

- [x] `scope: 'all'` + `everyone`: local action を dispatch した端末だけで 1 回発火し、
      他端末では発火しない。`ctx.synced` は現在の synced state
- [x] `scope: 'all'` + `host-only`: guest の local action では発火せず、host では発火する
- [x] scope 省略 (既定): local action では発火しない (回帰)
- [x] `scope: 'all'` は synced action でも発火する (matcher が対象を決める)
- [x] `scope: 'all'` でも synqux 内部 action は match に渡らない
      (matcher を `vi.fn(() => false)` にして `synqux/` prefix の type で
      呼ばれていないことを assert)
- [x] subscribe 完了前 (live でない) の local action では発火しない
- [x] standalone session でも local action で発火する (`host-only` も host 常時 true で発火)
- [x] `scope` に不正値を渡すと createSynqux が throw する

### 4. ドキュメント

- [x] `ADR-0017-listeners.md`: 末尾に Amendment 節を追記
      (「Decision 6 の『local action の反応は consumer の RTK listener に残す』は
      ADR-0020 で『dispatch を伴う反応だけが残る』に縮小された」の 2〜3 行)
- [x] `SPEC-0001-requests-sync.md` 設計ガイドライン 7 (listeners の項):
      scope 追加を反映 (local dispatch を伴う反応だけが RTK listener に残る旨へ更新)
- [x] `SPEC-0002-public-api.md`: `listeners` config の説明と `SynquxListener` 型の記載に
      scope を反映
- [x] `README.md`: 「React to applied actions (`listeners`)」節に scope の説明と
      short example を追加。`SynquxListener` の型表記載も更新

## 追補: ctx.self (ADR-0020 Amendment)

導入 consumer の local action 起点 role 昇格 listener の移設で、effect が自端末の
presence role を読む必要が判明したため、ctx を `SynquxListenerContext<TSynced>`
(`{ synced, self: Peer | null }`) へ拡張した。設計判断は ADR-0020 の Amendment を参照。

- [x] `SynquxListenerContext` 型の追加と両 variant の effect への適用、index.ts export
- [x] `fireListenersAfterApply` で `selectSelf(root)` を 1 発火点 1 回導出して共有
- [x] テスト: ctx assertion の更新 + `ctx.self` の role 読み取りテスト
- [x] docs: SPEC-0002 型表記・README・ADR-0020 Amendment

## 完了条件

- 上記チェックリスト全消化
- `npm run fix` が clean
- `npm test` が全 pass (新規テスト含む)
- commit / push は行わない (人間が判断する)
