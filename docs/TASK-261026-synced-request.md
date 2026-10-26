# TASK-261026: synced-request

261026 createSyncedRequest (ADR-0032)
===

## asis

- host が外部 I/O をして結果を synced action にする primitive が無い
    - automations は同期で、synced state から action を返すだけ
    - listeners は effect に dispatch を渡さない
- 導入 consumer は host-only listener に dispatch を注入して仮実装している。listener 契約の外である

## tobe

- `defineSynqux` の戻り値に `createSyncedRequest` がある。`requested` / `resolved` / `aborted` の 3 action と `reducer` を作る
- `createSynqux({ requests })` で、engine が timeout の automation と host の perform を内部で配線する
- 台帳は consumer の synced state の `inflight`
- 出典: ADR-0032

## 設計

- `src/core/synced-request.ts`: 型と `buildSyncedRequest`。engine 向けの rule は `SYNCED_REQUEST_RULES` symbol で持たせ、index から export しない
- `src/core/define-synqux.ts`: `createSyncedRequest` を定義の `createSyncedAction` で束縛する。synced state が `inflight` を持たなければ引数の型が `InflightStateRequired` になる
- `src/core/create-synqux.ts`: `requests` option。consumer の automations の後ろに timeout の rule を、consumer の listeners の前に perform の rule を並べる。perform の結果は開始時の session にだけ dispatch する。`replaceRules` も `requests` を受け、検証に失敗したら元に戻す
- `src/index.ts`: 型を export する

## todo

- [x] `src/core/synced-request.ts`
- [x] `src/core/define-synqux.ts`
- [x] `src/core/create-synqux.ts`
- [x] `src/index.ts`
- [x] tests (下記)
- [x] docs: ADR-0032、SPEC-0002、README、BACKLOG
- [x] `npm run fix` → `npm test`
- [x] Codex レビュー (下記)
- [ ] release (人間判断)

## testcases

- [x] requested: 台帳に書き、利用側の mutate を呼ぶ。処理中なら拒否する。利用側の validate はその後に評価する
- [x] resolved: id が一致すれば mutate して台帳を消す。台帳が空か id が違えば拒否する。再適用は拒否する
- [x] aborted: id が一致すれば mutate して台帳を消す。違えば拒否する
- [x] 型: inflight を持たない synced state では引数が型エラーになる
- [x] engine: host だけが perform し、resolved が全端末に適用される
- [x] engine: perform の throw で aborted (failed) が全端末に適用される
- [x] engine: timeout で aborted になり、後から届いた結果は捨てられる
- [x] engine: host が perform 中に抜けると、新しい host が timeout で aborted を出す。抜けた端末の結果はどこにも流れない
- [x] engine: standalone でも同じ配線で動く
- [x] engine: `replaceRules({ requests })` で perform の配線を差し替える
- [x] engine: 同じ key の request を 2 つ渡すと throw する

## notes

- 形は導入 consumer の仮実装 (2026-10-19) をそのまま移した。変えた点は 2 つ
    - 台帳の key 名を `pending` から `inflight` にした。理由: `PendingRequest` は request 封筒の型名として export 済み
    - perform の第 2 引数を synced state から `{ synced }` にした。理由: 後で引数を足しても壊れない
- session の guard は、外すと「抜けた端末の store に結果が適用される」ことを test で確かめた
- Codex レビュー (2026-10-26)
    - 採用: 結果の送信失敗 (pushRequest の reject) が未処理の拒否になる。automations と同じく捕まえて記録する。結果が届かなければ timeout が拾う
    - 不採用: perform 中に解除して同じ group へ再購読すると、旧 perform の結果が新 session に届く。理由: 再購読できるのは同じ group だけで、結果は台帳の id 照合を通った正しい結果である
