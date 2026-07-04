# synqux

Redux (Redux Toolkit) アプリに「クライアントホスト型のリアルタイム端末間同期」を後付けするライブラリ。

## Overview

client の action を「host への request」に変換し、host が reducer の試し実行で成否判定、全端末が host の決めた順序で action を適用することで同期を成立させる。協力型・ターン制の少人数マルチプレイ向け。

- **普通の RTK の書き方がそのまま同期される**: 独自ラッパーで reducer を包まない。楽観更新をしないため「画面に出る state = 同期済み state」が常に成立する
- **reducer が唯一の判定器**: validation は reducer に集約し、host / client / 同期なし (standalone) でロジックが分岐しない
- **transport 抽象**: core は特定インフラに依存しない。Firebase RTDB adapter (`synqux/firebase`) と決定的な in-memory 実装 (`synqux/testing`) を同梱
- 仕様の正: [SPEC-requests-sync](./docs/SPEC-requests-sync.md) (仕組み・不変条件・既知の問題) / [SPEC-public-api](./docs/SPEC-public-api.md) (API 境界) / [ADR-0001](./docs/ADR-0001-design.md) (設計判断)

## Getting Started

```sh
npm install synqux @reduxjs/toolkit
```

セットアップ層 (テンプレに 1 ファイル、feature 開発者は触らない):

```ts
import { configureStore } from '@reduxjs/toolkit'
import { createSynqux, createSynquxRootReducer } from 'synqux'
import { gameReducer } from './game/reducers'   // 同期対象 (SynquxSynced を満たす)
import { scenesReducer } from './scenes/reducers' // 端末ローカル

import { firebaseTransport } from 'synqux/firebase'

export const sync = createSynqux({
  transport: firebaseTransport(db),             // 匿名認証等の auth は transport 生成前に済ませる
  isSyncedAction: (a): a is GameAction => a.type.startsWith('game/'),
  // rootReducer と selectSynced が返るので、そのまま config へ spread する
  ...createSynquxRootReducer({
    synced: { game: gameReducer },
    locals: { scenes: scenesReducer },          // 宣言順に直列実行、meta.root で前段を読める
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

## Basic Usage — ゲーム開発者が覚えること 3 つ

1. **同期 state は直接触るな、action を dispatch しろ** — request 化は自動で起きる。書き方は普通の Redux と同じ
2. **validation は reducer で、ダメなら `stateWithError` を返せ**

    ```ts
    if (state.phase !== 'battle') {
      return stateWithError(state, action, { message: 'いまは実行できません' })
    }
    ```

3. **host か・誰がいるか・結果通知は selector / hooks で読め** — `selectIsHost` / `selectPeers` / `selectSelfId`、react なら `synqux/react` の `useIsHost` / `usePeers` / `useLatestResult`。判定結果は自分の synced state (`state.game.result`) を直接読んでもよい

## Testing (`synqux/testing`)

- `createMemoryHub()` — 複数仮想端末で共有する決定的 in-memory transport。重複配送・遅延・順序入れ替え・ドロップ・切断の fault injection つき。同期挙動の simulation test はこれを第一級とする
- `verifyActionIdempotency()` / `assertActionIdempotency()` — action を二重適用して非冪等 (toggle 系) を CI で検出する

## Trouble Shooting

同期不具合の調査手順・action 設計ガイドライン (「toggle ではなく set」等) は [SPEC-requests-sync](./docs/SPEC-requests-sync.md) を参照。

## Publishing (maintainer 向け)

publish は手動で行う。`prepublishOnly` が test + build を強制するので、緑でない状態では公開できない。

```sh
# 1. CHANGELOG.md の Unreleased を新バージョンの節に整理してコミット
# 2. バージョンを上げる (src/index.ts の SYNQUX_VERSION も version script が自動同期する)
npm version minor   # または patch / major。semver 厳守 (ADR-0001 Decision 6)
# 3. commit と tag を push
git push --follow-tags
# 4. 公開 (prepublishOnly で test + build が走る)
npm publish --access public
```

- 消費者の運用は「テンプレは `^latest` 追従、出荷済みゲーム repo は exact pin」。breaking change (wire format の schema version 変更を含む) は必ず major
- 公開前の中身確認は `npm pack --dry-run`

## My Recommendation

- 同期対象の action は「現在値に依存しない」形にする (`toggle` ではなく `set({ value })`)。`assertActionIdempotency` を CI に入れて機械的に守る
- 1 度しか発火しない自動 dispatch (タイマー等) を作らない。取りこぼし前提の基盤のため、state 監視 + retry かユーザ操作起点にする
