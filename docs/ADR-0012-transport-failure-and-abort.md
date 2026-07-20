# ADR-0012: transport 失敗通知と接続確立待ちの中断

- Status: **Accepted** (2026-07-20 実装)
- Date: 2026-07-20
- 関連: ADR-0003 (sync health), ADR-0004 (自動回復と unrecoverable), ADR-0009 (trust model — 深い入力検証は対象外), BACKLOG P1「wire / adapter 境界の失敗系を整える」

## Context

wire / adapter 境界に「失敗をどう伝えるか」の契約がなく、本番の失敗モードが consumer から観測不能だった。

1. **購読の黙殺死**: RTDB の `onChildAdded` / `onValue` に cancel callback (第 3 引数) を登録しておらず、permission denied で購読が打ち切られても SDK の console warning が出るだけで core は「静かで正常」と誤認する。gap も観測しないため sync health の stalled 判定すら発火しない。consumer が本番 rules を初めて書く導入時に踏みやすい
2. **offline 起動の無期限ハング**: connect は `.info/connected === true` を無期限に待つため、圏外・スリープ復帰・captive portal での起動は `subscribe()` が resolve も reject もしない「無限ローディング」になる。スマホゲームではこれは例外系ではなく日常系
3. **transport 契約に失敗通知チャネルが存在しない**: (1) を検知しても core へ伝える口が `SynquxTransport` にない
4. groupId に RTDB key 禁止文字 (`/` 等) が混入した場合のガードがない (これは trade-off のない入力検証漏れ)

## Decisions

### 1. 購読打ち切りは handlers の `onError` で通知する (契約 8)

- `subscribePeers` / `subscribeRequests` の handlers に `onError?(error: unknown): void` を追加する
- adapter は購読が**回復不能に**打ち切られたとき (permission denied 等) に発火する義務を負う。一時的な切断は adapter / SDK の自動再接続で吸収し、onError にしない (RTDB では cancel callback まで来る切断はほぼ permission 起因のため、致命/一時の区別は adapter 層で不要)
- optional なのは caller 都合 (テストの購読等)。**渡された onError の発火は adapter の義務**であり、core は常に渡す。required にしても型で強制できるのは caller 側だけで、肝心の「adapter が発火する義務」は型で守れないため、契約文書で課す

### 2. core は打ち切りを `unrecoverable` health にし、以後の判断を consumer へ委ねる

- onError 受信で health を `phase: 'unrecoverable'` にする。既存の `selectIsSyncUnrecoverable` / `useIsSyncUnrecoverable` がそのまま検知手段になる (新 API を増やさない)
- **自動リトライしない**: permission denied は rules を直すまで何度購読し直しても失敗する。バックオフ付きリトライは「直るまで無限に失敗し続けるループ」にしかならず、correctness を増さない (ADR-0004 の「1 巡で止める」と同じ思想)
- health heartbeat は打ち切り検知後、gap の有無 (maxSeen <= applied の ok 巻き戻し) より優先して unrecoverable を維持する。回復手段は consumer による unsubscribe → 再 subscribe のみ

### 3. 接続確立待ちの打ち切り責務は AbortSignal で consumer に渡す

- `subscribe()` と transport `connect()` が `signal?: AbortSignal` を受け取る。**省略時は無期限待機 (現行維持)**
- timeout を synqux に内蔵しない理由: firebase SDK は自動再接続するため、無期限待機には「圏外から復帰したら無操作で繋がる」利点がある。一律 timeout は復帰直前に諦める退化を生み、待機 UX (対戦ロビーは早く諦める / 放置ゲーは待ち続ける) はゲームデザインの領分。synqux は中断の機構だけ提供し、`AbortSignal.timeout()` 等の政策は consumer が選ぶ
- abort 時の契約: connect は速やかに reject し、**登録済み presence を残さない**。core は初期化の各 await 境界で abort を検査し、既存の transactional subscribe rollback で後始末する。subscribe 完了後の signal は作用しない (unsubscribe を使う)

### 4. groupId は Firebase adapter の入口で拒否する

- RTDB key 禁止文字 (`. # $ / [ ]`・制御文字) と空文字を connect 冒頭で明示的に reject する。禁止文字は firebase 固有のため、ガードは core ではなく adapter に置く

## Out of scope

- **封筒 (request / snapshot) の深い入力検証**: ADR-0009 の trust model どおり cheat / tamper 耐性は提供しない。schema version 不一致の明示拒否 (既存) までとする
- **pushRequest / respondRequest / saveSnapshot の実行時失敗**: 既存の凍結再送・prune スキップ (ADR-0010 / 0011) の範疇であり本 ADR では変更しない
- **onError の致命/一時分類**: 将来、一時的エラーを通知したい transport が現れた時点で契約を拡張する (YAGNI)

## Consequences

- transport 契約変更 (handlers への onError 追加・connect signal) は 0.3.0 (未リリース) に含め、breaking の追加コストをゼロにする
- memory hub に `faults.cancelSubscriptions(peerId)` を追加し、購読打ち切り → unrecoverable → 再 subscribe 回復を deterministic simulation で検証する (`src/core/transport-failure.test.ts`)
- consumer 側の受け入れ UI (unrecoverable 表示・再接続導線・接続 timeout 政策) は各ゲームの責務。rules checklist (BACKLOG P2) とセットで導入ガイドに記載する
