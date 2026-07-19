# TASK: 冪等性ハーネスの再定義 (repeat contract の mode 宣言化)

- Date: 2026-07-18
- Status: Completed
- 出自: assertActionIdempotency のユースケース検討 (ユーザとの設計議論)。既存 BACKLOG 項目なし
- 前提知識 (必読): `src/testing/idempotency.ts` / `src/testing/idempotency.test.ts`、`docs/SPEC-0001-requests-sync.md` 設計ガイドライン、`docs/SPEC-0002-public-api.md` の synqux/testing 節、`src/core/results.ts` (`stateWithError`)、`src/core/snapshot.ts` (`canonicalStringify`)

## 背景 (ADR にもこの内容を記録すること)

現行の `assertActionIdempotency` は synced state 全体 (result 込み) の canonical JSON を比較するため、次の 2 つの問題がある。

1. **execute-once 型への誤検知**: 「2 回目は reducer の validation が `stateWithError` で拒否する」パターンは、domain state が不変 (同期的に最も安全) にもかかわらず、result が success → error に変わるため fail する
2. **無限実行型へのカテゴリエラー**: チャット投稿や `counter/add` のような「N 回 dispatch = N 回の意味」の action は本質的に非冪等であり、repeat-safe の契約検査をかけること自体が誤り

整理すると「2 回適用」には 2 種類ある: **(①) 同一 request の二重適用**は機構が保証で潰す (不変条件 2。v2 で穴は閉じた) ため reducer 冪等性は機構の要件ではない。**(②) 同じ意図の別 request** (再クリック・state 監視 retry) は機構に識別不能で、domain semantics の領分。ハーネスの敵は「②で 2 回目も success のまま黙って domain が壊れる」クラス (toggle / 二重加算) だけである。

## 設計コンセプト (この判断は変えないこと)

- **冪等の定義を「domain state が不変」に修正する**: 比較は `{ ...state, result: null }` 同士の canonical JSON で行う。result は transient な通知であり restore でも復元されない (`clearRestoredResult`) という既存前提と整合する
- **action は自分の型 (mode) を宣言し、宣言した契約だけを検査する**。全 action 一律の冪等性強制はしない
- **既存 API 名は変えない** (rename churn を避ける)。`assertActionIdempotency` に optional `mode` を足す
- 無限実行型の「② の実害があるケース」への nonce 化 helper は**提供しない** (YAGNI。payload 設計は consumer の domain 判断。ADR の棄却案に記録)

## 実装内容

### 1. `src/testing/idempotency.ts`

- `verifyActionIdempotency`: 比較を domain-only (`{ ...single, result: null }` vs `{ ...double, result: null }`) に変更。report 形状 (`{ idempotent, single, double }`) は維持し、`idempotent` の意味を「domain 冪等」とコメントで再定義する
- `assertActionIdempotency` に optional `mode` を追加 (既定 `'idempotent'` = 後方互換):

  ```ts
  mode?: 'idempotent' | 'rejects-repeat' | 'repeatable'
  ```

  - `'idempotent'`: domain 冪等であること (set 型の契約)。fail 時の throw メッセージは現行踏襲 + domain 比較であることを明記
  - `'rejects-repeat'`: execute-once 型の契約。3 点を assert する — (a) 1 回目は受理される (`single.result?.type !== 'error'`)、(b) domain 冪等 (2 回目で domain が変わらない)、(c) 2 回目は明示的に拒否される (`double.result?.type === 'error'`)。fail 時はどの条件が破れたか分かるメッセージで throw
  - `'repeatable'`: **明示的な検査除外 (no-op)**。無限実行型を table に載せて「繰り返し可能であるとレビュー済み」の記録にするための宣言。JSDoc に「②の実害 (retry 重複等) の評価は consumer の責任。実害があるなら payload の一意 key + validation reject で execute-once 化する」と書く
- 各 mode の意図 (3 分類と ①/② の区別) をファイル冒頭コメントに要約する

### 2. `src/testing/idempotency.test.ts`

既存テストを新定義に合わせて更新し、以下を網羅する:

1. set 型は `'idempotent'` で pass する
2. toggle 型は `'idempotent'` で fail する (本来の敵が引き続き捕まる)
3. execute-once 型 (1 回目 success で domain 変化、2 回目 `stateWithError`) が `'rejects-repeat'` で pass する — **現行実装で fail していた誤検知の解消を示すテスト**
4. `'rejects-repeat'` の各条件違反が個別に fail する: 1 回目から error / 2 回目で domain が変わる / 2 回目が error にならない (黙って成功する)
5. `'repeatable'` は増分型 (counter/add 相当) でも throw しない
6. mode 省略時は `'idempotent'` (後方互換)

### 3. ドキュメント

- **`docs/ADR-0007-action-repeat-contract.md` 新規**: 背景 (上記 2 問題と ①/② の整理)、Decision (domain 冪等への再定義 / mode 宣言 / repeatable の明示除外思想 = 「無自覚な toggle 混入だけを検出網に残す」)、棄却案 — (a) result 込み全量比較の維持 (execute-once への誤検知)、(b) 全 synced action への一律強制 (無限実行型へのカテゴリエラー)、(c) 新 API 名への rename (churn)、(d) nonce 化 helper の提供 (YAGNI・domain 判断)
- **`docs/SPEC-0001-requests-sync.md` 設計ガイドライン 1 の書き直し**: 「現在値に依存する action を作らない」の絶対律的な文言を、3 分類ベースへ改める —
  - デフォルトは **set 型** (現行推奨のまま)
  - 1 回しか実行できない操作は **execute-once 型** (validation reject。`rejects-repeat` 契約)
  - **無限実行型** (チャット投稿等) は正当な設計だが**自覚的に**選ぶ: 同一 request の二重適用は機構が防ぐ (不変条件 2) 一方、再クリック・retry による「同じ意図の別 request」は機構に識別不能なので、実害があるなら payload の一意 key で execute-once 化、なければ UI debounce か許容
  - CI では mode 宣言つきの table で契約検査する (`synqux/testing`)
- **`docs/SPEC-0002-public-api.md`**: synqux/testing 節の `verifyActionIdempotency` / `assertActionIdempotency` の記載を新シグネチャ・新定義 (domain 冪等 / 3 mode) に更新
- **`README.md`**: consumer テスト段落の `assertActionIdempotency` の説明を「mode 宣言つきの repeat contract 検査 (非冪等 action の検出は `'idempotent'`、execute-once は `'rejects-repeat'`、意図的な繰り返し可能は `'repeatable'` で明示除外)」に 1〜2 文で更新
- **`demo/counter.ts`**: `counter/add` の冒頭コメントに「増分型 = 無限実行型の自覚的な例 (ガイドライン 1 の 3 分類参照)。demo は同時操作の見た目確認が目的のため許容」と 1〜2 行追記 (コード変更はしない)
- **`CHANGELOG.md`**: Unreleased に「冪等判定を domain 冪等 (result 除外) に修正 (誤検知の解消)」「mode 宣言の追加」を記載

## 制約

- 変更は `src/testing/` / `demo/counter.ts` (コメントのみ) / docs に閉じる。core は変更しない
- `assertActionIdempotency({ reducer, state, action })` の既存呼び出し形が動き続けること (mode 省略 = 'idempotent')
- 依存パッケージを追加しない
- git commit しない (人間が判断する)
- **`docs/local/` 配下のファイルは読んでも書いてもよいが、その内容 (社名・repo 名等) を git 管理対象ファイルへ絶対に書かないこと**
- 対応しきれない論点・積み残しが出た場合は `docs/BACKLOG.md` へ運用ルールに従って追記すること
- 設計どおりに行かない点があれば、無理に通さず本ファイル末尾に報告を書き残して停止すること

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存テストを壊していない)
- [x] 上記テスト 1〜6 が通る
- [x] ADR-0007 / SPEC-0001 / SPEC-0002 / README / CHANGELOG / demo コメントが更新されている
