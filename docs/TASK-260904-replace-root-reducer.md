# TASK-260904: replace-root-reducer

260904 instance を生かしたまま rootReducer を差し替える (HMR 対応の口)
===

## asis

- `createSynqux` は `config.rootReducer` を closure で握り、host 裁定の試し実行と seedProbe (standalone teardown) で直接呼ぶ。instance の `rootReducer` は config の echo (同一参照)
- consumer (テンプレ) の store.ts は synqux instance + store の singleton で、reducer (domains / modules) を変更すると Vite HMR が store.ts を再評価し、instance と store が二重生成される (旧 instance は unsubscribe されず生存、新 store は初期 state から再購読)。結果として reducer を触るたび手動 reload が必要
- Redux 定番の `store.replaceReducer` だけでは「裁定に使う reducer」と「適用する reducer」が乖離する (host 試し実行が旧 reducer のまま) ため、consumer 側だけでは閉じない

## tobe

- core instance に `replaceRootReducer(rootReducer)` を追加し、以後の試し実行 / seedProbe / `rootReducer` echo が新 reducer を使う
- instance の `rootReducer` は「現在の reducer へ委譲する安定関数」にする。`configureStore({ reducer: synqux.rootReducer })` で配線済みの store は差し替えに自動追従し、裁定と適用の乖離が構造的に起きない (`store.replaceReducer` は新 slice の初期化目的で任意)
- 定義の配線 factory が返す instance には素材単位の `replaceReducers({ synced, locals })` を載せ、consumer が `createSynquxRootReducer` / `isSyncedAction` / `syncedKey` を触らずに済ませる (供給点は定義の 1 箇所のまま)
- 差し替え対象は reducer のみ。middlewares / automations / listeners / transport は instance 閉包のまま (consumer は該当 module の変更時に full reload させる)

## todo

- [x] TASK 起票
- [x] core: `let rootReducer` 化 + `replaceRootReducer` + 委譲 echo (`src/core/create-synqux.ts`)
- [x] definition: `replaceReducers({ synced, locals })` (`src/core/define-synqux.ts`)
- [x] test-fixtures の store 配線を `sync.rootReducer` (echo) に揃える
- [x] テスト: 差し替え後の host 裁定 / 委譲 echo / 定義側 API / seedProbe
- [x] docs: SPEC-0002 (Synqux 型 + 定義の配線フェーズ) / README (API 表 + Usage に HMR 節)
- [x] npm run fix / npm test
- [x] Codex レビュー (2 回。反映内容と判断は notes)
- [x] 追加 (ユーザ判断): HMR 一式の片割れ `keepAcrossHmr(hot, key, create)` を main entry に追加 (`src/core/hmr.ts` + test、index.test の surface 更新、SPEC-0002 / README 反映)

## testcases

- [x] host が `replaceRootReducer` した後の request は新 reducer で裁定される (旧 reducer なら受理される action が拒否され、全端末で state 不変)
- [x] `synqux.rootReducer` を store に配線していれば `store.replaceReducer` なしで適用側も新 reducer に追従する (client 側も差し替えれば適用結果が新 reducer 由来になる)
- [x] 差し替えは instance の `rootReducer` 参照を変えない (`store.replaceReducer(synqux.rootReducer)` が同じ関数で成立)
- [x] standalone の seed teardown は差し替え後の reducer の初期 state へ戻す
- [x] 定義の `replaceReducers({ synced, locals })` で synced reducer を差し替えられ、root 型 (locals の key) は配線時のまま
- [x] host の試し実行済み・未適用の裁定がある間は差し替えを保留し、適用後に反映する (host への changed 配送を遅らせた窓で差し替え → 旧判定器で適用され snapshot と一致 → 捌けた後に反映)

## notes

- 発見経緯: テンプレ (fc-310) の「domains / reducer を触ると HMR 後に手動 reload が必要」の真因調査。Vite の限界ではなく synqux が判定器を閉包で握っていることが原因だった
- `replaceRootReducer` が store 側の `replaceReducer` を呼ばないのは、instance が store を知るのが session 中 (subscribe options) だけで、未購読時に契約が二重になるため。委譲 echo にしたことで「呼び忘れて裁定と適用が乖離する」経路自体をなくしている
- root 型 (`ReturnType<typeof synqux.rootReducer>`) は配線時に固定される。locals の key を増減する差し替えは型上も契約上も対象外 (instance を作り直す = full reload)
- Codex レビュー (1 回目) 反映:
    - 重大: host 裁定は「試し実行 → respond (await) → snapshot 保存 (await) → 自端末適用」と await を跨ぐため、その窓で差し替えると試し実行の結果 (snapshot / determinism 期待値) と実適用の reducer が乖離し、途中参加端末が復元不能な snapshot を掴み得る → 試し実行済み・未適用 (fork 生存中) の裁定が残る間は差し替えを保留し、全て捌けた時点で反映するゲート (`inflightAdjudications` + `pendingRootReducer`) を追加。host への changed 配送を遅らせる再現テストを先に書いて確認
    - 中: README の HMR 例が `typeof synqux` の自己参照 (型エラー) → factory + `ReturnType` の形へ修正。「never diverge」の表現も保留ゲートの説明へ置換
- consumer 側の定型の扱い (ユーザ判断): HMR の制御構造を隠す `withHotSwap` 型の helper は **採らない** (制御構造が見えなくなる)。代わりに冗長さの正体 2 つを潰す — (1) `hot.data` からの取り出しの cast / 型名付けのための factory は `keepAcrossHmr` で消す、(2) `store.replaceReducer` は echo の委譲で元々不要 (root の形が配線時固定なので REPLACE で初期化するものもない)。`keepAcrossHmr` は synqux 固有の知識を持たない汎用 util で一般のライブラリなら責務超過だが、consumer が自社 repo 群に限られる private 寄りライブラリとして「HMR 一式」を配る判断。`session.store.replaceReducer` の吸収案・`initialRoot()` 案は採らない (前者は store 構造型の拡張だけで利得なし、後者は HMR と無関係な既存の冗長さで別 TASK)
- Codex レビュー (2 回目) の指摘と判断:
    - 指摘: ゲートは host 自身の試し実行しか追跡しないため、client (や migration 後の host) に配達途中の responded・未適用 response があると、旧 reducer で裁定された action を新 reducer で適用し得る。未適用 response 全体をゲート対象にすべき
    - 判断: **拡張しない**。hot-swap は端末ごとに別々の瞬間に反映されるため、client 側をゲートしても「host が差し替えた後・client が差し替える前に裁定された request」は依然として旧 reducer で適用される (端末間の世代 skew は差し替え窓を跨ぐ request に本質的に残り、apply 経路への追加配管で閉じない)。守れる不変条件は「host 自身の試し実行 (snapshot / determinism 期待値) と host 自身の適用が同世代」までで、SPEC-0002 / README をその範囲へ絞って明記した。端末間の skew は dev の HMR 専用機能の前提として許容し、疑わしければ reload で正史へ復帰する
- Codex レビュー (3 回目、keepAcrossHmr 追加分) 反映:
    - 中: webpack の `module.hot` は data が初回 undefined・引き継ぎが dispose 経由なので構造型が合っても使えない → Vite の `import.meta.hot` 前提と docstring / SPEC / README に明記
    - 中: 「端末間の世代 skew を determinism check が検出する」は誤り (検査は host 自身の試し実行と適用の比較) → 記述を削除し「検出できないので疑わしければ reload」へ修正
    - 低: `key in hot.data` は継承プロパティを拾う → `Object.hasOwn`
