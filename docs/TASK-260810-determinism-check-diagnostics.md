# TASK-260810: determinism check の診断力強化 (差分出力) と stale expected の解消

- Date: 2026-08-10
- Status: Implemented
- 由来: 実ゲーム repo への初導入検証で、host 端末の synced action 適用ごとに `[synqux] Determinism check failed for request ...` が毎回出力される事象が報告された

## 問題

1. **ログに差分情報がなく、consumer 側で原因特定が不可能**
    - `verifyDeterminism` (`src/core/create-synqux.ts`) は request id と一般的な原因候補 (Date.now / Math.random) しか出力しない
    - 導入先の reducer を静的調査しても非決定 API は見つからず、「どの field がどう違ったか」が見えない限り調査が進まない。決定性検出網は best-effort な開発支援機構なのに、検出時に開発者を支援できていない
2. **expectedSyncedByRequest に stale entry が残留する窓がある**
    - expected は裁定時に控え、実適用後の verify で delete される。しかし verify まで到達しない経路がある:
        - auto-recovery の `synquxRestored` で synced が全量差し替えされた場合、restore 後に適用された request は「restore 前の base state で計算した expected」と比較され false positive になり得る
        - snapshot restore で `isApplied` になった request は fork が verify せず break し、entry が Map に残留し続ける (メモリリーク)
        - unsubscribe 後も Map が残り、再 subscribe した session と混ざり得る

## 実装概要

1. **差分出力**: expected (canonical JSON) と actual を再帰比較し、「最初に分岐した path・expected 値・actual 値」を console.error に含める
    - `src/core/diff.ts` の内部 helper が object のキー和集合を辞書順、配列を index 順に比較する
    - state 全文は出さず、分岐点の値は JSON 表現の先頭 200 文字へ切り詰め、切り詰め時は `...` を付ける
    - expected と actual はどちらも canonical JSON を parse した値に揃えて比較する
2. **stale expected の解消**: `synquxRestored` の dispatch 時と unsubscribe (session cleanup) 時に `expectedSyncedByRequest.clear()`

## テスト計画

- [x] unit (red 確認済み): 非決定 reducer の検出時、ログに分岐 path と expected/actual 値が含まれる
- [x] unit: consumer 典型パターン (全 synced action で `state.result = { action, type: 'success', targets: [] }` を書く matcher 相当を持つ reducer) で false positive が出ない
- [x] unit: 差分 helper の object 辞書順、欠落キー、配列、root 差分を検証する
- [x] restore / unsubscribe の clear は防御的不変条件として実装。公開 API だけでは「裁定と適用の間の restore」や内部 Map を決定的に観測できず、fault 注入・fake timer の複雑な orchestration または白箱 API が必要になるため、実装詳細を固定する個別テストは追加しない
- [x] 既存テスト green

## 完了条件

- [x] 上記テスト green (red 必須のものは red を先に確認)
- [x] `npm run fix` / `npm test` pass
- [x] SPEC-0001 の決定性検出網の記述へ「検出時は分岐 path を出力する」「restore / unsubscribe で expected を破棄する」を反映

## 補足 (導入先で観測された事象の調査メモ)

- 症状: host 端末で、payload に phase しか持たない前進系 action (synced state から次 index を決定的に導出するタイプ) を含む**全 synced action の適用ごと**に check が失敗する
- 静的調査で棄却済みの仮説:
    - 「payload に index が無いから」→ 誤り。check は同一 action・同一 base state の比較であり、synced state からの決定的導出は問題にならない
    - consumer reducer の非決定 API 混入 → 見つからず (時刻系 payload は dispatch 時に焼き込み済み)
    - trial と apply の間の別 action 適用 → ordering の直列裁定ゲート (pending issue / in-flight 検査) で構造上防がれていることを確認
- 残る候補 (差分出力後に切り分ける): dev server の HMR / StrictMode による instance 二重化、transport 往復での封筒差異、consumer の非 request 経路からの synced state 書き込み
