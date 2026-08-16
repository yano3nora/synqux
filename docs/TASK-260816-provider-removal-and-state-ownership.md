# TASK-260816: SynquxProvider 廃止と engine 状態の所有権整理

- 発端: ADR-0021 実装時に「instance に散った session 寿命の状態のリセット振り付け」起因のバグを Codex レビューで 3 件検出。同型事故の構造的排除のため、BACKLOG P1 (SynquxProvider 存廃 + refactoring) の一部を前倒しで実施する
- 関連: `docs/ADR-0022-remove-synqux-provider.md`、`docs/TASK-260816-replay-suppression-and-persisted-fire.md`

## 方針 (裁定済み)

1. **SynquxProvider / useLatestResult / useMyLatestResult / Synqux.selectSynced の削除** (ADR-0022)
2. **状態の所有権表の明文化**: create-synqux.ts の instance レベル変数を「instance 寿命 / session 寿命 / group 進行」へ仕分けし、SPEC-0001 に節として記録する。これが以後の engine 変更のチェックリストになる
3. **session 寿命の状態を session オブジェクトへ機械的に移動**し、ADR-0021 で入れた点ガードのうち構造で不要になるものを削除する
4. 完了まで engine への機能追加は凍結 (snapshot 書き込み削減などは後続)

## タスク

1. [x] ADR-0022 起草・Provider / result hooks / Synqux.selectSynced の削除、README / SPEC-0002 の追随
2. [x] 状態の所有権表を作成し SPEC-0001 へ節を追加
3. [x] 所有権表に従い session 寿命の状態を `SubscriptionSession` へ集約、不要になった点ガード・手動リセットを削除
4. [x] `npm run fix` / `npm test` 通過
5. [x] codex exec でレビュー → 指摘反映 (第 4 ラウンドで LGTM、2026-08-16)
    - [P1] pack-smoke が廃止 API を必須検証していた → Provider 不要 API の検証 + 廃止 API の残存検出 (反転 assert) へ修正
    - [P2] responseListener fork が現 session の syncState を読む点 → fork 捕捉方式は不採用 (request 単位 worker として現 session を読むのが正)。ただし指摘の派生で「teardown の逆順 cleanup による session=null・entities/phase 残存の微小窓」で replay 印なし適用が起き得ることが判明 → 「session 不在では適用しない」ガードを追加。SPEC の所有権節に task 2 分類 (session 束縛 / request 束縛) を明文化
    - 上記ガードの回帰テストは「unsubscribe cleanup を gate で止めて窓を決定的に開く」方式で red/green を確認済み
    - [P3] persisted timer の teardown 破棄テスト追加 / 所有権表の lastPrunedBeforeSeq 寿命説明の分離 / README の state 形状不一致を修正
6. [x] BACKLOG 更新 (Provider 項目の削除、全体 refactoring 項目の残件明確化)

## 完了条件

- `synqux/react` が Provider 不要 hooks のみになり、全テスト・lint 通過
- SPEC-0001 に所有権表があり、create-synqux.ts の instance 変数が表と一致
- session 寿命の状態が session オブジェクトに集約され、session 跨ぎの手動リセット関数が構造的に不要化 (または最小化) されている
