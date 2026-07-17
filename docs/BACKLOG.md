# Backlogs — 未解決／積み残しタスク

> **Status: 常設 (クローズしない)**。未着手・保留・トリガー待ちのタスクを一元管理する唯一の置き場。
> 各 TASK の残項目はここに集約済みなので、過去 TASK を漁る必要はない。

## 運用ルール

1. 次の作業を始めるときは、ここから 1 件 pick して `TASK-YYMMDD-<slug>.md` を新規作成する
2. pick した項目は本ファイルから削除し、新 TASK へのリンクに差し替える
3. 新しい未解決事項が出たら、他の TASK には「BACKLOGへ追加」だけ書いてここへ追記する
4. ADR, SPEC の Open Questions と重複する項目は、決着時に ADR, SPEC 側も更新すること

## 次イテレーション候補

### response 欠落による seq gap の検知・自己回復

- **iteration 1 (検知 + health + consumer のリロード案内)**: → [`TASK-260718-sync-health-iteration1.md`](./TASK-260718-sync-health-iteration1.md) で対応済み (ADR-0003)
- **残スコープ — iteration 2 (自動回復)**: requests 再購読 → snapshot restore → 回復不能通知。二重 dispatch・巻き戻り・host migration 競合を simulation test で固めてから着手する

- **背景**: 移植元ゲームの実データ調査で、host では適用済みだが複数の非 host 端末が追従せず、リロード後に snapshot から回復した可能性が高い事象を確認した。現行 synqux でも、ある seq の response が端末へ永久配送されない場合、`appliedSeq + 1` 待ちで後続適用が停止する問題は既知トレードオフとして残る。詳細は `TASK-260714-origin-sync-incident-investigation.md`。
- **目的**: 一時的な遅配を誤検知せず、永久欠落時には画面全体のリロードより小さい単位で同期を回復できるようにする。
- **検討事項**:
  1. ~~gap の定義と検知条件を決める。単なる無通信ではなく「`appliedSeq + 1` が欠落したまま、より後続の seq を受信済み」を基本条件とする~~ → iteration 1 で対応済み
  2. 回復手段を、requests 再購読 → snapshot restore → consumer への回復不能通知、の段階制御にするか検討する
  3. 過去に最大約 1 分の transport 遅配が観測されている前提で、固定 timeout のみを correctness 判定に使わない
  4. 回復処理中の二重 dispatch、古い snapshot への巻き戻り、host migration / epoch 変更との競合を洗い出す
  5. transport interface や公開 API を拡張せず実現できるかを先に確認し、YAGNI に反する汎用イベント／プラグイン機構は追加しない
  6. ~~端末単位で `appliedSeq`、期待 seq、gap 開始時刻を観測できる最小限の診断手段を検討する~~ → iteration 1 の health で対応済み。再購読・restore の結果は iteration 2
- **必須テスト**:
  - 1 端末だけ特定 response を drop し、後続 response 到着後に gap を検出する deterministic simulation
  - dual-host 窓で敗者を先に適用した端末が「勝者未適用 + 再裁定 seq 破棄による恒久 stall」に入ることの再現 (SPEC-0001 の机上分析の裏取り)。当該端末が host 昇格した場合の群全体停止と、新規参加による解除も併せて再現する
  - 欠落 response の遅配では二重適用せず通常復帰する
  - 再購読または snapshot restore で全端末が同じ state / ordering に収束する
  - 回復中の重複配送、順序入れ替え、host migration でも各 request が高々 1 回だけ適用される
  - 回復不能時に無限 retry / reload loop を起こさない
- **完了条件**:
  - 採用方針と棄却案を ADR に記録する
  - 同期の不変条件または既知トレードオフが変わる場合は `SPEC-0001-requests-sync.md` を更新する
  - simulation test で障害と回復を決定的に再現する
  - 自動回復を実装しない結論の場合も、consumer がリロード案内へ切り替えるための検知境界と運用方針を明文化する
- **検討の方向性 (2026-07-17 考察)**:
  1. **iteration 1 で採用済み**: ordering の観測最大 seq が appliedSeq を超えたまま進まない状態を gap とする。fork 滞留数や envelope 不在は条件にしない (dual-host 早期適用では envelope が居座るため)
  2. **iteration 1 で採用済み**: 構造的 gap が T 継続するヒステリシス。T は通知条件であって correctness には使わない
  3. 段階回復は (a) requests 再購読 → (b) snapshot restore → (c) 回復不能通知。各段階は 1 回 + backoff で無限 loop を作らない。(b) は snapshot の appliedSeq が自端末以上のときだけ受理し、巻き戻りを禁止する
  4. (a) の既知の罠: `ordering.acceptAdded` の added 重複ガードが再購読の再配送を握りつぶす。再購読時は seenAddedIds のリセットか、responded 済み envelope を dedup 前に changed 経路へ回す変更が必要
  5. 現時点は firebase adapter に requests prune が無いため (a) で全量拾い直せるが、retention 導入後は「snapshot 地点より古いものだけ prune」の契約が (a) の成立条件になる (下記 retention 項と相互参照)
  6. **iteration 1 で採用済み**: `state.synqux.health` + selector + `synqux/react` hook。schema version 拒否・決定性検査失敗など他の異常系を載せる拡張は必要性が出るまで行わない
  7. **iteration 2**: (a)(b) の自動回復は二重 dispatch・巻き戻り・migration 競合のテストが揃ってから実装する

### requests の retention (prune) が未実装

- SPEC-0001 は「snapshot 地点より古い requests の prune」を transport の retention 契約として前提に書いているが、firebase adapter に prune 実装が無く requests は無限成長する
- 復帰時の全量購読コスト・帯域・メモリがセッション長に比例して増える。長時間セッション・request 頻度の高いゲームで実害が出る
- prune の主体 (host が snapshot 永続化後に古い requests を削除する等)、直近適用窓 (200)・敗者救済・gap 回復の再購読との整合、途中参加端末が「snapshot + prune 後の requests」だけで追いつけることを設計で保証する

### 切断・再接続の presence 再登録

- firebase SDK は WebSocket を自動再接続するが、切断中に onDisconnect が発火して connections entry が消えた場合、復帰後に自分を再登録する経路が無い。他端末からは不在のままで、host にも昇格できない
- connect() 後の `.info/connected` を監視しておらず、consumer がオフラインを検知する手段も無い (移植元事故調査 B の「購読断」仮説と同型の盲点)
- `.info/connected` の true 復帰時に presence を再 set + onDisconnect 再登録する (adapter 内で完結し core の API 拡張は不要の見込み)。オンライン状態を health (上記 gap 項の器) へ載せるかは併せて検討

### 多端末同時操作の stress simulation test (CI)

- memory hub 上で N 端末 × M request の並行送信 + fault 注入 (重複・遅延・drop・host 強制切断) をシード付き乱数で回し、収束後に全端末の synced state と適用列 (seq → request id) が一致することを検証する property test を CI へ追加する
- fixture は順序敏感な state (append + running hash 等) にする。可換な counter では順序バグが素通りする
- demo の手動 stress mode (TASK-260717-demo-stress) の CI 版に相当し、「当たり前に動く」ことの継続的な担保をこちらが担う
