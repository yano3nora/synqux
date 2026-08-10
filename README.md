synqux
===

Redux (Redux Toolkit) アプリに「クライアントホスト型のリアルタイム端末間同期」を後付けするライブラリ。client の action を「host への request」に変換し、host が reducer の試し実行で成否判定、全端末が host の採番した順序で action を適用することで同期を成立させる。協力型・ターン制の少人数マルチプレイ向け。

- **普通の RTK の書き方がそのまま同期される**: 独自ラッパーで reducer を包まない。楽観更新をしないため「画面に出る state = 同期済み state」が常に成立する
- **reducer が唯一の判定器**: validation は reducer に集約し、host / client / 同期なし (standalone) でロジックが分岐しない
- **transport 抽象**: core は特定インフラに依存しない。Firebase RTDB adapter (`synqux/firebase`) と決定的な in-memory 実装 (`synqux/testing`) を同梱
- **停止の検知と自己修復**: 配送欠落などで適用が止まった端末を sync health が検知し、再購読 → snapshot restore の段階回復で自動復帰する。回復不能時だけ consumer にリロード案内を委ねる。requests は適用窓の外が自動 prune され無限成長しない

## Structure
```
.
├ src/
│ ├ core/       … transport 非依存の同期ステートマシン (main entry)
│ ├ firebase/   … Firebase RTDB adapter (synqux/firebase)
│ ├ react/      … 読み取り hooks (synqux/react)
│ └ testing/    … in-memory transport / 冪等性ハーネス (synqux/testing)
├ demo/         … firebase emulator での手動同期確認 (npm 配布対象外。型検査のみ npm test に含む)
├ docs/         … 仕様と意思決定の記録 (SPEC / ADR / TASK)
└ mise.toml     … Toolchain (node pin, git hooks)
```

- 仕様の正: [SPEC-0001-requests-sync](./docs/SPEC-0001-requests-sync.md) (仕組み・不変条件・既知の問題)
- API 境界: [SPEC-0002-public-api](./docs/SPEC-0002-public-api.md)
- 設計判断: [ADR-0001](./docs/ADR-0001-design.md) (全体設計) / [ADR-0002](./docs/ADR-0002-host-seq.md) (host 採番 seq) / [ADR-0003](./docs/ADR-0003-sync-health.md) (stall 検知) / [ADR-0004](./docs/ADR-0004-sync-auto-recovery.md) (自動回復) / [ADR-0005](./docs/ADR-0005-requests-retention.md) (retention) / [ADR-0006](./docs/ADR-0006-presence-reregistration.md) (presence 再登録) / [ADR-0007](./docs/ADR-0007-action-repeat-contract.md) (action repeat contract) / [ADR-0008](./docs/ADR-0008-result-envelope-reshape.md) (Result / wire v3) / [ADR-0009](./docs/ADR-0009-trust-model.md) (trust model) / [ADR-0010](./docs/ADR-0010-response-immutability-and-fork-survival.md) (response 凍結再送) / [ADR-0011](./docs/ADR-0011-snapshot-fencing.md) (snapshot fencing) / [ADR-0012](./docs/ADR-0012-transport-failure-and-abort.md) (失敗通知 / abort)

## Depends
- node 20+ (開発は mise で 24 系を pin)
- peerDependencies: `@reduxjs/toolkit` ^2 / optional: `react` 18+, `react-redux` 9+ (synqux/react 利用時), `firebase` 9+ (synqux/firebase 利用時)
- demo の emulator 実行のみ Java が必要

## Quick Start

> [!IMPORTANT]
> synqux は、認証・認可済みの協調的なクライアントを前提とし、改造クライアント・チート・Firebase データの直接改ざんへの耐性は提供しない。敵対クライアントを想定する場合は、判定・採番・永続化を信頼できるサーバへ置くこと。`demo/database.rules.json` は emulator 専用であり、本番へ流用しない。

動く完成形は [demo/](./demo/) (firebase emulator + 複数タブで同期を体験できる) にあり、以下は demo と同じ構成を最小手順に分解したもの。

### 1. Install

```sh
npm install synqux @reduxjs/toolkit
# firebase transport を使う場合
npm install firebase
```

### 2. 同期対象 slice を書く

普通の Redux reducer に「`result` を持つ (`SynquxSynced`)」「validation 失敗は state を変えず `stateWithError` で表現する」の 2 点を足すだけ。独自ラッパーは無い (全文: [demo/counter.ts](./demo/counter.ts))。

```ts
import { stateWithError, type SynquxSynced } from 'synqux'

export type CounterState = SynquxSynced<CounterAction> & { count: number }

export const counterReducer: Reducer<CounterState> = (
  state = { result: null, count: 0 },
  action,
) => {
  switch (action.type) {
    case 'counter/add': {
      const next = state.count + (action.payload ?? 1)

      // validation は reducer に集約する。host がこの result を見て request を
      // 拒否し、依頼元にだけ通知される
      if (next > 100 || next < 0) {
        return stateWithError({ ...state }, action, {
          message: { text: 'count は 0〜100 の範囲です' },
        })
      }

      return { ...state, result: null, count: next }
    }
    default:
      return state
  }
}
```

### 3. store を配線する

セットアップ層はテンプレに 1 ファイル。feature 開発者は触らない (全文: [demo/main.ts](./demo/main.ts))。firebase の匿名認証等は transport 生成前に済ませること。

Firebase RTDB の rules では retention query 用に `requests/$groupId` へ `".indexOn": ["seq"]` を設定することを推奨する。
Authentication と room membership に基づく read/write 認可は consumer が設計する。匿名認証を行うだけでは、別 room へのアクセスやデータ改ざんを防ぐ認可にはならない。
prune 後も全量 replay 調査を可能にするには `firebaseTransport(db, { archivePrunedRequests: true })` で削除対象を `logs/` へ退避できる。
`logs/` は無限成長するため、容量とグループ破棄時の削除は consumer 側で管理する。

```ts
import { configureStore } from '@reduxjs/toolkit'
import { createSynqux, createSynquxRootReducer } from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import { counterReducer } from './counter'        // 同期対象 (SynquxSynced を満たす)
import { scenesReducer } from './scenes/reducers'  // 端末ローカル (同期しない slice)

export const sync = createSynqux({
  transport: firebaseTransport(db),                // 匿名認証等の auth は transport 生成前に済ませる
  isSyncedAction: (a): a is CounterAction => a.type.startsWith('counter/'),
  // rootReducer と selectSynced が返るので、そのまま config へ spread する
  ...createSynquxRootReducer({
    synced: { counter: counterReducer },
    locals: { scenes: scenesReducer },             // 宣言順に直列実行、meta.root で前段を読める
  }),
})

export const store = configureStore({
  reducer: sync.rootReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: { ignoredActionPaths: ['meta.root'] }, // 必須
    }).prepend(...sync.middlewares),
})
```

NOTE: `synced` に渡せる slice は**ちょうど 1 つ** (仕様。2 つ以上は throw)。同期したいドメインが複数ある場合は 1 つの reducer に合成し、`result` を top-level に写す。実例は [demo/main.ts](./demo/main.ts) の `demoReducer` (counter と ledger を 1 slice に畳んでいる)。

### 4. 同期を開始して動作確認

```ts
// 起動時に 1 回 (standalone でも呼ぶ。snapshot restore がここで走る)
await sync.subscribe({ store, groupId: 'room-1' })

// あとは普通に dispatch するだけ。middleware が request 化 → host 裁定 →
// 全端末が同じ順序で適用、まで面倒を見る (楽観更新なし = 画面が同期済み state)
store.dispatch({ type: 'counter/add', payload: 1 })
```

同じ `groupId` を subscribe した端末 (タブ) すべてで `state.counter.count` が一致すれば成功。手元で試すなら demo が同じ構成なので、`npm run demo:emulator` + `npm run demo` で http://localhost:5173 を複数タブ開くのが早い。

### ゲーム開発者が覚えること 3 つ

1. **同期 state は直接触るな、action を dispatch しろ** — request 化は自動で起きる。書き方は普通の Redux と同じ
2. **validation は reducer で、ダメなら `stateWithError` を返せ**

    ```ts
    if (state.phase !== 'battle') {
      return stateWithError(state, action, { message: { text: 'いまは実行できません' } })
    }
    ```

3. **host か・誰がいるかは selector / hooks で読め** — `selectIsHost` / `selectPeers` / `selectSelfId`、react なら `synqux/react` の `useIsHost` / `usePeers` / `useLatestResult`。判定結果は自分の synced state (`state.game.result`) を直接読んでもよい

### 自動回復できなかった同期停止でリロードを案内する

```tsx
const unrecoverable = useIsSyncUnrecoverable() // react なしなら selectIsSyncUnrecoverable(store.getState())

useEffect(() => {
  if (
    unrecoverable &&
    window.confirm('同期が停止しました。リロードして復帰しますか?')
  ) {
    window.location.reload()
  }
}, [unrecoverable])
```

seq gap は検知後、requests 再購読 → snapshot restore で自動回復を試みる。1 巡しても戻らない `unrecoverable` のときだけリロードを案内する。`useIsSyncStalled` は回復中を含む進行表示に使える。UI 文言と通知・リロードの発火方法は consumer が決める。

consumer のテストは `synqux/testing` を使う。`createMemoryHub()` (fault injection つき決定的 in-memory transport) と、mode 宣言つきの `assertActionIdempotency()` (set 型は `'idempotent'`、execute-once 型は `'rejects-repeat'`、意図的な無限実行型は `'repeatable'` で明示除外) を提供する。action 設計ガイドラインと同期不具合の調査手順は [SPEC-0001](./docs/SPEC-0001-requests-sync.md) を参照。

### サーバ時刻で機能を組む (`action.meta.dispatched`)

「N 秒経過で解禁」「日付切替」などの時刻依存ロジックは、端末時計を読むと端末ごとに判定がズレて同期が壊れる (reducer 内の `Date.now()` は決定性違反として dev モードで検出される)。代わりに **synqux が action へ焼き込む `meta.dispatched` を読む**。同期経路では request 化の時点で transport のサーバ基準時刻 (`serverNow()`) に上書きされるため、全端末が同じ時刻で判定できる。

```ts
case 'game/harvest': {
  // dispatched はサーバ基準時刻 (ms)。全端末・host の試し実行で同一値になる
  const now = action.meta?.dispatched ?? 0

  if (now - state.plantedAt < GROW_MS) {
    return stateWithError(state, action, { message: { text: 'まだ育っていません' } })
  }
  // ...
}
```

- reducer が読んでよい meta は `requestedBy` / `dispatched` のみ (SPEC-0002)
- パフォーマンス: firebase transport の `serverNow()` は `.info/serverTimeOffset` を接続時に購読・キャッシュするため、request ごとの取得は `Date.now() + offset` の O(1)。往復は発生しない
- 注意: standalone (`enabled: false`) や `setEnabled(false)` 中の local 適用では `dispatched` は端末時計 (`Date.now()`) になる。単独端末なので判定は壊れないが、「サーバ基準」が保証されるのは同期経路のみ

### tutorial などで同期を一時的に止める (`setEnabled`)

`sync.actions.setEnabled(false)` は**送信ゲート**で、synced action を request 化せず local にのみ即時適用する (永続化もしない)。tutorial のような「本番の同期 state を汚さず、同じ reducer で local 完結に遊ぶ」用途のための機能で、受信・host 責務は止まらない。

```ts
store.dispatch(sync.actions.setEnabled(false)) // tutorial 開始 (以降 local 完結)
store.dispatch({ type: 'game/reset' })          // tutorial 用の初期化も普通の action で
// ... tutorial 進行 (dispatch はすべて local 適用) ...
```

- 前提: **同期グループに他端末がいない / 動いていない状況で使う**。グループが動いていると remote 適用が local 乖離に混ざり、自端末が host の場合は乖離した state を土台に裁定・snapshot 保存されて同期 state (正史) 自体が汚染される
- 復帰: `setEnabled(true)` に戻しても off 中の local 乖離は残るため、**tutorial 終了はリロード相当 (新しい store で `subscribe` し直す) で snapshot の正史へ戻す**のが正しい手順
- 詳細な契約は [SPEC-0001](./docs/SPEC-0001-requests-sync.md) の「setEnabled の契約」を参照

### useSelector / useDispatch の型補完

synqux 固有の仕組みは不要で、Redux 公式の [`.withTypes<>()` パターン](https://redux.js.org/usage/usage-with-typescript#define-typed-hooks)がそのまま使える。RootState は `sync.rootReducer` から導出すると synqux 内部 slice (`state.synqux`) も含めて型が合う。

```ts
// hooks.ts (setup 層に 1 回だけ)
import { useDispatch, useSelector } from 'react-redux'
import type { store, sync } from './store'

export type RootState = ReturnType<typeof sync.rootReducer>
export type AppDispatch = typeof store.dispatch

export const useAppSelector = useSelector.withTypes<RootState>()
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()

// ゲーム開発者はこちらを使う (state.counter が補完される)
const count = useAppSelector((s) => s.counter.count)
```

`synqux/react` の hooks (`useIsHost` / `useLatestResult` 等) は Provider 経由で型解決するため、この配線がなくても動く。

## Development
### Getting Started
```sh
mise install     # node の pin
mise trust
mise run provision  # git hooks 生成 + npm ci

# demo (firebase emulator で同期確認、詳細は demo/README.md)
npm run demo:emulator  # terminal 1: RTDB emulator (Java 必須)
npm run demo           # terminal 2: http://localhost:5173 を複数タブで
```

### Commands
```sh
npm ci             # install packages
npm run fix        # fix lint, format
npm run check      # check lint, format
npm test           # type check & test (vitest / oxlint / oxfmt / tsc)
npm run dev:test   # vitest watch
npm run build      # dist へ d.ts 込みでビルド
```

## Publishment
publish は人間が判断して手動で行う (Agent は実行しない)。version bump・test/build/smoke・
publish ゲートは [`scripts/release.mjs`](./scripts/release.mjs) に集約する。配布の本体は `npm publish`
(`prepublishOnly` が test + build + smoke を強制するので緑でしか出せない)、変更履歴は
`gh release create --generate-notes` が commit / PR から自動生成する GitHub Release に残す
(手書きの CHANGELOG は持たない)。version は package.json を正とし、`prepare` が package.json /
package-lock / `src/index.ts` の `SYNQUX_VERSION` を一括同期する (旧 `npm version` の inline sync は
廃止。手動で `npm version` を叩くと src が同期されず `src/index.test.ts` が落ちる)。

```sh
# 1. prepare: version 3 点同期 + test → build → smoke (publish なし)
mise run release:prepare -- 0.1.0   # semver 厳守 (ADR-0001 Decision 6)

# 2. 人間: diff を確認して bump を commit し、tag を打つ
git add .
git commit -m "release: release v0.1.0"
git tag v0.1.0

# 3. publish 前に browser 経由で npm login
npm login

# 4. publish: 整合チェック → push → npm publish → GitHub Release 作成 (人間のみ)
mise run release:publish -- 0.1.0 --i-understand-this-pushes-and-publishes
```

同一 version での `prepare` 再実行は bump が冪等なので安全。breaking (wire format schema version の
変更) を含む release は GitHub Release の notes で「協調デプロイの要否」を明記すること。

`publish` は「焼き込み version == tag」「working tree clean」「tag が HEAD を指す」を満たさないと
中断する。push は npm publish (取り消し困難) より先に行い、tag だけ remote に進んでも消して再実行できる。

- 消費者の運用は「テンプレは `^latest` 追従、出荷済みゲーム repo は exact pin」。breaking change (wire format の schema version 変更を含む) は必ず major
- wire format (schema version) を変えるデプロイは「進行中セッションがない時間帯」に行う運用で新旧混在を吸収する

### Resources
- [GitHub](https://github.com/yano3nora/synqux) / [npm](https://www.npmjs.com/package/synqux)
- [Redux Toolkit](https://redux-toolkit.js.org/) / [Firebase Realtime Database](https://firebase.google.com/docs/database)
