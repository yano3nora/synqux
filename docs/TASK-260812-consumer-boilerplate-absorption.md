# TASK-260812: consumer boilerplate の library 吸収 (subscription lifecycle ほか)

- 目的: 実運用 consumer (テンプレ更新の先行導入 repo。具体名は git 管理外の CLAUDE.local.md 参照) がアプリ側で自作している「synqux の穴埋めコード」を棚卸しし、library 側へ吸収する。どの consumer も同じものを書くことになる普遍ボイラープレートと、synqux が内部で知っている情報の再実装が対象
- 背景: 導入 consumer の `ui/modules/sync-lifecycle.ts` が「library っぽいのにアプリ側にある」ことを起点に調査。同ファイル以外にも複数の穴埋めが見つかった (下記)。アプリ固有の UX 政策 (alert → reload、`dataset.connected` など) は吸収**しない**
- 決定事項は SPEC-0002 (public api) へ反映する。react 追加分は `src/react/index.ts`

## 調査サマリ (consumer 側の穴埋め一覧)

導入 consumer repo での実測。参照は同 repo のパス (具体 repo は git 管理外の CLAUDE.local.md 参照)。

| # | 穴埋め箇所 (consumer) | 内容 | 吸収候補 |
| --- | --- | --- | --- |
| 1 | `ui/modules/sync-lifecycle.ts` `subscribeSync` | subscribe の排他 mutex / 解除→再購読の順序 / timeout / `'subscribed' \| 'skipped' \| 'failed'` の結果明示化 | subscription manager |
| 2 | `ui/modules/sync-lifecycle.ts` `reloadableOnReset` | 「restore replay 中か、ライブ配信か」を module 変数で自前管理 (reset reload ループ回避) | replay/live の可視化 selector |
| 3 | `ui/hooks/use-synqux.ts` `subscribedRole` | 自端末の現在 role を module 変数で自前追跡 (setRole 多重発火の抑止) | `selectSelf` / `selectSelfRole` |
| 4 | `ui/modules/games/selectors.ts` `selectMyGameActionResult` | result の `targets` に自分が含まれるかのフィルタを手書き (`targets: []` = 全員の意味論込み) | 自分宛て result selector |
| 5 | `ui/modules/middlewares.ts` ほか 3 箇所 | `` `${action.type}`.startsWith('synqux/') `` の文字列判定で内部 action を除外 | `isSynquxAction` matcher |

demo/main.ts も #1 相当を naive に書いており (mutex なし・失敗遷移なし)、吸収後は demo も置き換えて実例とする。

## A. subscription lifecycle manager (#1)

### 設計コンセプト

- core の `subscribe` は「二重呼び出しは throw、lifecycle は consumer 任せ」の低レベル契約 (SPEC-0002) を**変えない**。その上に、どの consumer も必要とする定型制御を薄い manager として同梱する
- **初回購読専用とする** (260812 決定: group 変更 (部屋の移動) ユースケースは想定しない)。role 変更は ADR-0014 の `setRole` が担うため、再購読が正当化される契機は存在しない
- consumer 実装 (導入 consumer の `subscribeSync`) で実証済みの契約から、再購読分岐を除いて移す:
  - 排他: 実行中の呼び出しがあれば `'skipped'` (状態遷移なし)
  - 購読済み: 既に購読している場合も `'skipped'` (unsubscribe → 繋ぎ直しは行わない)
  - 結果の明示: `'subscribed' | 'skipped' | 'failed'`。`'failed'` 時に未接続のまま沈黙しない失敗遷移を consumer に義務づける (JSDoc で明記)
  - hook: `onConnecting` / `onConnected` (UI の準備状態・E2E 用フラグなどは consumer がここへ注入)
- timeout 既定値も実運用値を移す: subscribe 30s (consumer が上書き可)。再購読分岐が消えるため unsubscribe 待ちの timeout (実運用 10s) は不要になる
- 導入 consumer 側の「解除→再購読」分岐 (ADR-0014 以降の死にコード) は移行時にそのまま削除する

### 論点

- 置き場所: core (`createSubscriptionManager(sync)`) か react (`useSynquxSubscription`) か。module 変数でなく instance 内部状態に持てるため core 案が素直。react hook は core 版の薄い wrapper として両方提供でもよい

## B. restore replay / live の可視化 (#2)

### 設計コンセプト

- consumer は「subscribe 中の復帰 replay で適用された action か、購読完了後のライブ配信か」を区別できない。synqux は subscribe の進行 phase を完全に知っているのに公開していないため、導入 consumer は `reloadableOnReset` という module 変数を subscribe の前後で手動 toggle して代用している (reset action での reload が replay 再適用でループする事故の回避)
- `synqux` 予約 slice に購読 phase を持たせ、selector で公開する:
  - 案: `selectSyncPhase: 'idle' | 'subscribing' | 'live'` と、糖衣の `selectIsLive`
  - restore (`synqux/restored`) 完了までは `'subscribing'`。自動回復の再 restore 中 (ADR-0004) をどう見せるかは要検討 (回復中も `'live'` のまま health 側で表現するのが素直か)
- synced reducer からは読めない (決定性の構造保証、`meta.root` 不透過と同じ理屈)。listener middleware / UI 専用であることを JSDoc に明記
- 吸収後、導入 consumer 側は `reloadableOnReset` の module 変数と setter/getter が丸ごと消え、「live 時の reset なら reload」という政策 1 行だけが残る

## C. self peer / role selector (#3)

- `selectPeers` / `selectSelfId` はあるのに「自分の Peer」を引く selector がなく、consumer は role 追跡を module 変数で自前管理している (導入 consumer は setRole('player') 昇格の多重発火抑止に使用)
- `selectSelf: Peer | null` と糖衣の `selectSelfRole` を追加 (react 版 `useSelf` / `useSelfRole` も)
- 論点: presence 反映のラグ。setRole 直後に selector が旧 role を返す窓があるため、「昇格中」の抑止を selector だけで置き換えられるかは要検証。`setRole` 自体を冪等 (同値 no-op) にすれば consumer の抑止コードは丸ごと不要になる可能性がある (ADR-0014 の追補として検討)

## D. 自分宛て result selector (#4)

- `Result.targets` の生成と意味論 (`[]` = standalone で無条件表示、未指定は requestedBy 宛て) は core の results.ts が定義しているのに、「この result は自分宛てか」のフィルタは consumer 手書きになっている
- `selectLatestResultForSelf` を追加: `targets` が空なら表示、非空なら `selectSelfId` を含む場合のみ返す。react の `useLatestResult` にも同フィルタ版 `useMyLatestResult` を足す (既存 `useLatestResult` は生値のまま残す)
- 通知 UI そのもの (toast / 重複判定) は従来どおり consumer 責務で変えない (ADR-0008)

## E. `isSynquxAction` matcher の公開 (#5)

- `synqux/` という action type prefix は library の内部実装詳細だが、consumer は listener の除外条件などで文字列 `startsWith('synqux/')` を 3 箇所ハードコードしている (prefix 変更で無言破壊する結合)
- `isSynquxAction(action): boolean` を core から export し、prefix 文字列は非公開のままにする。matchers.ts (`createSyncedActionMatchers`) と同居が自然

## 吸収しないもの (アプリ政策として consumer に残す)

- alert → reload の失敗遷移・文言 (subscribe 失敗 / unrecoverable / reset 時)
- `document.body.dataset.connected` (E2E / puppeteer 用フラグ) — manager の `onConnecting` / `onConnected` hook から注入する側
- `prepared` (React state) などの画面準備状態
- reset action (`resetGameState`) の存在自体 — synced domain の設計は consumer 側

## 設計決定 (2026-08-12 確定)

ユーザレビューで以下を確定した。判定基準は「機能は必ず core に置き、selector で読めるものは react に薄い糖衣を足す」(既存の層分け原則)。

- **A**: core `createSubscriptionManager(sync, { timeoutMs? })` に加えて react `useSynquxSubscription` も提供する。理由は「react consumer に導入の一本道 (この書き方しかない、と分かる canonical な入口) を示す」ため。二重化の緩和策として、wrapper の options 型は core manager の subscribe options を共有し (`onFailed` 追加程度の差分)、wrapper 本体は「useEffect + result 分岐」の薄さを維持する
  - manager は初回購読専用。`unsubscribe` は公開しない (再購読ユースケースなし。低レベル API の `sync.subscribe` は従来どおり残るため脱出口はある)
  - react の StrictMode / remount による effect 二重発火は manager の 'skipped' で無害化される (wrapper の effect cleanup で unsubscribe しない)
- **B**: `SynquxState` に `phase: 'idle' | 'subscribing' | 'live'` を追加し `selectSyncPhase` / `selectIsLive` で公開。自動回復の再 restore 中 (ADR-0004) は `'live'` のまま (回復状態は health 側で表現)。standalone も同じ遷移を辿る
- **C**: `selectSelf` / `selectSelfRole` を追加。role 未指定 peer は host 導出 (host.ts) と同じく `'player'` に正規化する。**setRole は冪等化する** (state 上の自 role と正規化後同値なら transport へ書かず no-op、ADR-0014 追補)。presence 反映ラグの窓では重複 updateSelf が残るが同値書き込みで無害
- **D**: result は consumer の synced state 側にあり静的 selector にできないため、core は pure 述語 `isResultForPeer(result, peerId)` を提供し (memoized selector の入力に selfId をそのまま使える形)、react に `useMyLatestResult` を追加する
- **E**: 実測では `startsWith('synqux/')` は 2 箇所 (middlewares.ts / determinism-repro.test.ts) だった。`isSynquxAction` で置換する

## 優先順位

1. **E (matcher)** — 数行で終わり、内部詳細への結合を即座に切れる
2. **B (replay/live)** — consumer の最も壊れやすい module 変数 (toggle 忘れで reload ループが再発する) を構造的に消せる
3. **A (subscription manager)** — `sync-lifecycle.ts` ファイル自体の消滅。B とセットで入れると移行が 1 回で済む
4. **C / D (selectors)** — 独立して小さく入れられる。C は setRole 冪等化の判断 (ADR-0014 追補) を含むため単独で切ってもよい

## 完了条件

- [x] E: `isSynquxAction` export + 導入 consumer の 2 箇所を置換
- [x] B: `selectSyncPhase` / `selectIsLive` (+ react `useSyncPhase` / `useIsLive`) 追加、SPEC-0002 反映、導入 consumer の `reloadableOnReset` 削除
- [x] A: `createSubscriptionManager` (core) + `useSynquxSubscription` (react) 追加、demo を置き換え、導入 consumer の `sync-lifecycle.ts` 削除
- [x] C: `selectSelf` / `selectSelfRole` (+ react `useSelf` / `useSelfRole`) 追加、setRole 冪等化 (ADR-0014 追補)、`subscribedRole` module 変数の削除
- [x] D: `isResultForPeer` / `useMyLatestResult` 追加、導入 consumer の `selectMyGameActionResult` を置換
- [x] 残項目が出たら BACKLOG へ追記して本 TASK はクローズ (残項目なし)

## 完了記録 (2026-08-12)

- synqux 側: 実装・テスト (vitest 277 / oxlint / oxfmt / tsc 全 green)・SPEC-0002 / ADR-0014 追補 / README / demo 更新まで完了。breaking なしのため次 release は minor (0.8.0 想定)。release / publish は人間判断
- 導入 consumer 側: 全置換完了 (`sync-lifecycle.ts` 消滅、module 変数 3 種すべて撤去)。npm 未公開のためローカル build の tgz を `npm i --no-save` で一時適用しており、**正式 release 後に consumer の依存バージョン更新が必要** (consumer repo 側の TASK doc に記録済み)

## 追補 (2026-08-13): API 削減の再レビュー

- redux の `state.synqux.phase` を購読排他の正とし、重複状態を持つ `createSubscriptionManager` を廃止した。
- React の入口は `useSynquxSubscription(synqux, { groupId, role })` へ直結し、store 取得・30 秒 timeout・二重 mount 排他を内包した。
- phase 連動処理と回復不能時の失敗遷移は `onPhaseChanged` / `onUnrecoverable` config callback に集約した。
- 購読失敗の政策も `onSubscribeFailed` として config へ集約し、hook の option は接続時に遅延確定するパラメータのみになった。
- browser の standalone 永続化は localStorage を既定とし、`localSnapshots: false` と `SnapshotStore` 注入を脱出口にした。
- README / SPEC / demo の公開例は instance 名を `synqux` に統一し、demo は非 React 向けの手続き購読例へ戻した。
