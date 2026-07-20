# SPEC: requests 同期基盤

## Overview

端末間 synced state 同期基盤の仕様。仕組み・前提知識・既知の問題・設計ガイドラインをまとめる。core は transport 抽象にのみ依存し (`docs/SPEC-0002-public-api.md`)、Firebase Realtime Database は adapter 実装の 1 つ (`synqux/firebase`)。本文の firebase 表記は「最初の transport 実装」としての説明であり、仕組み自体は infra 非依存。

- 目的: 同期まわりの不具合調査・改修時に「どこまでが設計意図で、どこからがバグか」を即判断できる状態にする
- 詳細はコードとその周辺コメントを正とし、本書は「どこを読めばよいか」と「なぜ成り立つか」だけを示す

### 同期モデルの選定

採用しているのは Server / Client 方式のうち**クライアントホスト型 (リレーサーバ)**。専用サーバ型と比べてサーバの開発・保守運用コストを丸ごとカットでき、協力型・ターン制の少人数マルチプレイに向く。反面 host に負荷とロジックが集中するため、同期速度・平等性が重視されるリアルタイム対戦には不向き。P2P・専用サーバ型との比較と選定背景は下図を参照。

![Realtime Sync by Client-Host Model](assets/realtime-sync-by-client-host-model.svg)

## 前提知識

各要素の一言概要と「だから何が成り立つか」。詳細は対応ファイルへ。

- **action の request 化** — `src/core/create-synqux.ts` (`actionRequestMiddleware`)
    - synced domain action を横取りして transport へ push し、ローカル適用を中断する。楽観更新をしない
    - → 画面に出る state は常に「同期済み state」であり、画面と判定 state の恒常的なズレが構造上起きない
- **host 決定ロジック** — `src/core/host.ts` (`deriveHostId`)
    - 全端末が共有する peer pool から「最新接続の dedicated、いなければ最新接続の player」を host とする純粋関数 (observer は昇格しない)
    - 再接続時の presence 復元は初回の connected を維持するため、復帰だけで host 序列は変わらない (ADR-0006)
    - → 選挙プロトコルなしで全端末が同じ host に合意でき、host 離脱時も pool の変化だけで自動的に次の host が定まる (host migration)
- **各端末の request 処理 fork** — `src/core/create-synqux.ts` (`requestListener`)
    - 全端末が request ごとに fork を持ち、「自分が host か」を監視し続ける。fork は request が適用されるまで生存し、dual-host 窓の敗者の再裁定も引き受ける (ADR-0002)。待機はイベント駆動 (state 変化の notify) で、ポーリングは安全網のみ
    - → host 不在・migration 中に届いた request も、誰かが host に昇格した時点で処理される。キュー処理のような排他制御を分散環境で実現している
- **順序保証 (host 採番 seq)** — `src/core/ordering.ts`, `src/core/create-synqux.ts` (`responseListener`)
    - transport のイベント順序も request id (端末時計) も信頼せず、host が裁定時に連番 `(epoch, seq)` を封筒へ焼き込む。全端末は「appliedSeq + 1 の seq を適用する」規則で適用順を線形化する。同一 seq の衝突 (dual-host 窓) は (epoch 降順, responsedBy 辞書順降順) の決定的 tiebreak で全端末が同じ勝者に合意する
    - → 到着順がバラついても全端末の適用順は host 基準で一致する。封筒に焼かれた seq 自体が「実際に適用された順序」の ground truth (requests export を seq 順に並べれば適用列が復元できる)
- **reducer の作り方 (validation = result)** — `src/core/results.ts` (`stateWithError` / `generateResult`)
    - reducer は logic validation に失敗したら state を変えず `state.result` に error を積む。host は `rootReducer` を試し実行し、`selectSynced(next).result.type` (`error` / `success`) で request の受理・拒否を判定する
    - → 成否判定器は reducer ただ一つ。host / client / 同期なし (standalone) でロジックが分岐せず、reducer さえ堅牢なら同期しても壊れない
- **snapshot と restore** — `src/core/snapshot.ts`, `src/core/create-synqux.ts` (`subscribe` / `persistSnapshot`)
    - host は request を 1 件処理するたびに synced state 全体を canonical JSON の封筒で永続化する (封筒には順序状態 = epoch / appliedSeq / 直近適用窓も載る)。ack 後、適用窓の外 (`seq < appliedSeq - 200`) を fire-and-forget で prune する (ADR-0005)。復帰端末は snapshot を復元してから残存 requests を全量購読し、適用済み分は seq で破棄して追いつく
    - restore は ordering の適用窓・適用済み id 集合を snapshot の内容で完全置換し、残存する未適用の裁定済み envelope を再評価する
    - → 途中参加・リロード・host migration をまたいでも状態と順序保証が継続し、requests の保存量はセッション長に比例しない

## 同期の仕組み

クライアントホスト型を Redux × transport で実現する。redux store は「synqux 内部 slice (`state.synqux` = 接続端末の管理と受信 request の置き場)」と「consumer の synced slice (同期対象状態)」に分かれ、peers と requests を transport と同期させる。全体コンセプトは下図 (移植元の firebase 構成の図。connections/requests/game は state.synqux.connections / state.synqux.requests / synced slice に対応)、action 1 件が適用されるまでの流れは後述のシーケンスの通り。

![Sync with Firebase and Redux](assets/sync-with-firebase-and-redux.svg)

```txt
client                      firebase                     host
  |  game action dispatch      |                           |
  |--(actionRequestMiddleware)-|                           |
  |  ※ローカル適用せず中断        |                           |
  |        createRequest ----->|                           |
  |                            |--- child_added ---------->|
  |                            |     (requestListenerMiddleware)
  |                            |     rootReducer で成否判定    |
  |                            |<-- respondRequest ---------|  result/(epoch,seq)/responsedBy 付与
  |                            |<-- updateGameState --------|  snapshot 永続化
  |<-- child_changed ----------|                           |
  |  (responseListenerMiddleware)                          |
  |  request.action を dispatch = ここで初めて全端末に適用       |
```

### 不変条件 (これが破れたらバグ)

1. game state を書き換える action は、必ず request → response → dispatch の経路を通る (`meta.requestedBy` 付与済み action のみ素通し)
2. 各 request は全端末で**高々 1 回**適用される
3. 適用順序は全端末で host の採番した seq 順に一致する
4. snapshot 封筒の `ordering` (appliedSeq / 直近適用窓) はその時点の適用履歴と一致する

### 設計上の割り切り

- **dual-host 窓での適用列の一時分岐はあり得る** (ADR-0002)。fencing (epoch) の役割は分岐の防止ではなく「収束先の決定」であり、完全防止は consensus を要するためクライアントホスト型の割り切りとする。分岐の実害は敗者再裁定と冪等 action 設計で吸収する
- **push 失敗・切断による取りこぼしは依然あり得る**ため「タイマー等で 1 度しか発火しない action」は禁止。state 監視で retry するか、ユーザ操作で dispatch させる作りにする (v1 の「遅延 request の意図的ドロップ」は seq 化で消滅したが、この一般則は残る)
- **log 専用の error result (`result.type === 'error' && message なし`) の request は dispatch せず `console.error` へ流す** (連打・遅延で弾かれた操作の通知はノイズのため)。result の通知チャネルは message (UI 表示、表示は consumer 責務) と log (console 出力、synqux が targets 準拠で出力) の 2 系統 (ADR-0008)

### setEnabled の契約 (runtime on/off、tutorial 用途)

`actions.setEnabled(false)` は**送信ゲートのみ** (移植元 `_prepareTutorial` と同じセマンティクス)。再現テスト: `src/core/set-enabled.test.ts`

- off 中の synced action は request 化されず **local にのみ即時適用**される (楽観更新なし原則の意図的な例外)。transport への push・localSnapshots への永続化は行わない (standalone = instance `enabled: false` とは別物)
- **受信 request の適用・host 責務・購読は止まらない**。グループが動いていると remote 適用が local 乖離へ混ざり、さらに**自端末が host の場合は乖離した state を土台に裁定・snapshot 保存されるため、正史そのものが汚染されて群内で state が割れる** (host 導出は peer pool の全端末合意であり、enabled は端末 local のため host 候補から自動では外れない)。tutorial は「グループに他端末がいない / 動いていない」前提で使うこと
- `setEnabled(true)` に戻しても off 中の local 乖離は残る。自端末が host にならない限り乖離が正史へ乗ることはないが、自端末の以降の同期適用は乖離した土台に乗り続ける。**tutorial 後の復帰はリロード相当 (新しい store / client での再 subscribe) で snapshot の正史へ戻すこと**

## 既知の問題

### 対策済み (実装内で吸収している)

| 問題 | 対策 | 場所 |
| --- | --- | --- |
| transport のイベント順序 (added の到着順) が信頼できない | host 採番の seq に全端末が追従 (ADR-0002) | `src/core/create-synqux.ts` / `src/core/ordering.ts` |
| added の重複配送 (遅延後に重複) | 同一 request id の added を `acceptAdded` ガードで破棄 | `src/core/ordering.ts` / 受信ルーティング |
| restore 時に裁定済み request が added で届く | changed 相当として振り分け | `src/core/create-synqux.ts` (受信ルーティング) |
| dual-host 窓で異なる request が同一 seq を得る | (epoch 降順, responsedBy 辞書順降順) の決定的 tiebreak + 敗者は host が新 seq で再裁定 | `src/core/create-synqux.ts`、再現テスト: `src/core/characterization.test.ts` |
| ① 順序記録の二重記録 (v1 の revisions 二重追記): host の response ack 遅延時に記録が競合する | snapshot へ載せる順序状態を ack await の**前**に評価固定 (Phase 1 で修正、seq 版でも継続) | `src/core/create-synqux.ts` (host 裁定 fork)、再現テスト: `src/core/characterization.test.ts` |
| ② clock skew による request の取りこぼし (v1 の isDelayed ドロップ) | **seq 化で機構ごと根絶** (Phase 3 / ADR-0002)。順序が request id と無関係になり、遅配 request は次の seq を貰って普通に適用される | 反転テスト: `src/core/characterization.test.ts` |
| ①′ responseListener の二重 dispatch 窓: check-then-act (isApplied チェック → dispatch → await → markApplied) の窓に同一 changed の同時二重配送が入ると二重適用され、**非冪等 action が静かに壊れる** | dispatch 直前に同期的な処理中ガード (`ordering.beginProcessing`) を立て、markApplied 後 finally で解放 (synqux Phase 1 で修正)。失敗時は解放して再配送での retry 余地を残す | `src/core/create-synqux.ts` (responseListener) / `src/core/ordering.ts`、再現テスト: `src/core/characterization.test.ts` |
| response 永久欠落 / dual-host 早期適用による seq gap | sync health で検知し、requests 再購読 → snapshot restore を 1 巡。失敗時だけ unrecoverable を通知 (ADR-0004) | `src/core/create-synqux.ts`、再現テスト: `src/core/recovery.test.ts` |
| respondRequest の失敗 / ack 喪失・saveSnapshot の失敗 | response 封筒を裁定時に凍結し ack まで同一内容を再送。snapshot 失敗は log のみで prune をスキップし、確定済み response を上書きしない (ADR-0010) | `src/core/create-synqux.ts` (`spawnHostFork`)、再現テスト: `src/core/host-adjudication.test.ts` |
| requests の無限成長 | snapshot ack 後、既存仕様ですでに破棄対象となる適用窓の外だけを host が prune (ADR-0005) | `src/core/create-synqux.ts` / transport adapter、再現テスト: `src/core/retention.test.ts` |

### 既知トレードオフ (仕様として明文化)

- **dual-host 窓の一時分岐**: presence 遅延で 2 端末が host を自認した窓 (host は最新接続端末のため、新規参加のたびに短時間開く) で、異なる request が同一 seq を得ることがある。正史 (host + snapshot + 封筒の seq) は常に一本道で壊れず、未適用の端末は決定的 tiebreak で同じ勝者に合意し、敗者は再裁定で救済される。ただし**勝者到着前に敗者を適用してしまった端末**は、勝者を適用する機会を失い、敗者の再裁定 seq も適用済み扱いで破棄して stall する。この端末が host に昇格すると直列裁定ゲートにより群全体の裁定も止まる。sync health の snapshot restore は ordering を正史で完全置換して裁定済み envelope を再評価するため、再裁定 seq が restore snapshot より先にある場合も正史へ追いつき、群の裁定を再開する (再現: `src/core/recovery.test.ts`)
- **敗者救済の範囲は直近適用窓 (200 件) まで**: 窓より古い敗者は正史との区別記録がなく、適用済み扱いで破棄される (v1 は敗者救済ゼロだったため純増の改善)
- **回復不能な seq gap はリロードが必要**: 配送欠落は requests 再購読、dual-host 早期適用は snapshot restore で自動回復する (ADR-0004)。各段階は 1 gap エピソードにつき 1 回だけで、snapshot が無い・自端末以下など 1 巡で戻れない場合は `unrecoverable` となる。この場合だけ consumer がリロードを案内する。遅着で gap が自然解消すれば `unrecoverable` からも `ok` へ戻る

NOTE: `markApplied` を dispatch **前**へ前倒しする案は不可 (dispatch 失敗時にその seq が永久欠番となり全端末が停止する)。dispatch 直後 (同期) に行うのが正しい位置 — これにより「entity は消えたが appliedSeq が進んでいない」観測窓も消える。①′の処理中ガードは seq 待機ループの途中で立ててはいけない (待機中に fork が死ぬと誰もその request を処理できなくなる)。

## 設計ガイドライン

同期基盤の性質から導かれる、game action / reducer 設計のルール。

1. **action の repeat contract を自覚的に選ぶ** (ADR-0007): デフォルトは現在値に依存しない **set 型** (`toggle` ではなく `set({ key, value })`) とする。1 回しか実行できない操作は、2 回目を reducer の validation で拒否する **execute-once 型** にする。チャット投稿などの **無限実行型** も正当だが、同一 request の二重適用は機構が防ぐ一方、再クリック・retry による「同じ意図の別 request」は識別できない。実害があれば payload の一意 key で execute-once 化し、なければ UI debounce または繰り返しを許容する。CI では `synqux/testing` の mode 宣言つき table に全 action を載せ、set 型は `'idempotent'`、execute-once 型は `'rejects-repeat'`、無限実行型は `'repeatable'` の契約を検査する
2. **1 度しか発火しない自動 dispatch を作らない**: 取りこぼし前提の基盤のため、state 監視 + retry かユーザ操作起点にする
3. **判定系 action は入力のスナップショットを result / log に残す**: 「現在 state を見て判定する」action は、判定時点の入力を記録しておくと replay 再現なしで調査が終わる
4. **validation は reducer に集約し、`stateWithError` で表現する**: middleware や UI 側に成否判定を分散させない。reducer が唯一の判定器であることが同期の前提

## 改善ロードマップ

優先順。背景は既知の問題・設計ガイドラインを参照。

1. ~~**冪等性テストハーネス**~~ → **Phase 1 で対応済み** (`synqux/testing` の `assertActionIdempotency`)。consumer CI への組み込みが残タスク
2. ~~**既知の問題の修正**: ①の concat 評価固定 / ①′の処理中 Set ガード~~ → **Phase 1 で対応済み**。consumer 側の toggle 系 action の set 化は残タスク
3. ~~**host 採番の連番導入**~~ → **Phase 3 で対応済み** (ADR-0002)。②は機構ごと根絶
4. ~~**同時操作の負荷実測**~~ → **Phase 3 で対応済み** (`src/core/protocol-latency.test.ts`)。イベント駆動化後は直列 2ms/req・migration 回復 10ms (v1 比 ~96x / ~51x)
5. ~~**seq gap の検知・自動回復・consumer 通知**~~ → **sync health iteration 1 / 2 で対応済み** (ADR-0003 / ADR-0004)
6. **snapshot 書き込み削減**: 全量 JSON set を N request ごとなどへ (帯域コストが問題化してから。policy 点は `persistSnapshot` に隔離済み)

## Trouble Shooting: 同期不具合の調査手順

requests / game state の export があれば、端末ログなしで大半を確定できる。

**retention 導入後に requests export だけで遡れるのは「snapshot + 直近適用窓」まで**。既定の物理削除で運用する場合、全履歴が必要な事故調査では発生直後に export を取得すること。Firebase adapter の `archivePrunedRequests` を有効にした場合は、`logs/{groupId}` と `requests/{groupId}` の export を seq 順に結合すれば、prune 後も全量 replay 調査ができる。

1. **requests export と state export を取る** (`requests/{gameId}` と `games/{gameId}`。state は JSON 文字列として格納されている点に注意)
2. **まず requestedBy / responsedBy を見る**: 誰が操作し、誰が host だったか。複数プレイヤー交錯説・host migration の有無はここで数分で判定できる。`requested` と `responsed` (いずれも serverNow 基準、ADR-0008) の差で「依頼から裁定までの遅延」も export だけで確認できる
3. **封筒の `seq` を実適用順の正として使う**: push id 順や export の並びは信頼しない。seq 順で action を replay し、最終 state と一致するか確認する (一致すれば「記録された action が記録された順に 1 回ずつ適用された」ことが確定する)
4. **異常データの照合**: 同一 seq の複数 request (→dual-host 窓。epoch/responsedBy で勝者を判定)、responsedBy が無い request (→host 不在で滞留)、`result.type` を確認する
5. **ユーザ報告と突き合わせる**: UI は controlled で楽観更新なしのため、「画面に見えていた state」=「その端末の同期済み state」。request の payload は「ユーザが物理的に操作した対象」そのものなので、操作列から意図を復元できる
