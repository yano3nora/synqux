# ADR-0002: host 採番 seq による順序判定への置き換え

- Status: **Accepted** (2026-07-05。レビューは「同期ゲームとして成立する状態」で branch ごと受ける方針のため、本 ADR は実装の設計記録として確定)
- Date: 2026-07-05
- 関連: ADR-0001 Decision 10 (Phase 3 送りの決定と前倒しの経緯は `TASK-260705-synqux-phase3.md`)

## Context

現行の順序判定は「push id (端末時計依存) の辞書順」を土台にしている。

1. **既知の問題②**: 時計がズレた端末の正当な request を `isDelayed` が誤ってドロップする。順序破壊を防ぐための意図的な割り切りだが、ユーザ操作が無言で消える
2. **revisions 配列の無限成長**: `includes` の線形走査と snapshot の肥大
3. prev チェーン待機は「参照の解決」であり、順序の全体像 (何番まで適用したか) を持たない

順序判定は Phase 1 で `src/core/ordering.ts` に隔離済みのため、差し替えの影響は core 内に閉じる (公開 API 無変更、Decision 10 の見立て通り)。

## Decisions

### 1. host が response 時に連番 seq を採番する

- 裁定印を `prev` (チェーン参照) から `(epoch, seq)` (連番) へ置き換える
- 全端末の適用規則は「`appliedSeq + 1` の seq を持つ envelope を適用する」だけになる
- **順序が request id (= 端末時計) と無関係になるため、`isDelayed` による意図的ドロップが不要になる**。遅配した request は落とされず、次の seq を貰って普通に適用される — ②の根治は「skew 耐性の向上」ではなく「ドロップという概念の消滅」
- validation 拒否 (error & console) の request も seq を消費する (適用列の ground truth に「拒否の記録」として残る、現行の revisions 記録と同等)

### 2. fencing は「epoch (host 世代) + responsedBy の決定的 tiebreak」

- host は昇格後の初回 response 前に **観測済み最大 epoch + 1** を自分の epoch とする (transport に原子カウンタを要求しない)
- dual-host 窓で異なる request が同一 seq を得た場合、全端末は `(epoch 降順, responsedBy 辞書順降順)` で勝者を決定する — 純粋関数なので全端末が同じ結論に達する
- **fencing の役割は分岐の「防止」ではなく「収束先の決定」と「再裁定の正当性判定」**。適用は現行同様の楽観 (seq が揃い次第適用) であり、dual-host 窓で端末間の適用列が一時分岐するリスクは現行の prev チェーン fork と同クラス (悪化しない)。完全防止は consensus を要するためクライアントホスト型の割り切りとして明文化する (SPEC 既知トレードオフへ)

### 3. requestListener fork の生存条件を「応答済みまで」から「適用済みまで」に延長する

- 現行は host が respond したら fork 終了 → dual-host の敗者 request は誰にも再処理されない
- 新: fork は「その request が適用されるまで」生存し、**自分が host かつ envelope の epoch が自 epoch 未満かつ未適用**なら新しい seq で再 respond する
- 「未応答 request の引き継ぎ」が「未適用 request の引き継ぎ」へ一般化され、敗者 request の救済が host migration の既存機構に乗る

### 4. ordering の永続状態は「カウンタ 2 つ + 直近適用の有限窓」

- snapshot 封筒の `ordering` を `{ revisions: string[] }` → `{ epoch, appliedSeq, applied: { [seq]: requestId } (直近 N=200 件) }` へ (無限成長の解消)
- **有限窓が必要な理由**: restore した端末は「seq ≤ appliedSeq の envelope」を見たとき、それが (a) 過去に適用済みの正史なのか (b) dual-host の敗者で再裁定待ちなのかを、カウンタだけでは区別できない。窓に id があれば (a)、なければ (b) として host が再裁定する。窓より古い敗者は救済対象外と割り切る (現行は敗者救済ゼロなので、有限窓でも純増の改善)
- Trouble Shooting 用の「適用順の記録」は封筒に焼かれた seq 自体が担う (requests export を seq 順に並べれば適用列が復元できる — revisions 配列より強い ground truth)
- セッション内の適用済み request id は従来どおりインスタンス内メモリで持つ (二重適用ガード)

### 5. restore の購読は「id フィルタ」から「seq フィルタ」へ

- 現行の `subscribeRequests({ after: 最終 revision id })` は id 辞書順フィルタであり、「id は古いが seq は新しい」request (skew 端末発) を取り逃がす — 現行では isDelayed が落とすので顕在化しなかった穴
- 新: **全量購読 + 受信側で「seq ≤ appliedSeq は破棄」**。correctness (取り逃しゼロ) を優先し、再取得コストは retention 契約 (snapshot 地点より古い requests は prune 可) の運用で抑える
- transport interface の `after` オプションは残すが core は使わない (prune 済み transport では実質同等)

### 6. wire format v2 / バージョニング

- `RequestEnvelope`: `prev` を削除、`epoch` / `seq` を追加。`SYNQUX_SCHEMA_VERSION = 2`
- v1 封筒との混在は既存の検出・拒否機構がそのまま働く
- npm は 0.2.0 (0.x の minor)。消費者ゼロのため移行パスは不要、テンプレは v2 形式へ一度で移行する

## Alternatives Considered

- **transport 採番の seq (RTDB transaction 等の原子カウンタ)**: 成否判定は host 必須のため順序だけ transport に移しても分散が増えるだけ。transport 契約も重くなる。却下
- **epoch の transport 原子採番**: 同上。観測 max+1 + tiebreak で決定性は足りる。却下
- **適用前 grace (高 epoch の envelope を待ってから適用)**: dual-host 分岐の緩和になるが、平常時のレイテンシを恒常的に悪化させる。分岐は現行同等クラスと割り切り却下

## Consequences

- ②の根治とともに「遅延 request の意図的ドロップ」が消えるため、SPEC の「設計上の割り切り」を書き換える (「1 度しか発火しない action 禁止」は push 失敗・切断がある限り at-least-once の一般則として残す)
- ordering interface の改訂に伴い、prevKey ベースの added 重複ガード (`acceptAdded`) は request id ベースへ簡素化される (prev 語彙の消滅)
- dual-host 窓の一時分岐が「あり得る」ことを SPEC 既知トレードオフに明文化する (現行にも存在したが prev チェーン fork として暗黙だった)
