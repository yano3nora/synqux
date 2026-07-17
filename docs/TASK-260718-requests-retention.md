# TASK: requests の retention (prune)

- Date: 2026-07-18
- Status: Complete
- 出自: `docs/BACKLOG.md`「requests の retention (prune) が未実装」
- 前提知識 (必読): `docs/ADR-0002-host-seq.md` Decision 4/5、`docs/ADR-0004-sync-auto-recovery.md`、`docs/SPEC-0002-public-api.md` A2 の retention 契約、`src/core/ordering.ts` (`APPLIED_WINDOW_SIZE` と `isBeyondWindow`)

## 目的

requests が無限成長する問題を解消する。現状、復帰時の全量購読コスト・帯域・DB サイズがセッション長に比例して増える。host が snapshot 永続化後に古い requests を削除する仕組みを入れる。

## 設計コンセプト (この判断は変えないこと)

**prune の線 = `appliedSeq - APPLIED_WINDOW_SIZE` (直近適用窓の外側)。**

窓の外 (`isBeyondWindow` が true になる領域) は、既存仕様がすでに「全端末が適用済み扱いで破棄する」と定めている領域である:

- restore 後の全量購読で届いても破棄される (ADR-0002 Decision 5)
- dual-host 敗者がそこに居ても救済対象外 (ADR-0002 Decision 4)
- gap 自動回復の再購読 (ADR-0004 stage a) は窓内の gap に効き、窓より古い gap はどのみち snapshot restore (stage b) で治る

つまり**窓の外の envelope は削除しても全端末の挙動が一切変わらない**。retention の余白サイズを別途チューニングせず、既存の窓 (200 件) と完全に揃えることで、prune・敗者救済・自動回復の整合が 1 つの定数で保たれる。

- **prune の主体は host**。snapshot 永続化 (ack) 後に fire-and-forget で実行し、失敗は許容する (次の snapshot 後に再試行される)
- **transport API は optional メソッドで拡張**: `pruneRequests?(beforeSeq)`。id 指定でなく seq 閾値のクエリ型にする — 交代直後の新 host は前任時代の envelope id を知らないが、seq 閾値なら誰が host でも全歴史を prune できる
- **seq を持たない (未裁定の) envelope は絶対に削除しない**

## 実装内容

### 1. `src/core/types.ts` — transport interface

```ts
/**
 * 適用窓より古い requests の削除 (retention、ADR-0005)。optional —
 * 未実装の transport では prune されないだけで correctness に影響しない。
 * 契約: 「数値 seq を持ち seq < beforeSeq の envelope」だけを削除する。
 * seq なし (未裁定) は削除しない。削除イベントの配送は不要
 */
pruneRequests?(beforeSeq: number): Promise<void>
```

### 2. `src/core/create-synqux.ts` — host の prune 呼び出し

- instance 変数 `lastPrunedBeforeSeq = 0` を追加
- host 裁定 fork の `await persistSnapshot(...)` 成功後に:
  - `beforeSeq = orderingState.appliedSeq - APPLIED_WINDOW_SIZE` (**ack await 前に評価固定した `orderingState` を使う**。live の ordering を読み直さない — 既知の問題①と同じ構図を避ける)
  - `beforeSeq > 1 && beforeSeq > lastPrunedBeforeSeq && transport.pruneRequests` のときだけ `lastPrunedBeforeSeq` を更新し、`void transport.pruneRequests(beforeSeq).catch(console.error)` (fire-and-forget。裁定のクリティカルパスで await しない)
- standalone 経路は対象外

### 3. `src/testing/memory-hub.ts`

- `pruneRequests` を実装: group の requests から「数値 seq を持ち seq < beforeSeq」のものだけを削除する。subscriber への配送イベントは発火しない。`inspect.requests` には削除が反映される

### 4. `src/firebase/index.ts`

- `pruneRequests` を実装: `query(requestsRef, orderByChild('seq'), endBefore(beforeSeq))` で対象を取得し、multi-path update (`{ [id]: null, ... }`) で一括削除する
- **重要な罠**: RTDB の `orderByChild` は対象キーを持たない child を**数値より前に並べる**ため、endBefore の結果に「seq なし (未裁定)」の envelope が混入する。削除前に必ずコード側で `typeof val.seq === 'number' && val.seq < beforeSeq` をフィルタすること
- `demo/database.rules.json` の requests に `".indexOn": ["seq"]` を追加する (クエリの server-side 実行用。無くても動くが full scan 警告が出る)

### 5. テスト

技法は既存に倣う (memory hub、実時間 sleep 禁止)。`APPLIED_WINDOW_SIZE` は `ordering.ts` から import して使う。

1. **prune 動作**: 2 端末で `APPLIED_WINDOW_SIZE + 5` 件の request を順に処理 → transport 上の requests が「seq >= appliedSeq - APPLIED_WINDOW_SIZE のものだけ」になっている (件数と最小 seq を厳密 assert)。snapshot は最新
2. **prune 後の途中参加**: 上記の後に新規端末が subscribe → snapshot + 残存 requests だけで全端末と同じ synced state / ordering に収束する
3. **窓内 gap の自動回復と共存**: prune が動いている状態で、窓内の response 欠落 stall を起こす → ADR-0004 stage (a) の再購読で回復できる (欠落 envelope が prune されていないこと)
4. **memory hub の契約テスト**: 未裁定 (seq なし) envelope は pruneRequests で削除されない。同一/後退した beforeSeq の重複呼び出しが安全 (冪等)
5. **firebase adapter のテスト**: 既存 `src/firebase/index.test.ts` のスタイルに倣い、pruneRequests が「seq なしを除外して」削除対象を組み立てることを検証する (前述の orderByChild の罠の再現)

### 6. ドキュメント

- **`docs/ADR-0005-requests-retention.md` 新規**: prune 線を適用窓に揃える判断と、棄却案を記録する — (a) adapter 内 TTL prune (snapshot payload が不透明で adapter は安全線を知り得ない)、(b) 窓から溢れた id を host が記憶して id 指定削除 (交代直後の新 host が前任の歴史を prune できない)、(c) 保持件数の config 化 (窓と別の定数を持つと敗者救済・回復との整合が壊れやすい。YAGNI)、(d) 削除しない現状維持 (無限成長)
- **`docs/SPEC-0001-requests-sync.md`**:
  - 前提知識の snapshot 項か「対策済み」表に retention を反映
  - **Trouble Shooting に注意を追記**: prune 導入後、requests export で遡れるのは「snapshot + 直近適用窓」まで。事故調査で全履歴が要る場合は発生直後に export を取ること (移植元事故調査のような全量 replay は prune 後はできない)
  - 改善ロードマップの「snapshot 書き込み削減」等の残項目はそのまま
- **`docs/SPEC-0002-public-api.md`**: A2 の retention 契約 (契約 4) を「pruneRequests の削除対象は数値 seq < beforeSeq のみ。snapshot 地点との整合は core (prune 線 = 適用窓の外) が保証する」と現実に合わせて更新し、interface と firebase 机上検証表に pruneRequests を追加
- **`README.md`**: firebase 利用者向けに「requests への `".indexOn": ["seq"]` 推奨」を 1 行 (Quick Start の firebase 関連箇所)
- **`CHANGELOG.md`**: Unreleased に追加
- **`docs/BACKLOG.md`**: 運用ルール 2 に従い、当該項目をリンクごと削除する

## 制約

- `pruneRequests` は optional。既存の consumer 実装 transport が壊れないこと (minor 互換)
- 依存パッケージを追加しない。demo のコード (ts/html) は変更しない (rules.json のみ)
- git commit しない (人間が判断する)
- コメントは既存作法。特に「なぜ prune 線が適用窓と同一なのか (窓の外 = 挙動不変)」を呼び出し側コメントに残す
- 設計どおりに動かないシナリオがあれば、無理に通さず本ファイル末尾に報告を書き残して停止すること

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存の health / recovery / characterization テストを壊していない)
- [x] 上記テスト 1〜5 が deterministic に通る
- [x] ADR-0005 / SPEC-0001 / SPEC-0002 / README / CHANGELOG / BACKLOG が更新されている
