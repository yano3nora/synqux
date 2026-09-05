# Backlogs — 未解決／積み残しタスク

> **Status: 常設 (クローズしない)**。未着手・保留・トリガー待ちのタスクを一元管理する唯一の置き場。
> 各 TASK の残項目はここに集約済みなので、過去 TASK を漁る必要はない。

## 運用ルール

1. 次の作業を始めるときは、ここから 1 件 pick して `TASK-YYMMDD-<slug>.md` を新規作成する
2. pick した項目は新 TASK へのリンクに差し替え、完了したらリンクごと項目を削除する
3. 新しい未解決事項が出たら、他の TASK には「BACKLOGへ追加」だけ書いてここへ追記する
4. ADR, SPEC の Open Questions と重複する項目は、決着時に ADR, SPEC 側も更新すること

## 次イテレーション候補

### P0 — 実践投入ブロッカー
- **遅れ端末の host 昇格による確定済み response の上書き** (TASK-260905-automation-chain で発見。再現: `src/core/automations.test.ts` の `it.fails`)。裁定 (changed) が未着の request を新 host が「未裁定」とみなして再裁定し、`respondRequest` が無条件 update のため、自分が観測していない前 host の確定済み response を新 epoch で上書きする (ADR-0010 Decision 1 の侵害。守るべき不変条件は「未裁定として観測した caller は保存済み response を置換できない」で、観測済み敗者の正当な再裁定とは区別する)。added の到着順が前 host と違えば seq の付け替えと success→error の差し替えが起き、適用済み端末と snapshot が恒久分岐する (移植元系列 consumer の「終了後に host が遅れ端末へ移り巻き戻る」issue と同型)。案: `respondRequest` を「caller が観測している response (未裁定なら『なし』、敗者再裁定なら旧 response) と保存値が一致するときだけ書き込む」CAS にする (契約 7 の snapshot fence と同型。firebase は `runTransaction`)。`(epoch, seq)` の辞書順比較では新 host が高い epoch を発行する再裁定を防げないため不可。棄却時は保存済み response を返し、core はそれを changed 相当として即時反映する (元の changed が drop 済みだと到着待ちでは永久停止し、seq 未着 entity は gap recovery にも掛からないため)。同一内容の再送 (ADR-0010 Decision 2) は成功扱い。dual-host 敗者の再裁定は旧 response を expected に渡すため通る

### P1 — 本番境界と公開契約
- **0.15.0 release (breaking: TASK-260825) と導入 consumer の追従**。isSucceededAction / isMySucceededAction → state 述語 (isSucceededResult / isMySucceededResult)、stateWith* → with* rename。release (bump + publish) はユーザ判断・実行。consumer 側は locals の matcher 呼び出し 4 箇所を述語へ置換、synced extraReducers matcher の手書き hash 照合を `if (!isSucceededResult(state)) return` へ簡約 (誤った根拠コメントも修正)、rename やりきり
- xxx

### P2 — 文書・consumer 導入・コスト最適化
- xxx
