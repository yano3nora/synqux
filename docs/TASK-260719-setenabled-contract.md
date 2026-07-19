# TASK-260719: setEnabled (runtime on/off) の契約確認・明文化

- Status: **Done (2026-07-19)**

## やったこと

- 挙動確認: `setEnabled(false)` は送信ゲートのみ (移植元 `_prepareTutorial` と同一セマンティクス)。local 即時適用・永続化なし・受信/host 責務は継続、`setEnabled(true)` 復帰後も local 乖離は残る — を実挙動として確定
- simulation test: `src/core/set-enabled.test.ts` (送信ゲート / 受信継続と乖離残留 / 再 subscribe による正史復帰の 3 本)
- SPEC-0001 に「setEnabled の契約」節を追加
- README に tutorial How to (`setEnabled`) を追加。復帰手順は「リロード相当の再 subscribe で snapshot の正史へ戻す」を正とした

## レビュー対応 (codex)

- major: 「正史は local 乖離を知らない」は自端末が host の場合に誤り — off 中も host 責務は継続するため、乖離 state を土台に裁定・snapshot 保存され正史が汚染される (host 導出は peer pool の全端末合意で、端末 local な enabled では host 候補から外せない)。SPEC-0001 / README の記述を修正し、汚染シナリオの再現テストを追加 (a=15 / b=10 / 途中参加 c=15 で群内の state が割れる)

## 残項目

なし。挙動変更 (off 中の受信適用の抑止など) は行わない — buffering は seq gap を、適用スキップは health 回復による tutorial 中の snapshot 上書きを誘発し、host 候補からの除外は全端末合意を壊すため、現契約 (送信ゲートのみ + 利用前提の明文化) を採る
