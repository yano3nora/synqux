# TASK-260813: 配達済み synced action matcher

## 目的

consumer が synqux の meta 契約を直接解釈せず、dispatch 前の action と host 裁定後に全端末へ配達された action を区別できるようにする。あわせて、既存 envelope の裁定情報を action meta から調査できるようにする。

## 設計

- `isDeliveredSyncedAction(action)` を core の公開 API として追加する
- envelope の `requestedBy / requested / responsedBy / responsed / epoch / seq` を正とし、通信形式を増やさず host 試し実行と実配達の action meta へ同値で投影する (`requested` は既存名 `dispatched` へ対応)
- request / response 系 6 フィールドが揃えば配達済みと判定し、type guard で meta の型も絞る
- matcher 単体では action type を判定しない。consumer 固有の synced domain 判定とは consumer 側で組み合わせる
- standalone の直接適用 action は request 経路を通らないため false とする
- response 系 meta は middleware / listener / DevTools / log 向けの診断情報として公開する。dual-host 窓では裁定候補ごとに異なり得るため、synced reducer のゲーム判定には使わない

## タスク

- [x] matcher と unit test を追加
- [x] host 試し実行と実配達へ同じ裁定 meta を注入
- [x] 決定性テストで `result.action.meta` の一致を固定
- [x] root entrypoint から export
- [x] 公開 API 仕様を更新
- [x] `npm run fix` / `npm test` (32 files / 318 tests)
