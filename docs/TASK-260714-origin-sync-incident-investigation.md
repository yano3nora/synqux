# TASK: 移植元ゲームの同期不具合調査

- Date: 2026-07-14
- Status: Investigation complete (export 時点で確定できる範囲)
- Scope: 提供された Firebase game state / requests export と、ローカル参照実装の照合

## 目的

移植元ゲームで報告された次の 2 事象について、同期基盤に由来する可能性と synqux で必要な対策を整理する。

- A: phase 遷移用パスワードを入力できず、時間経過後のリロード後に操作可能になった
- B: action を押しても reaction が出ず、リロード後に reaction が表示された

提供データには実ゲーム・接続端末の識別子が含まれるため、本書には生値を残さない。

## 結論

### B: 端末側の response 未適用が最有力 (確度: 高)

対象とみられる action は、16:59:08 に host が `success` と裁定している。その後、同じ action が約 14 秒間に 6 回再 request され、すべて `error` になっている。

- 最初の request: 同一操作者、`success`
- 続く 5 request: 同一操作者、すべて `error`
- 最後の 1 request: 別操作者、`error`
- 最終 game state: 最初の action に対応する reaction が存在する

reducer は最初の成功時に action を `executed` にし、reaction と talks を生成する。正常に response を適用した端末では、同じ UI 操作は再度 `executeAction` を request せず、実行済み reaction のローカル閲覧へ分岐する。

したがって、この記録は次を強く示す。

1. 操作は transport へ到達した
2. host は一度だけ正常に適用し、snapshot も更新した
3. 少なくとも操作端末は response を Redux state へ適用できず、ボタンを未実行と表示し続けた
4. リロード時の snapshot restore により host 側 state を取得し、reaction が初めて画面に現れた

これは SPEC-0001 の既知トレードオフ「response の永久欠落による端末単位の stall。復旧はリロード」と整合する。端末ログがないため、欠落原因が Firebase イベント未配送、購読断、または response listener の待機停止のどれかまでは確定できない。

### A: Firebase export から原因確定はできない (確度: 低)

パスワードの文字列は component 内の React local state であり、正解後の submit で初めて phase 遷移 action が request 化される。Firebase にはキー入力・modal の開閉・input の focus 状態が記録されない。

確認できる事実は次だけである。

- 直前 phase の終了から約 2 分 10 秒後に、次 phase への遷移 request が 1 件発生した
- request は host に `success` と裁定され、最終 state にも反映された
- この区間で host 端末の識別子が変わっており、再接続または接続端末構成の変化とは整合する

ただし「入力不能」自体は同期 action 発行前の UI 事象なので、同期基盤が原因とは言えない。また「勝手にリロード」も、requests reset 監視、offline handler、画面固有 reload、外部の端末制御のどれが発火したかを export から識別できない。A を B と同じ同期 stall と断定するのは根拠不足である。

## export 全体から判明した同期異常

### 1. snapshot の revisions 二重記録が 5 回発生

- requests: 772 件
- final state の revisions: 775 件
- unique revisions: 770 件
- 5 request id がそれぞれ 2 回記録

これは移植元 v1 の既知の競合、すなわち response ack と `REVISIONS.concat(request.id)` の評価タイミングにより同じ revision を二重保存する問題が実運用でも発生した証拠である。synqux Phase 1 では評価固定により対策済み。

二重 revision は不正な記録だが、今回の B を直接引き起こしたとは確定できない。`includes` 判定自体は重複があっても成立するためである。

### 2. response されず revisions にも入らない request が 2 件存在

2 件とも空配列 payload の `removeBadges` で、前後の request は正常に処理されている。移植元 v1 の `onChildAdded` 重複 prev ガード、または遅延 request の意図的ドロップと整合する。

今回は実質的に state を変えない action だったため影響は見えないが、「request が無言で消える」機構が実データ上でも発生している。synqux Phase 3 の host 採番 seq では request id / Firebase prev に依存するドロップ機構を廃止済み。

### 3. host はセッション中に複数回交代

requests の `responsedBy` は複数端末に切り替わっている。host migration 自体は仕様だが、B の直前にも host が交代しているため、購読再開・端末離脱境界を含む可能性はある。ただし connection/presence export がないため因果関係は確定できない。

## synqux への示唆

今回観測された v1 固有の二重 revision と request ドロップは現行 synqux で対策済み。一方、B と同型の「ある seq の response を端末が永久に受け取らず、後続が待機し続ける」は現行 SPEC でも既知トレードオフとして残る。

synqux で行う検討・対応は `BACKLOG.md` の「response 欠落による seq gap の検知・自己回復」へ集約した。A の UI 入力不能は同期処理より手前の consumer / 端末側事象であり、synqux の BACKLOG には含めない。

## 追加データがあれば確定できること

- 事象発生端末の console / telemetry: B の停止位置と A の reload 発火元
- connections / presence export: host migration と再接続時刻
- Firebase client の connected 状態 (`.info/connected`) の履歴: transport 切断の有無
- 報告時刻と操作者の対応表: 16:59 台の action が B そのものかの最終確認

## 非結論

- A と B が同一原因だとは証明できない
- 最終 state が正しいことは、全端末が途中も正しかったことを意味しない
- requests に response があることは、各端末で response が適用されたことを意味しない
- Firebase export だけでは UI event loop、focus、overlay、ブラウザ reload 理由は観測できない
