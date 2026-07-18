# TASK: 切断・再接続時の presence 再登録 (firebase adapter)

- Date: 2026-07-18
- Status: Completed
- 出自: `docs/BACKLOG.md`「切断・再接続の presence 再登録」
- 前提知識 (必読): `src/firebase/index.ts` の `connect` / `disconnect`、`src/firebase/index.test.ts` の mock スタイル、`src/core/host.ts` (`deriveHostId` — connected 降順で host が決まる)、`docs/SPEC-0002-public-api.md` A2 契約 5

## 目的

firebase SDK は WebSocket を自動再接続するが、切断中にサーバ側 onDisconnect が発火して `connections/{groupId}/{selfId}` が消えた場合、復帰後に自分を再登録する経路が無い。その端末は他端末から不在のままになり、host にも昇格できない。adapter 内で `.info/connected` を監視し、再接続時に presence を自動復元する。

## 設計コンセプト (この判断は変えないこと)

- **adapter 内で完結させ、core / transport interface は変更しない**
- **再登録の `connected` は初回接続時の解決値を維持する**。新しい serverTimestamp で登録し直すと「最新接続 = host」の導出により、回線が不安定な端末が再接続のたびに host を強奪し、host churn と dual-host 窓を量産する。再接続は「復帰」であって「新規参加」ではない
- **再登録は「切断を観測した後の復帰」でのみ行う**。接続確立直後の `.info/connected: true` (初回) では何もしない
- **オンライン状態の consumer への公開は今回見送る** (ADR に理由を記録)。切断の実害 (適用停止) は sync health が既に検知・回復するため、presence 復元だけで運用ニーズを満たせる。必要になれば透過的に追加できる

## 実装内容

### 1. `src/firebase/index.ts`

- session に `role` / `label` / `connectedAt` (初回登録の解決済み connected 値) を保持する
  - `connectedAt` は初回 `set` の ack 後に `get(selfRef)` で読み戻して確定する。読み戻せなかった場合 (null 等) のみ、再登録時に `serverTimestamp()` へフォールバックする
- connect() の初回登録後に `.info/connected` の常駐 watcher (`onValue`) を開始する:
  - `false` を観測したら「切断あり」フラグを立てる
  - `true` かつ「切断あり」のとき再登録する: **`onDisconnect(selfRef).remove()` を先に再登録してから** `set(selfRef, ...)` (初回登録と同じ順序。値は id / groupId / `connected: connectedAt` / role / label を sanitize して書く)。成功したらフラグを下ろす
  - 再登録の失敗は throw せず `console.error` に流す (フラグを残し、次の再接続サイクルで再試行される)
  - session が破棄済み (disconnect 後) なら何もしない
- disconnect() で watcher を必ず解除する (既存 cleanup より先)

### 2. テスト (`src/firebase/index.test.ts` に追加。既存 mock スタイルに倣う)

1. **再登録の基本**: connect 後に `.info/connected` が false → true と遷移すると、onDisconnect 再登録 → set の順で presence が復元され、`connected` は**初回の解決値のまま** (serverTimestamp を使い直していない) こと
2. **初回 true では再登録しない**: connect 完了時点で set が 1 回だけであること (watcher の初回発火で二重登録しない)
3. **disconnect 後は再登録しない**: disconnect() で watcher が解除され、以後の false → true で set が呼ばれないこと
4. **失敗の許容**: 再登録の set が reject しても throw せず console.error に流れ、次の false → true で再試行されること

### 3. ドキュメント

- **`docs/ADR-0006-presence-reregistration.md` 新規**: 採用 (adapter 内 watcher + connected 維持) と棄却案を記録する — (a) 新 serverTimestamp での再登録 (host 強奪・churn・dual-host 窓の量産)、(b) core へのオンライン状態公開 (transport interface 拡張が必要。切断の実害は sync health が既に検知・回復しており YAGNI。将来必要になれば透過的に追加可能)、(c) 現状維持 (長時間セッションで必ず踏む)
- **`docs/SPEC-0002-public-api.md`**: A2 契約 5 (presence cleanup) に「切断から復帰した adapter は presence を自動復元すること (connected は初回値を維持し host 序列を変えない)」を追記し、firebase 机上検証表の connect 行を更新
- **`docs/SPEC-0001-requests-sync.md`**: 前提知識「host 決定ロジック」の項に「再接続時の presence 復元は connected を維持するため host 序列を変えない (ADR-0006)」を 1 文追記
- **`CHANGELOG.md`**: Unreleased に追加
- **`docs/BACKLOG.md`**: 運用ルール 2 に従い、当該項目をリンクごと削除する (オンライン状態公開の見送りは ADR-0006 に記録されるため BACKLOG には残さない)

## 制約

- 変更は `src/firebase/` と docs に閉じる。core / testing / demo は変更しない
- 依存パッケージを追加しない
- git commit しない (人間が判断する)
- コメントは既存作法。特に「なぜ connected を維持するのか (host 強奪の防止)」「なぜ onDisconnect 再登録が set より先か」を実装コメントに残す
- 設計どおりに動かない点があれば、無理に通さず本ファイル末尾に報告を書き残して停止すること

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存テストを壊していない)
- [x] 上記テスト 1〜4 が通る
- [x] ADR-0006 / SPEC-0001 / SPEC-0002 / CHANGELOG / BACKLOG が更新されている
