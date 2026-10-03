# ADR-0030: snapshot 保存の間引き policy と裁定到達の調査記録 (inspections)

- Status: **Accepted** (2026-10-03 実装。経緯は `TASK-261003-snapshot-throttle-inspections.md`)
- Date: 2026-10-03
- 関連: ADR-0001 Decision 11 (snapshot policy 点の隔離), ADR-0005 (retention), ADR-0011 (snapshot fencing), ADR-0021 (`fire: 'persisted'` / checkpoint), ADR-0029 (respond CAS), SPEC-0001 改善ロードマップ 6

## Context

移植元系列の consumer (旧同期基盤) の本番で「操作を続けると参加者全員の反映が数秒遅れる。リロードすると軽くなる」が起きた。調査の結論は次のとおり。

1. host は裁定ごとに synced state 全量 (約 160KB) を snapshot として保存していた
2. snapshot と respond は同じ WebSocket を FIFO で流れる。host の上りが詰まると respond が snapshot の後ろに並び、非 host 端末の反映が遅れる
3. host 自身は local write の即時反映で遅れを感じない。リロードした端末は最後に接続した端末として host になるため「本人だけ軽くなった」と感じる
4. emulator で host の上りを 1Mbps に絞ると、300ms 間隔の裁定で非 host の反映が中央値 3.5 秒・最大 19.6 秒になった。保存を 5 秒に 1 回へ間引くと 15ms に戻った

synqux も「host は request を 1 件処理するたびに全量を永続化する」(SPEC-0001) 構造を持ち、同じ閾値を持つ。`persistSnapshot` の await は裁定を塞がない (ADR-0011 Performance notes) が、**詰まる場所は await ではなく socket の FIFO** であり、非同期化では解決しない。SPEC の改善ロードマップ 6 は「帯域コストが問題化してから」としていたが、その条件は満たされた。

一方で、現行 consumer の synced state は 5KB 級で、問題化の閾値 (snapshot サイズ × 裁定レート ≳ 上り帯域) から遠い。間引きには代償 (後述) があり、全 consumer に既定で課す根拠はない。「いつ間引くべきか」を事後に判定できる記録が無いことが、設計上の穴である。

## Decisions

### 1. snapshot 保存 policy を `createSynqux({ snapshot })` で指定可能にする (既定は間引かない)

- `snapshot.throttleMs` (既定 0): 保存を window 内 1 回へ間引く。先頭は即時保存し、window 内の後続は最後の state だけを window 終了時に保存する (leading + trailing)。連続して裁定が続いても waitMs ごとに 1 回に保つ
- `snapshot.flushOn(action)`: 間引き中でも即時保存する action の述語。期の確定・phase 遷移など「復帰点にしたい裁定」を consumer が指定する。即時保存は保留分を破棄して window を張り直す
- policy 点は ADR-0001 Decision 11 のとおり `persistSnapshot` の呼び出し側に隔離する。保存と後処理 (persisted watermark 更新・prune) は 1 つの run として間引き、**後処理は実際に commit した run の orderingState でのみ走る**。trailing の保留中に捨てられるのは古い state だけで、prune 線が snapshot を追い越す経路を作らない
- unsubscribe は保留中の run を flush (書き込みを開始) してから切断する。host が普通に退室したときに最新の復帰点を残す。完了は待たない — 従来の裁定ごと保存も teardown は待っておらず、offline の firebase では `set` が settle せず teardown を塞ぐため。旧 host の遅延書き込みは引き続き fence が棄却する (ADR-0011) ため、間引きのために新しい審判は要らない
- 上限は `fire: 'persisted'` の drop 上限 (30s) の半分未満。persisted listener の発火は耐久化水位を待つため、window 分だけ遅れる。drop 上限に近い window は「発火しない」を常態化させるので生成時に拒否する

### 2. 既定で間引かない理由 (代償の明文化)

- **persisted listener の遅延**: `fire: 'persisted'` の effect は window 分遅れる。reset 通知などの終端 effect が数秒遅れることを consumer が受け入れる必要がある
- **dual-host 窓の拡大**: 窓は「相手 host の snapshot が耐久化される前」に狭まる (SPEC-0001 既知トレードオフ)。間引くと耐久化が遅れ、窓が window 分だけ伸びる。正史は壊れないが、同一 seq 衝突で stall する端末が増える方向
- **復帰時の再適用量の増加**: restore は snapshot 以降の responded 済み request を再適用して追いつく。間引いた分だけ再適用が増えるが、retention は snapshot の ack 後にしか prune しない (ADR-0005) ため復元不能にはならない
- 現行 consumer の state サイズでは利益が代償を下回る。閾値を越える group だけが option で有効化する

### 3. 裁定到達の調査記録 (inspections) を既定で残す (transport 契約 19)

- host は respond の commit 後、snapshot の保存より先に `transport.inspectResponse(id, { requested, responsedBy, epoch, seq, snapshotBytes })` を fire-and-forget で呼ぶ。adapter は `responsed` をサーバ採番時刻で付けて永続化する
- 測る区間は `responsed - requested` = 「request 登録から裁定のサーバ到着まで」。socket 上で直前 snapshot の後ろに積まれるため、host の上りの待ちを含む。非 host の適用までは含まない (download 側で、今回の計測では 10ms 台)
- `snapshotBytes` は直前に commit した snapshot payload の UTF-8 byte 数 (session 寿命)。`snapshotBytes × 裁定レート` が上り帯域に対してどこまで来ているかで、option の要否を遅延が出る前に予測できる
- `createSynqux({ inspections: false })` で omit する。`inspectResponse` を持たない transport では黙って skip する。失敗は握りつぶし、裁定・適用・snapshot に影響させない
- **request node には書かない**。購読中の node へサーバ採番値を書くと、書き手には推定値と確定値で changed が 2 回届く。二重配送は core が捨てられるが、意味のない配送を全端末に増やす理由がない。firebase は `inspections/{groupId}/{requestId}` へ plain `set()` する
- **prune しない**。1 件 100 byte 程度で、事故前の記録を残すことが目的。物理削除は connections / channel 'none' と同じく consumer の data lifecycle

### 4. 既存の `responsed` は置き換えない

封筒の `responsed` (ADR-0008) は host 側で `serverNow()` を裁定時に評価した値で、socket の待ちを含まない。respond が transaction (ADR-0029) である限り、封筒側にサーバ到着時刻は刻めない — RTDB の transaction 内 `serverTimestamp()` は SDK が送信前に端末時計 + offset で解決するため、`serverNow()` と同じ値になる。測りたい区間が違うので、封筒の `responsed` は「裁定の時刻」として残し、到着時刻は別記録 (inspections) に持たせる。

## Alternatives considered

- **保存を非同期化するだけ (現状)**: 裁定は塞がないが、socket の FIFO は変わらない。本 ADR の Context で実測により否定
- **既定で間引く**: Decision 2 の代償を全 consumer に課す。現行 consumer は閾値から遠く、根拠がない
- **N 裁定ごとに保存**: 裁定レートが低い group では復帰点が古くなり続ける。時間 window は「静穏時は毎回、burst 時だけ間引く」になり、挙動が予測しやすい
- **snapshot の diff 化 / state 分割**: 1 回の重さ自体を減らす根本策だが、封筒形式と restore の設計変更になる。間引きは回数を減らすだけで、state が 100KB 級の consumer が現れた時点で別途要る (BACKLOG へ)
- **inspections を封筒へ同居**: respond が transaction のため到着時刻を刻めず (Decision 4)、plain update で後追いすると changed の二重配送を作る
- **inspections を sync health の端末メモリ指標にする**: 永続化されず、事後調査に使えない。集計値の送信は consumer の責務として残す

## Consequences

- transport 契約に optional method `inspectResponse` (契約 19) を追加。既存 adapter は未実装でも動作が変わらない (0.x minor)
- `CreateSynquxConfig` に `snapshot` / `inspections` を追加。既定値は現行挙動 + inspections on
- firebase の data 配置に `inspections/{groupId}/{requestId}` が増える。consumer の data lifecycle (group 破棄時の削除) に含める
- memory hub に `inspectResponse` と `inspect.inspections(groupId)` を追加し、simulation test で policy と記録を固定する
- SPEC-0001 Trouble Shooting に inspections の読み方と閾値の目安を追加する
