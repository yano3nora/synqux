# TASK: prune した requests の調査ログ退避 (logs/)

- Date: 2026-07-18
- Status: Completed
- 出自: retention (TASK-260718-requests-retention) の運用トレードオフ「prune 後は全量 replay 調査ができない」への対策 (ユーザ要望)
- 前提知識 (必読): `docs/ADR-0005-requests-retention.md`、`docs/SPEC-0001-requests-sync.md` の Trouble Shooting、`src/firebase/index.ts` の `pruneRequests`、`src/firebase/index.test.ts` の既存テストスタイル

## 目的

prune は requests の無限成長を解消したが、封筒の seq は「実際に適用された順序」の ground truth であり、削除すると事故調査の全量 replay (移植元事故調査で使った手法) ができなくなる。opt-in で、prune 対象の封筒を削除ではなく `logs/{groupId}/{requestId}` へ**退避 (move)** できるようにする。

## 設計コンセプト (この判断は変えないこと)

- **オプションは firebase adapter に持たせ、core は変更しない**。core の retention 契約は「requests から取り除かれること」であって物理削除を要求しない。退避先は storage の関心事なので adapter option が正しい置き場
- **move は 1 回の multi-path update で原子的に行う**: root ref に対する `update(ref(db), { 'requests/{groupId}/{id}': null, 'logs/{groupId}/{id}': envelope, ... })`。封筒が requests にも logs にも無い瞬間を作らない
- **logs/ は同期経路に一切乗らない**: 購読しない・restore で読まない・読み出し API も提供しない。調査は export ベース (Trouble Shooting の手順) で行う
- logs/ の容量は無限成長するが、それが目的 (監査ログ)。ゲーム破棄時に `logs/{groupId}` ごと消すのは consumer のデータライフサイクル運用に委ねる

## 実装内容

### 1. `src/firebase/index.ts`

- シグネチャを `firebaseTransport(db: Database, options?: { archivePrunedRequests?: boolean })` に拡張する (省略時 false = 現行どおり削除。minor 互換)
- `pruneRequests` を変更:
  - 対象抽出は現行どおり (orderByChild('seq') + endBefore + **seq なし除外の再検査**を維持)
  - `archivePrunedRequests: true` のときは requests 側 null と logs 側 envelope 書き込みを**1 つの root-level multi-path update** にまとめる。logs 側の値は `child.val()` をそのまま置く (id は key として保存される — requests と同じ形状保存)
  - false のときは現行実装 (requests 配下の null update) のまま
- パス helper `logsPath(groupId)` を connections/requests/snapshot と同じ作法で追加

### 2. `demo/`

- `demo/main.ts` の `firebaseTransport(db)` を `firebaseTransport(db, { archivePrunedRequests: true })` に変更する (stress mode で 200 件超えると prune が走るため、emulator UI で logs/ への退避を目視確認できる)
- `demo/README.md` の Stress mode 節に「200 件を超えた分は `logs/` へ退避される (emulator UI で確認可)」を 1 行追記

### 3. テスト (`src/firebase/index.test.ts` に追加。既存 mock スタイルに倣う)

1. **archive on**: prune が root-level の 1 回の update で「requests 側 null + logs 側 envelope」を同時に書くこと。対象は数値 seq < beforeSeq のみで、seq なしは requests からも消えず logs にも書かれないこと
2. **archive off (既定)**: 現行どおり requests 配下の null update のみで、logs への書き込みが発生しないこと
3. 対象ゼロ件のとき update 自体を呼ばないこと (現行挙動の維持)

### 4. ドキュメント

- **`docs/ADR-0005-requests-retention.md`**: 追記節「2026-07-18 追記: 調査ログ退避 option」を設け、採用理由 (ground truth の保全) と「core でなく adapter option にした理由」、logs が同期経路に乗らないこと、容量は consumer のライフサイクル運用であることを記録する
- **`docs/SPEC-0001-requests-sync.md`**: Trouble Shooting の「発生直後に export を取ること」の注意を更新 — `archivePrunedRequests` 有効時は `logs/{groupId}` export + requests export を seq 順に結合すれば全量 replay 調査が引き続き可能、と追記
- **`docs/SPEC-0002-public-api.md`**: firebase 机上検証表の pruneRequests 行と、retention 契約の文言を「requests から取り除く (物理削除または logs への退避)」へ更新。`firebaseTransport` のシグネチャ変更も subpath exports 側に反映
- **`README.md`**: firebase の indexOn 推奨の近くに、調査ログ退避オプションの 1〜2 行 (目的: prune 後も全量 replay 調査を可能にする / 容量は consumer 管理)
- **`CHANGELOG.md`**: Unreleased に追加

## 制約

- **core (`src/core/`) と `src/testing/` は変更しない**。オプションは firebase adapter に閉じる
- `firebaseTransport(db)` の既存呼び出しが無変更で動くこと (options 省略 = 現行挙動)
- 依存パッケージを追加しない
- git commit しない (人間が判断する)
- コメントは既存作法。特に「なぜ move を 1 回の multi-path update で行うか (中間状態を作らない)」を実装コメントに残す
- 設計どおりに動かない点があれば、無理に通さず本ファイル末尾に報告を書き残して停止すること

## 完了条件

- [x] `npm run fix` 実行済みで clean
- [x] `npm test` が全部通る (既存テストを壊していない)
- [x] 上記テスト 1〜3 が通る
- [x] ADR-0005 追記 / SPEC-0001 / SPEC-0002 / README / CHANGELOG / demo README が更新されている
