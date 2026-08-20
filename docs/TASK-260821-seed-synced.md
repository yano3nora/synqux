# TASK-260821: standalone subscribe への seedSynced (初期 synced state 注入)

- Date: 2026-08-21
- 関連: ADR-0018 (session mode) の Amendment、導入 consumer の `_prepareTutorial` 置換

## 背景 / 決定

導入 consumer の tutorial 実装は、synced slice の `reducers` ブロックに非同期 action
(`game/_` prefix の system action) を残し、standalone session 開始後に dispatch して
synced subtree を全量差し替えていた。これは「synced reducer が case で扱う action は
全部 synced action」という認知モデルを歪める抜け穴で、実体は game action ではなく
**session の初期 state 注入 = restore の亜種**である。

ADR-0018 が「tutorial = session の作り直し (unsubscribe → standalone subscribe)」を
公式化した続きとして、**新 session の初期 state も subscribe に寄せる**:

1. `SynquxSubscribeOptions` に `seedSynced?: TSynced` を追加する
2. **standalone 限定**。synced session の正史は transport snapshot なので、
   synced mode + seedSynced は subscribe を throw で拒否する
3. 実装は既存の restore 経路 (`synquxRestored` + `clearRestoredResult`) に合流する。
   新しい不変条件を作らない。ordering は「snapshot なし」と同じく新規に始める
4. 優先順位: seedSynced 指定時は localSnapshots の load を行わない (明示 > 永続)。
   localSnapshots 有効 + seedSynced は「新規セーブの開始」の意味論になる
   (以後の適用で seed 起点の snapshot が保存される)
5. 型: `Synqux` / `SynquxSubscribeOptions` に `TSynced` generic を追加 (default 付きで
   既存の型注釈は互換維持)

命名は `seedSynced` (ユーザ決定。restore 対象が synced subtree であることを名前で示す)。

## 作業項目

- [x] `create-synqux.ts`: options 追加・synced mode 拒否・standalone 分岐で seed restore
- [x] simulation test: seed 適用 / synced + seed の拒否 / seed 時に localSnapshots を
      load しない / result が除去される
- [x] ADR-0018 Amendment・SPEC-0002・README (tutorial 例の書き換え)
- [x] `npm run fix` / `npm test`
- [x] Codex レビュー → **Approve** (2026-08-21)。指摘対応の経緯:
    - ordering の残留 (appliedSeq / 適用窓に加え seenAddedIds / maxIssuedSeq /
      myEpoch / processing) → `Ordering.reset()` を新設し seed 分岐で初期化
      (maxSeenEpoch のみ維持で fencing 不後退)。unit test + snapshot 欠損復帰の
      e2e (failSnapshot 注入) を追加
    - seed の正史への暗黙マージ → seed を session-scoped 化: teardown で synced
      subtree を reducer 初期 state へ戻す (probe type は予約 namespace
      `synqux/seedProbe`)。snapshot 欠損復帰は「initial + backlog replay = 正史」

## 完了条件

- tutorial パターンが「unsubscribe → subscribe({ mode: 'standalone',
  localSnapshots: false, seedSynced })」だけで書け、consumer が synced slice に
  非同期 action の抜け穴を持つ理由が消える
