# TASK: demo に stress mode (同時多発 request の順序整合性検証) を追加

- Date: 2026-07-17
- Status: Completed
- Scope: `demo/` のみ (+ 本ファイル)。`src/` は変更しない

## 目的

demo の counter は可換な演算 (add) のため、順序が入れ替わっても結果が偶然一致してしまい、順序保証のバグを目視で検出できない。複数タブから同時多発的に request を送り合い、**適用順序が端末間で一致していなければ表示が確実にズレる**順序敏感な state を追加して、「当たり前に動くこと」を手動で確認できるようにする。

## 設計コンセプト

- 順序敏感な synced slice `ledger` を demo に追加する。running hash (適用順に依存するチェーンハッシュ) を持たせ、全端末の適用列が一致 ⇔ hash が一致、となるようにする
- 各タブが自動で action を乱射する「storm」を実装し、静穏化後に全タブの `count` / `hash` を目視比較する
- reject 経路にも負荷をかけるため、lock 中の append は `stateWithError` で拒否させる (拒否判定は host の reducer 試し実行で行われるため、拒否も全端末で一致するはず = hash に影響しない)

## 実装内容

### 1. `demo/ledger.ts` (新規)

`demo/counter.ts` と同じ作法 (SynquxSynced / stateWithError / 型) で書く。

- state: `{ result, count: number, hash: string, locked: boolean }`。初期値 `{ result: null, count: 0, hash: 'seed', locked: false }`
- actions:
  - `ledger/append { payload: { by: string, n: number } }` — `locked === true` なら `stateWithError` (message: 'ledger is locked')。それ以外は `count + 1` し、`hash = fnv1a(`${state.hash}|${by}|${n}`)` で更新
  - `ledger/setLocked { payload: boolean }` — locked を set (現在値に依存しない set 型、設計ガイドライン 1 準拠)
- `fnv1a(input: string): string` は FNV-1a 32bit を hex 文字列で返す純粋関数として同ファイルに実装 (依存追加禁止・`Date.now()` / `Math.random()` を reducer 内で使わない)
- `isLedgerAction` を export

### 2. `demo/main.ts` (変更)

- `createSynquxRootReducer` の `synced` に `ledger: ledgerReducer` を追加、`isSyncedAction` を `counter/` または `ledger/` の union に変更
- 実装時注記: 現行 v1 API は synced slice を 1 エントリに制限しているため、demo 内で counter / ledger を合成する `demoReducer` を 1 エントリとして渡す。対象 reducer の `result` は top-level に写し、host の成否判定器を一箇所に保つ
- storm 機能:
  - `startStorm(total: number)`: `total` 回、25〜150ms のランダム間隔で dispatch する。内訳は約 90% が `ledger/append { by: 自分の selfId (未接続時は 'anon'), n: 連番 }`、約 10% が `ledger/setLocked` (true/false 交互)。実行中の再入は無視
  - URL param `?storm=200` があれば subscribe 成功後に自動で `startStorm(200)` を開始 (複数タブ一斉試験用)
  - storm の乱数は UI 層なので `Math.random()` で構わない (reducer 内でなければよい)
- render に ledger 表示を追加: `count`、`hash` (先頭 8 文字)、`locked`、このタブの送信数 (sent)、`ledger.result` のエラー表示

### 3. `demo/index.html` (変更)

- ledger セクションを追加: count / hash / locked / sent の表示、`Storm x50` / `Storm x200` ボタン、`Lock toggle` ボタン (`ledger/setLocked` を dispatch)
- 既存 counter セクションはそのまま残す

### 4. `demo/README.md` (変更)

「Stress mode」節を追加し、以下を記載する。

- 実行手順: emulator + demo 起動 → 同じ group のタブを 3 つ以上開く → 各タブで Storm 実行 (または全タブを `?storm=200` 付き URL で開く)
- 判定基準: **storm 終了後・全 request 静穏化後に、全タブの ledger count と hash が完全一致すれば正常**。1 つでも違えば順序保証か適用一意性のバグ
- 注意書き: storm 中にタブを閉じて host migration を混ぜた場合、dual-host 窓の既知トレードオフ (SPEC-0001「設計上の割り切り」) により一時分岐があり得る。**host 交代を伴わない安定運用での不一致のみをバグと判定する**

## 制約

- 変更は `demo/` 配下のみ。`src/` / 公開 API / transport は触らない
- 依存パッケージを追加しない。plain DOM を維持し framework を入れない
- git commit しない (人間が判断する)
- コメントの作法は既存 demo ファイルに合わせる (意図 + やっていること)

## 完了条件

- [x] `npm run fix` 実行済みで差分が clean
- [x] `npm test` が全部通る (`test:tsc-demo` で demo も typecheck される)
- [x] `demo/README.md` に Stress mode の実行手順と判定基準が記載されている
- [x] 手動確認 (emulator での複数タブ storm) は人間が実施する — 本タスクでは不要
