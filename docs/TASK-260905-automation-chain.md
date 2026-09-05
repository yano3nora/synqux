# TASK-260905: automation-chain

260905 多段依存チェーン (bot 型 automations) の simulation test と demo bot mode
===

## asis

- 移植元系列 consumer の bot は「前段の適用結果が次段の発行条件になる多段 dispatch」を host 限定の thunk (dispatch → 状態待ち → dispatch) で回しており、その最中に host が落ちるとチェーンが失われる
- synqux の答えは automations (ADR-0015: 各段を rule にし、新 host が synced state から続きを導く) だが、単発 rule の migration / dual-host のテストしかなく、**チェーンが migration・遅配・重複・dual-host を跨いで各段 1 回ずつ完走する**ことを示すテストがなかった
- 同 consumer を synqux へ移植して負荷試験する案は、bot が host 自己 dispatch であり端末並行性の負荷にならないこと、当時の改良が prev/REVISIONS 方式への対症療法で seq 方式には効かないことから見送り、この test / demo に絞った

## tobe

- fixture reducer に rejects-repeat の `game/step` を追加し、時間ゲート付き 3 段チェーンで以下を検証する
    - host migration・裁定の遅配・added の重複を跨いで各段 1 回ずつ適用され完走する
    - dual-host 窓の中でも各段の二重発行が 1 回適用へ収束し完走する
    - 適用が遅れた端末が host に昇格しても、前 host の確定済み response を上書きしない (→ **失敗。BACKLOG P0 へ**)
- `dispatchAndWait` の待機中に host が離脱しても、次点 host の裁定で resolve する (requester 視点の補完)
- demo に `?bot=1` の bot mode (host 駆動チェーン `bot-fill` → `bot-unlock`) を追加し、実 transport で migration 中のチェーン継続を目視できるようにする

## todo

- [x] `src/core/test-fixtures.ts`: `game/step`
- [x] `src/core/automations.test.ts`: 多段依存チェーン 4 ケース (遅れ端末昇格は封筒不変の `it.fails` 再現テストと、追いつき後の完走テストに分離)
- [x] `src/core/dispatch-and-wait.test.ts`: host 離脱中の resolve
- [x] `demo/slice.ts` `stepTo`、`demo/main.ts` automations、`demo/index.html` bot 表示、`demo/README.md` Bot mode
- [x] BACKLOG P0 へ「遅れ端末の host 昇格による確定済み response の上書き」を追記
- [x] `src/core/retention.test.ts`: 変更前 tree でも並列実行時に 5000ms timeout する既存 flake を確認し、`stress.test.ts` と同じ `vi.setConfig({ testTimeout: 30_000 })` を追加
- [x] npm run fix / npm test

## 発見したバグ (BACKLOG P0)

適用が遅れた端末 (裁定 changed が未着) が host に昇格すると、その request を「未裁定」とみなして再裁定し、自分が観測していない前 host の確定済み response を上書きした (probe: 初期変種では同一 `(epoch, seq)` で `responsedBy` / `responsed` が新 host に置換、現行の再現テストでは `(1, 2)` 相当が新 epoch で置換)。直列裁定ゲート (`hasInflight`) は「seq 付き entity が未適用」のときしか効かず、seq 未着の entity には効かない。再現テストは step-1 を観測済み (epoch 1 を知っている) の端末が step-2 未着で昇格する形にしてあり、新 host は epoch 2 で上書きする。このため `(epoch, seq)` の辞書順 CAS では防げず、「観測済み response との一致」を条件にした CAS が要る (Codex レビュー指摘)。今回のシナリオは added の到着順が前 host と同じだったため state は収束したが、順序が違えば seq の付け替えと success→error の差し替えが起き、適用済み端末・snapshot と恒久分岐する。対策案は BACKLOG を参照。

## testcases

- [x] チェーン完走 (migration + delay + duplicate): 全端末 `count === 3`、log が `step:1..3` ちょうど、request 3 件の responsedBy が旧 host → 新 host
- [x] チェーン完走 (dual-host): request ≥ 3 件、全端末 log 一致
- [x] 遅れ端末昇格 (step-2 の changed 未着で昇格): 前 host の response 封筒 (epoch / seq / responsedBy / responsed / result) が不変 → `it.fails` (修正後に外す)
- [x] 遅れ端末昇格: 追いついた後にチェーン完走、全 request が裁定済み
- [x] dispatchAndWait: host drop → disconnect → 次点 host 裁定で resolve、count 1
