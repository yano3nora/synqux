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
- xxx

### P1 — 本番境界と公開契約
- **0.15.0 release (breaking: TASK-260825) と導入 consumer の追従**。isSucceededAction / isMySucceededAction → state 述語 (isSucceededResult / isMySucceededResult)、stateWith* → with* rename。release (bump + publish) はユーザ判断・実行。consumer 側は locals の matcher 呼び出し 4 箇所を述語へ置換、synced extraReducers matcher の手書き hash 照合を `if (!isSucceededResult(state)) return` へ簡約 (誤った根拠コメントも修正)、rename やりきり
- xxx

### P2 — 文書・consumer 導入・コスト最適化
- **append-only response による transaction 撤廃の検証** (ADR-0029 の代替案、TASK-260905-respond-cas の計測より)。respond CAS (`runTransaction` + `applyLocally: false` + ack 後の自己反映) は正しさを storage が保証する代わりに、host の裁定が「1 件につき transaction 1 RTT の直列」に律速される (emulator 実測: main の CPU 律速 4ms に対し request→裁定 81ms、上限 ≈17 req/s。実網では概ね 1/RTT)。代替として response を request node のフィールド上書きではなく `responses/{requestId}/{responsedBy}` 相当の子ノードへ plain `set()` で追記し (何も上書きしないので「未裁定として観測した caller が保存済み response を置換する」経路が構造的に消える)、勝者は `responsed: serverTimestamp()` (RTDB が server 時刻へ置換) の先着 + responsedBy tiebreak で読み手が決定的に選ぶ。local echo が戻るため main と同じ 0 RTT 律速に戻る見込み。検証項目: (1) memory hub で同一 request 多重 response の畳み込みと先着決定の simulation test (遅れ host の昇格・dual-host 同時応答・changed drop)、(2) 封筒 schema v4 (複数 response の形、`parseEnvelope` / responseListener / 敗者再裁定 / prune・archive / snapshot fence の再整理)、(3) core の barrier / read-back / 自己反映がそのまま流用できるかの確認、(4) demo storm で main / CAS / append-only の 3 者比較 (手順は TASK-260905-respond-cas)。同一 ms 内の同時応答は tiebreak に落ちる (既存 dual-host トレードオフと同クラス) 点を SPEC に明記できるかも判断する。core 側の変更が transport 契約に閉じるなら 0.x minor で差し替え可能
