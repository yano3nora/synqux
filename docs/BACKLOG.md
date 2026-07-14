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

- **背景**: 移植元ゲームの実データ調査で、host では適用済みだが複数の非 host 端末が追従せず、リロード後に snapshot から回復した可能性が高い事象を確認した。現行 synqux でも、ある seq の response が端末へ永久配送されない場合、`appliedSeq + 1` 待ちで後続適用が停止する問題は既知トレードオフとして残る。詳細は `TASK-260714-origin-sync-incident-investigation.md`。
- **目的**: 一時的な遅配を誤検知せず、永久欠落時には画面全体のリロードより小さい単位で同期を回復できるようにする。
- **検討事項**:
  1. gap の定義と検知条件を決める。単なる無通信ではなく「`appliedSeq + 1` が欠落したまま、より後続の seq を受信済み」を基本条件とする
  2. 回復手段を、requests 再購読 → snapshot restore → consumer への回復不能通知、の段階制御にするか検討する
  3. 過去に最大約 1 分の transport 遅配が観測されている前提で、固定 timeout のみを correctness 判定に使わない
  4. 回復処理中の二重 dispatch、古い snapshot への巻き戻り、host migration / epoch 変更との競合を洗い出す
  5. transport interface や公開 API を拡張せず実現できるかを先に確認し、YAGNI に反する汎用イベント／プラグイン機構は追加しない
  6. 端末単位で `appliedSeq`、期待 seq、gap 開始時刻、再購読・restore の結果を観測できる最小限の診断手段を検討する
- **必須テスト**:
  - 1 端末だけ特定 response を drop し、後続 response 到着後に gap を検出する deterministic simulation
  - 欠落 response の遅配では二重適用せず通常復帰する
  - 再購読または snapshot restore で全端末が同じ state / ordering に収束する
  - 回復中の重複配送、順序入れ替え、host migration でも各 request が高々 1 回だけ適用される
  - 回復不能時に無限 retry / reload loop を起こさない
- **完了条件**:
  - 採用方針と棄却案を ADR に記録する
  - 同期の不変条件または既知トレードオフが変わる場合は `SPEC-0001-requests-sync.md` を更新する
  - simulation test で障害と回復を決定的に再現する
  - 自動回復を実装しない結論の場合も、consumer がリロード案内へ切り替えるための検知境界と運用方針を明文化する
