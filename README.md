synqux
===

Redux (Redux Toolkit) アプリに「クライアントホスト型のリアルタイム端末間同期」を後付けするライブラリ。client の action を「host への request」に変換し、host が reducer の試し実行で成否判定、全端末が host の採番した順序で action を適用することで同期を成立させる。協力型・ターン制の少人数マルチプレイ向け。

- **普通の RTK の書き方がそのまま同期される**: 独自ラッパーで reducer を包まない。楽観更新をしないため「画面に出る state = 同期済み state」が常に成立する
- **reducer が唯一の判定器**: validation は reducer に集約し、host / client / 同期なし (standalone) でロジックが分岐しない
- **transport 抽象**: core は特定インフラに依存しない。Firebase RTDB adapter (`synqux/firebase`) と決定的な in-memory 実装 (`synqux/testing`) を同梱

# Structure

```
.
├ src/
│ ├ core/       … transport 非依存の同期ステートマシン (main entry)
│ ├ firebase/   … Firebase RTDB adapter (synqux/firebase)
│ ├ react/      … 読み取り hooks (synqux/react)
│ └ testing/    … in-memory transport / 冪等性ハーネス (synqux/testing)
├ demo/         … firebase emulator での手動同期確認 (npm 配布・CI 対象外)
├ docs/         … 仕様と意思決定の記録 (SPEC / ADR / TASK)
└ mise.toml     … Toolchain (node pin, git hooks)
```

- 仕様の正: [SPEC-0001-requests-sync](./docs/SPEC-0001-requests-sync.md) (仕組み・不変条件・既知の問題)
- API 境界: [SPEC-0002-public-api](./docs/SPEC-0002-public-api.md) / 設計判断: [ADR-0001](./docs/ADR-0001-design.md), [ADR-0002](./docs/ADR-0002-host-seq.md)

# Depends

- node 20+ (開発は mise で 24 系を pin)
- peerDependencies: `@reduxjs/toolkit` ^2 / optional: `react` 18+, `react-redux` 9+ (synqux/react 利用時), `firebase` 9+ (synqux/firebase 利用時)
- demo の emulator 実行のみ Java が必要

# Usage

```sh
npm install synqux @reduxjs/toolkit
```

セットアップ層 (テンプレに 1 ファイル、feature 開発者は触らない):

```ts
import { configureStore } from '@reduxjs/toolkit'
import { createSynqux, createSynquxRootReducer } from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import { gameReducer } from './game/reducers'     // 同期対象 (SynquxSynced を満たす)
import { scenesReducer } from './scenes/reducers' // 端末ローカル

export const sync = createSynqux({
  transport: firebaseTransport(db),               // 匿名認証等の auth は transport 生成前に済ませる
  isSyncedAction: (a): a is GameAction => a.type.startsWith('game/'),
  // rootReducer と selectSynced が返るので、そのまま config へ spread する
  ...createSynquxRootReducer({
    synced: { game: gameReducer },
    locals: { scenes: scenesReducer },            // 宣言順に直列実行、meta.root で前段を読める
  }),
})

export const store = configureStore({
  reducer: sync.rootReducer,
  middleware: (gdm) =>
    gdm({
      serializableCheck: { ignoredActionPaths: ['meta.root'] }, // 必須
    }).prepend(...sync.middlewares),
})

// 起動時 (standalone でも呼ぶ。restore がここで走る)
await sync.subscribe({ store, groupId })
```

ゲーム開発者が覚えること 3 つ:

1. **同期 state は直接触るな、action を dispatch しろ** — request 化は自動で起きる。書き方は普通の Redux と同じ
2. **validation は reducer で、ダメなら `stateWithError` を返せ**

    ```ts
    if (state.phase !== 'battle') {
      return stateWithError(state, action, { message: 'いまは実行できません' })
    }
    ```

3. **host か・誰がいるかは selector / hooks で読め** — `selectIsHost` / `selectPeers` / `selectSelfId`、react なら `synqux/react` の `useIsHost` / `usePeers` / `useLatestResult`。判定結果は自分の synced state (`state.game.result`) を直接読んでもよい

consumer のテストは `synqux/testing` を使う。`createMemoryHub()` (fault injection つき決定的 in-memory transport) と `assertActionIdempotency()` (非冪等 action の CI 検出) を提供する。action 設計ガイドライン (「toggle ではなく set」等) と同期不具合の調査手順は [SPEC-0001](./docs/SPEC-0001-requests-sync.md) を参照。

# Development

## Getting Started

```sh
mise install     # node の pin
mise trust
mise run provision  # git hooks 生成 + npm ci

# demo (firebase emulator で同期確認、詳細は demo/README.md)
npm run demo:emulator  # terminal 1: RTDB emulator (Java 必須)
npm run demo           # terminal 2: http://localhost:5173 を複数タブで
```

## Commands

```sh
npm ci             # install packages
npm run fix        # fix lint, format
npm run check      # check lint, format
npm test           # type check & test (vitest / oxlint / oxfmt / tsc)
npm run dev:test   # vitest watch
npm run build      # dist へ d.ts 込みでビルド
```

# Publishment

publish は人間が判断して手動で行う (Agent は実行しない)。`prepublishOnly` が test + build を強制するので、緑でない状態では公開できない。

```sh
# 1. CHANGELOG.md の Unreleased を新バージョンの節に整理してコミット
# 2. バージョンを上げる (src/index.ts の SYNQUX_VERSION も version script が自動同期する)
npm version minor   # または patch / major。semver 厳守 (ADR-0001 Decision 6)
# 3. commit と tag を push
git push --follow-tags
# 4. 公開前の中身確認 (dist + README + CHANGELOG のみであること)
npm pack --dry-run
# 5. 公開 (prepublishOnly で test + build が走る)
npm publish --access public
```

- 消費者の運用は「テンプレは `^latest` 追従、出荷済みゲーム repo は exact pin」。breaking change (wire format の schema version 変更を含む) は必ず major
- wire format (schema version) を変えるデプロイは「進行中セッションがない時間帯」に行う運用で新旧混在を吸収する

## Resources

- [GitHub](https://github.com/yano3nora/synqux) / [npm](https://www.npmjs.com/package/synqux)
- [Redux Toolkit](https://redux-toolkit.js.org/) / [Firebase Realtime Database](https://firebase.google.com/docs/database)
