# TASK-260905: respond-cas

260905 遅れ端末の host 昇格による確定済み response の上書き (P0) の修正
===

## asis

- TASK-260905-automation-chain の再現テスト (`it.fails`) で、裁定 (changed) が未着のまま host に昇格した端末が、その request を「未裁定」として再裁定し、前 host の確定済み response を上書きすることを確認した
- 原因は「裁定の書き込みに審判がいない」構造 (`respondRequest` が無条件 update) と、直列裁定ゲートが seq 付き entity にしか効かないこと
- 設計の選択肢 (transaction CAS / security rules CAS / catch-up barrier) と性能影響の整理は `~/Downloads/synqux-respond-cas-overview.md` (git 管理外) で行い、ADR-0029 に記録した

## tobe

- transport 契約 18: `respondRequest(id, patch, expected)` を観測済み response との CAS にし、棄却時は現在値を返す (memory hub / firebase `runTransaction`)
- core: 棄却時は `retractIssue` + read-back で追いつく。昇格した host は耐久化済み水位まで裁定しない (catch-up barrier)。水位を sync health の gap 証拠に数える
- 再現テストを合格へ転じ、drop 済み changed / snapshot 前の host 死の各経路を simulation test で固定する

## todo

- [x] `src/core/types.ts`: `RespondPatch` / `RespondExpectation` / `RespondOutcome` / `acceptsResponse`、契約 18
- [x] `src/testing/memory-hub.ts` / `src/firebase/index.ts`: CAS 実装 (firebase は `runTransaction` + `applyLocally: false`)
- [x] `src/core/create-synqux.ts`: `expected` の引き渡し、棄却時 read-back、catch-up barrier、health の水位証拠
- [x] `src/core/automations.test.ts`: `it.fails` を外す (再現テストが合格)。fixture `game/step` の拒否を静かにする (再発行の拒否は正常系)
- [x] `src/core/host-adjudication.test.ts`: 「snapshot 前の host 死 → CAS read-back」「barrier + health 再購読で追いつく」
- [x] `src/testing/memory-hub.test.ts` / `src/firebase/index.test.ts`: CAS の単体テスト
- [x] `src/core/recovery.test.ts`: barrier で dual-host 窓が閉じるため、誤認 host の snapshot を保留して窓を再現。gap 開始が早まる 1 件の中間 assertion を除去
- [x] docs: ADR-0029 新設、ADR-0010 補遺、SPEC-0001 (既知の問題・fork 記述・トレードオフ)、SPEC-0002 (契約・机上検証表)、BACKLOG P0 消込
- [x] Codex レビュー 1 巡目の反映: restore 再判定も水位を見る (`gapTargetSeq`)、`maxPersistedAppliedSeq` の分離、session 不一致時は `retractIssue` しない、firebase の null abort + `get()` 存在確認、`RespondPatch.result` の型、契約 13 依存の明記
- [x] Codex レビュー 2 巡目の反映: `ordering` の発行高水位と観測済み seq を分離 (`retractIssue` が gap 証拠を消さない)、昇格直後の snapshot 読み直し (`refreshHostWatermark`、契約 13 非依存化)、respond 放棄時の `retractIssue` も session 一致時のみ、firebase の `get()` 後に session 同一性を確認、ADR の firebase null 記述を修正
- [x] Codex レビュー 3 巡目の反映: barrier を best-effort と明記 (読み直しと裁定は非原子・load 失敗は fail-open。CAS の不変条件は barrier に依存しない)、読み直し中の降格は完了扱いにしない、ordering のコメント更新
- [x] npm run fix / npm test
- [x] **性能実測** (2026-09-05、localhost の RTDB emulator、Chrome 3 タブ、demo の dev 用 Redux middleware 込み。計測タブは前面固定、封筒の server 時刻から算出)

  | 指標 | main | respond-cas |
  | --- | --- | --- |
  | client の +1 click → 自端末反映 (ms, p50 / p90 / max, n=30) | 25 / 34 / 35 | 21 / 41 / 71 |
  | host の +1 click → 自端末反映 (ms) | 5 / 8 / 9 | 14 / 20 / 21 |
  | storm 200 (client 1 タブ発、約 11 req/s): request → 裁定 (ms, p50 / p90 / max) | 4 / 7 / 13 | 200 / 204 / 208 |
  | storm 中の host 裁定 service time (p50) | 送信率以下 (待ち行列なし) | 99 ms → 上限 ≈ 10 req/s |
  | 3 タブの収束 | 一致 | 一致 |

  - 単発の latency はほぼ同等 (host 自身の反映だけ local echo 消失ぶん +9ms)
  - **負荷時は裁定が直列に約 100ms/件で律速**され、約 10 req/s で定常の待ち行列 (≈2 件) ができて request→裁定が 200ms 一定になる。main は local echo で次の裁定に即進むため CPU 律速 (4ms)。原因は `applyLocally: false` により host が自分の裁定の適用 (= 次の裁定の直列ゲート解除) を server 経由の changed 到着まで待つこと
  - 対策候補: (a) ack 後に自分の凍結済み response を即時 `requestChanged` として自己反映する (ack = 耐久化済みなので幻の echo にならない。ADR-0029 の設計内で閉じる)、(b) security rules CAS (ADR-0029 Alternatives、`update()` と local echo が戻る)。release 判断はユーザ
- [x] 対策 (a) を実装: ack 後に凍結済み response を `ingestResponded` (read-back と共有) で自己反映し、直列ゲートを ack で解く (ADR-0029 Amendment)。host-adjudication に自己反映テスト追加。単独 host で配送待ちの窓を作っていた test は `holdAck` 併用へ、characterization の前提を更新
- [x] 対策 (a) 後の再計測 (同一 emulator インスタンスで main と A/B、手順は同上)

  | 指標 | main | respond-cas (自己反映前) | respond-cas (自己反映後) |
  | --- | --- | --- | --- |
  | client の +1 click → 自端末反映 (ms, p50 / p90 / max) | 29 / 46 / 85 | 21 / 41 / 71 | 29 / 40 / 42 |
  | host の +1 click → 自端末反映 (ms) | 5 / 6 / 9 | 14 / 20 / 21 | 21 / 26 / 28 |
  | storm 200 (約 11 req/s): request → 裁定 (ms, p50 / p90 / max) | 4 / 7 / 21 | 200 / 204 / 208 | 81 / 84 / 96 |
  | host 裁定 service time (p50) / 上限 | 待ち行列なし | 99 ms / ≈10 req/s | 58 ms / ≈17 req/s |

  - 自己反映で負荷時の request→裁定は 200ms → 81ms、上限は 10 → 17 req/s に改善。main (CPU 律速 4ms) には戻らない。残る 58ms/件は transaction の RTT + emulator の transaction 処理 + dev middleware の dispatch 分で、これが「裁定ごとに 1 RTT を直列に払う」代償
  - host 自身の単発反映は ack 後になるため main の 5ms に対し 20ms 前後。client の単発は同等
  - 受け入れ判断はユーザ。人間操作 (数 req/s) では差は出ない。bot storm 規模では 1/RTT 律速が効く
- [ ] 0.19.0 release (transport 契約の breaking を release note に明記。ユーザ判断)

## testcases

- [x] 遅れ端末昇格 (step-2 未着): 前 host の response 封筒が不変、追いつき後にチェーン完走
- [x] snapshot 前に前 host が死亡 + changed drop: 新 host の裁定が棄却され、read-back で count が追いつき、次の request を seq 2 で裁定
- [x] changed drop + snapshot 耐久化済み: 新 host は水位まで裁定せず、health の再購読で追いついてから裁定。health は ok に戻る
- [x] memory hub: 未裁定観測の置換を棄却して現在値を返す / 再送は冪等 / 敗者再裁定は受理 / 棄却時に changed を配送しない
- [x] firebase: updater の null / 未裁定 / 裁定済みの分岐、`applyLocally: false`、abort 時の current
- [x] changed 欠落 + 再購読の再配送も欠落: 水位を証拠に restore へ進み追いつく (recovery)
- [x] firebase: null abort → 実在しなければ Unknown request、実在すれば 1 度だけ再試行して commit
- [x] fence 購読なし adapter: 昇格時の読み直しで水位を知り、追いつくまで裁定しない
- [x] ordering: `retractIssue` は観測済み seq を残す / `maxSeenSeq` は発行と観測の max
- [x] firebase: `get()` 待機中の session 切替で再試行しない
- [x] 既存: dual-host 同一 request 応答の収束、ack 喪失の再送、recovery 4 シナリオ
