# TASK-261003: snapshot-throttle-inspections

261003 snapshot 保存の間引き option と裁定到達の調査記録 (inspections)
===

## asis

- 移植元系列の consumer の本番で、host の上りに snapshot (全量 160KB) が積み上がり、同じ socket を通る respond が遅れて非 host 端末の反映が数秒遅れた。暫定措置として consumer 側で保存を 5 秒に 1 回へ間引いた
- synqux も「裁定ごとに全量保存」で、同じ閾値を持つ。`persistSnapshot` の await は裁定を塞がないが、socket の FIFO は変わらない
- 遅延を事後に測る記録がない。封筒の `responsed` は host 側の裁定時刻で、socket の待ちを含まない

## tobe

- `createSynqux({ snapshot: { throttleMs, flushOn } })` で保存を間引ける。既定は間引かない
- `createSynqux({ inspections })` 既定 on で、裁定ごとに `inspections/{groupId}/{requestId}` へ `{ requested, responsed (サーバ採番), responsedBy, epoch, seq, snapshotBytes }` を残す。`false` で omit
- transport 契約 19 `inspectResponse` (optional)。firebase / memory hub が実装する
- export だけで「option を使うべきか」を判定できる手順を SPEC に残す

## todo

- [x] `src/core/snapshot-throttle.ts`: leading + trailing + immediate + flush の間引き (instance 寿命、module 変数なし)
- [x] `src/core/types.ts`: `InspectionRecord`、契約 19、`inspectResponse?`
- [x] `src/core/create-synqux.ts`: `snapshot` / `inspections` option、保存 + 後処理を 1 run として間引き、commit 後の inspection 書き込み (session 一致時のみ)、teardown の flush (開始のみ、完了は待たない)、session 寿命の `lastSnapshotBytes` (UTF-8 byte 数)
- [x] `src/testing/memory-hub.ts`: `inspectResponse` / `inspect.inspections`
- [x] `src/firebase/index.ts`: `inspections/{groupId}/{requestId}` へ plain `set` (+ `serverTimestamp()`)
- [x] tests: `snapshot-throttle.test.ts` / `snapshot-policy.test.ts` / `inspections.test.ts` / firebase adapter の単体
- [x] docs: ADR-0030、SPEC-0001 (仕組み・トレードオフ・ロードマップ 6・Trouble Shooting)、SPEC-0002 (契約・机上検証表・exports)、README (Usage / API / firebase)
- [x] Codex レビュー 1 巡目の反映: flush は完了を待たない (ADR に明記)、inspection の session 一致検査、`lastSnapshotBytes` を session 寿命 + UTF-8 byte 数に
- [ ] consumer repo の cookbook に「間引きの判断と有効化」の節を足す (別 repo)

## testcases

- [x] 既定 (throttleMs 0) は裁定ごとに保存する
- [x] throttleMs: 先頭即時、window 内は最後の state だけ、全端末の適用は影響を受けない
- [x] flushOn の action は即時保存する
- [x] unsubscribe は保留分の書き込みを transport へ依頼してから切断する (完了は待たない)
- [x] trailing の commit で watermark が進み `fire: 'persisted'` が発火する
- [x] throttleMs の範囲外は生成時に throw する
- [x] inspections は commit 済み裁定ごとに 1 件、requested / responsedBy / epoch / seq / snapshotBytes が封筒と一致する
- [x] `inspections: false` と未実装 transport では残らず、同期は成立する
- [x] inspectResponse の失敗は裁定・適用・snapshot に影響しない
- [ ] firebase emulator で inspections の `responsed` がサーバ採番で入る (demo で目視)

## notes

### 計測 (移植元 consumer、emulator + host 上り 1Mbps 模擬)

| 条件 | 非 host 中央値 | 非 host 最大 |
| --- | --- | --- |
| 裁定ごと保存 / 300ms 間隔 | 3.5s | 19.6s |
| 5 秒に 1 回 / 300ms 間隔 | 15ms | 16ms |

host 自身は local write の即時反映で 10ms 前後のまま。上りを絞らなければ裁定ごと保存でも 12ms。

### 判断

- 既定で間引かない。理由: persisted listener の遅延と dual-host 窓の拡大を全 consumer に課す根拠がない (ADR-0030 Decision 2)
- inspections は prune しない。理由: 事故前の記録を残すのが目的で、1 件 100 byte 程度
- inspections は request node に同居させない。理由: 購読中 node へのサーバ採番値は changed を二重配送する
- 封筒の `responsed` は置き換えない。理由: transaction 内の `serverTimestamp()` は端末時計 + offset で解決され、`serverNow()` と同値になる
