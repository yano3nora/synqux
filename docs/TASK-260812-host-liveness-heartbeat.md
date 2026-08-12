# TASK-260812: host liveness heartbeat による脱落 host の自動降格

- 目的: 「host 端末のブラウザが非アクティブ放置され、presence 上は生存したまま room 全体が停止する」不具合の恒久対策。host の生存を heartbeat で可視化し、沈黙した host を **他端末が観測して guest へ降格**させることで、既存の host migration に自動で落とす
- 背景: 現状の host 導出 (`deriveHostId`) は presence の pool 変化にのみ反応するため、「接続は生きているが JS が止まっている host」を検知できない。運用 (2 窓禁止アナウンス・リロード案内) で回避しているが根絶できていない
- 決定事項は ADR-0016 (新規) に、機構の変更は SPEC-0001 に反映する

## Phase A — 停止の真因計測 (time-box: 半日)

heartbeat 設計の前提数値を実測で決める。真因の完全特定が目的ではなく、**stale 閾値の根拠づくり**が目的。

### A-1. 実運用 incident の requests export 確認 (コード変更なし)

- 停止が報告された room の requests export を seq 順に確認する (SPEC-0001 のデバッグ手順)
- `responsedBy` の無い request が滞留していれば「host が裁定していなかった」ことが確定する
- `requested` の時刻分布から「停止の開始時刻」と「host が最後に裁定した時刻」の差を記録する

### A-1. 結果 (260812 記入)

実運用 incident (v1 世代・seq 導入前の同期基盤) の requests export 431 件 (約 110 分間) を分析した。export は事後取得のため全件 responsed 済みだが、`responsed - requested` の遅延分布に停止がそのまま残っていた。

- **停止の実像**: 15:00 前後の 5 分バケットで裁定遅延の中央値が **約 304 秒** (n=77、通常時は 200-400ms)。100 秒超待たされた request は 49 件で、体感停止は約 10 分間 (15:00〜15:10)
- **throttling のシグネチャ**: 完全沈黙の直前、**同一 host のまま裁定列に 60 / 71 / 60 秒のギャップ**が連続して現れた。これは background tab の timer throttling (約 1 分粒度) と一致する。v1 host は polling 駆動のため、throttle 下では約 1 分間隔の断続動作になっていた
- **停止と自然回復**: host は 15:03:22 に完全沈黙し、107 秒後の 15:05:09 に migration で別端末へ移った。しかし**次の host も 15:10:36 から 279 秒沈黙して再度 migration** しており、非アクティブ host への移譲が連鎖する二次被害も確認できた
- **切り分けへの示唆**: host が裁定しない間も request は書き込まれ続けていた = transport と他端末は健在。止まったのは host タブの JS 実行のみで、報告内容と一致する

導かれる設計値: throttle 下でも JS は約 60-70 秒間隔で走れていたため、**heartbeat はthrottle 下でも書ける**見込み (A-2 で現行アーキテクチャでの実証が必要)。`staleThresholdMs` はこの粒度を十分上回る **180 秒を仮置き**とする。この incident に当てはめると、沈黙 3 分で確定的に demote され、体感 10 分 (自然回復依存) が約 3 分に短縮される。連鎖した 2 回目の停止 (279 秒沈黙) にも同様に働く。

留意: v1 は polling 駆動だったが現行 synqux は event-driven のため、「throttle だけで裁定が止まるか」は現行では再現しない可能性がある (その場合、対策対象は freeze / ゾンビ接続に絞られ、heartbeat の有効性は変わらない)。A-2 の rig で現行の挙動を確認する。

### A-2. 再現 rig (demo + firebase emulator)

計測コードは **`demo/rig.ts` に実装済み (260812)**。`?rig=1` で有効化し、in-memory ring buffer に記録して Dump ボタンで JSON をダウンロードする。観測点: chained timer の実発火間隔 (`tick`)、Page Lifecycle (`lifecycle`)、`.info/connected` 遷移 (`connected`)、Redux middleware 経由の synqux 内部 action 到着 (`action` = transport 配送の生死)、30 秒ごとの serverTimestamp 書き込み probe (`hb-*` = heartbeat 最悪間隔の直接測定)、host 状態遷移 (`host`)。guest 側は `&probe=30` で 30 秒ごとに `dispatchAndWait` の裁定 latency (`probe-*`) を記録し、probe ごとに peers 一覧も残す (presence 残存の観測)。

- 実行手順:
  1. `npm run demo:emulator` と `npm run demo` を起動する
  2. host タブ: `http://localhost:5173/?rig=1`、guest タブ (別ブラウザ推奨): `http://localhost:5173/?rig=1&probe=30`
  3. 再現操作 A: host タブを hidden にして 5 分以上放置 (intensive timer throttling の発動)
  4. 再現操作 B: `chrome://discards` で host タブに Toggle freeze (tab freeze の人為再現)
  5. 各操作後に host タブへ復帰し、両タブの Dump rig log で JSON を回収する

### A-3. 判定と出力

| 復帰後のログ所見 | 判定 |
| --- | --- |
| 全イベントに時間ギャップ (tick も transport 受信も止まる) | tab freeze (JS 完全停止) |
| tick は間引かれるが transport 受信・裁定は継続 | throttle のみ (停止の真因は別にある) |
| host の JS は動くがイベント未達、guest から presence は残存 | ゾンビ接続 |

- 出力: 判定結果、**throttle 下での timer 最悪発火間隔** (heartbeat 閾値の根拠)、freeze 中の presence 残存時間。数値は本 TASK に追記する

### A-2 / A-3. 結果 (260812 記入)

rig 実測 (Chrome / macOS、emulator、host + guest probe 30 秒間隔) の結論:

**hidden 放置 (約 5 分)** — 判定: **throttle のみでは現行 synqux は止まらない**

- intensive timer throttling を確認: hidden 約 2 分後から chained timer / heartbeat probe とも **約 60 秒粒度** に間引かれた (実測 60.0 / 60.0 / 61.6 / 62.3 秒)
- 一方、**裁定は無影響**: hidden 中の host は guest probe を中央値 95ms / 最大 162ms で裁定し続けた。transport のメッセージ受信イベントは timer throttling の対象外のため。**v1 (polling 駆動) の「1 分粒度の断続動作」は event-driven 化で既に構造的に解消されている**ことの実証
- **heartbeat の実現可能性を確認**: intensive throttling 下でも serverTimestamp 書き込みは最悪 62.3 秒間隔で成功し続けた (ack latency は数十 ms)

**tab freeze (`chrome://discards`)** — 判定: **freeze で incident と同じ形が再現**

- freeze 後の probe は `requestAdded` (transport への書き込み) まで成立するのに裁定が返らず、dump 時点まで 21 秒以上未裁定。**その間、凍結 host の presence は peer pool に残存**しており、migration は起きない。「host が沈黙したまま presence だけ生きる」という報告どおりの症状が現行アーキテクチャで再現した
- 凍結タブは復帰時に discard → reload され**別 peer として再参加**した (rig の in-memory ログも消失)。旧 presence がどれだけ残存するかは今回の窓 (約 1 分で人為復帰) では測り切れなかったが、残存時間がいくらであれ observer demote の対象になるため設計は変わらない

**確定した設計値**: `heartbeatIntervalMs` = **30_000** (実測で throttle 下も維持可能・ack 数十 ms で安価)、`staleThresholdMs` = **180_000** (throttle 下の heartbeat 最悪間隔 62.3 秒の約 3 倍マージン)。完了条件 1 は達成

## Phase B — heartbeat + observer demote (草案)

### 設計コンセプト

- **heartbeat**: host だけが presence の `lastSeenAt` をサーバ時刻で定期更新する (全 peer が書くと write 帯域の無駄。host 以外の生存は同期の成立に関与しない)
- **observer demote**: stale な host を観測した**他端末**が、その peer の role を `guest` へ書き換える。pool の変化として全端末へ配送されるため、host 再導出は既存の migration 機構そのまま
- `deriveHostId` は **peer pool の純粋関数のまま変えない**。time-aware 化 (各端末が local に stale 除外する案) は、端末ごとの時刻観測差で「全端末が同じ host に合意する」成立条件が閾値境界で恒常的に割れ得るため不採用。demote は transport 上の事実になるので合意メカニズムを保てる
- 降格による migration は既存機構と同一のため、epoch fencing・敗者再裁定・snapshot fencing はそのまま効く。旧 host がゾンビ解凍しても遅延書き込みは棄却される (ADR-0011)

### 変更点

1. **`Peer.lastSeenAt?: number`** を追加 (serverNow 基準。`connected` と同様に transport がサーバ時刻を焼く)
2. **transport 契約の拡張** (`src/core/types.ts` の Transport):
   - `heartbeat(): Promise<void>` — 自 peer の `lastSeenAt` をサーバ時刻で touch する
   - `demotePeer(id: Peer['id']): Promise<void>` — 対象 peer の role を `guest` へ書き換える (自 peer 以外への唯一の書き込み。非敵対クライアント前提 (ADR-0009) の範囲内)
3. **core (create-synqux)**:
   - 自端末が host の間、`heartbeatIntervalMs` (既定 30_000。A-2 実測で確定) ごとに `heartbeat()` を呼ぶ。失敗は握りつぶして次回 retry (automations engine と同じ政策)
   - 全端末は「周期 tick + peer 変化イベント」で stale 判定を評価する: `now - (host.lastSeenAt ?? host.connected) > staleThresholdMs` なら `demotePeer(hostId)`。`lastSeenAt` 未記録の新 host は `connected` を起点にする (migration 直後の誤検知防止)
   - **候補不在ガード**: demote 後の pool で `deriveHostId` が undefined になる場合は demote しない (host 不在の完全停止は元の症状より悪い)
   - 複数端末の同時 demote は同値書き込みで冪等。demote の再発はしない (role が guest に変わった時点で stale 判定の対象外)
   - **実装時の変更 (260812 実装済み・ADR-0016)**: (a) 評価は `heartbeatIntervalMs` の周期 tick のみとし「peer 変化イベント」での再評価は入れない — staleness は時間経過でしか進行せず、イベント駆動の再評価は検知を早めないため。(b) 観測ヒステリシスを追加 — observer は「現在の host を観測し始めてから閾値経過」まで判定しない。一度 host を降りた端末が古い `lastSeenAt` のまま再昇格した直後の誤 demote を防ぐ。stale 判定も `max(lastSeenAt ?? 0, connected)` 起点とする。(c) `staleThresholdMs < heartbeatIntervalMs * 2` は createSynqux が生成時に throw する
4. **設定値** (`CreateSynquxConfig` へ追加、SPEC-0002 に転記):
   - `hostLiveness?: { heartbeatIntervalMs?: number; staleThresholdMs?: number } | false` — `false` で機能ごと無効化。既定値は `heartbeatIntervalMs: 30_000` / `staleThresholdMs: 180_000` (A-2 実測より。throttle 下の heartbeat 最悪間隔 62.3 秒の約 3 倍)。consumer が上書きする場合も `staleThresholdMs` は「throttle 下の heartbeat 最悪間隔 (約 60 秒)」を十分上回ること (throttle されているだけの機能する hidden host を誤降格させない)
5. **firebase adapter**: `lastSeenAt` は `serverTimestamp()` で書く。demote は対象 peer の presence path への role 上書き

### 降格された側の復帰 (scope 外・consumer 責務)

- demote された端末は presence の onChanged で自分の role 変化を観測できる。visible 復帰時に `setRole('player')` へ戻すかは consumer の UX 判断 (自動で戻すと「最新接続が host」の導出により host へ返り咲いて flapping し得るため、core では自動復帰しない)

### テスト (in-memory transport + fake timers、決定的 simulation) — `src/core/host-liveness.test.ts` (260812 実装済み)

- [x] host の heartbeat 停止 → `staleThresholdMs` 経過 → guest が demote → migration → 滞留していた request が新 host で裁定される (元不具合の再現 → 回復)
- [x] heartbeat 継続中・閾値内は demote されない
- [x] `lastSeenAt` 未記録の新 host が `connected` 起点で判定され、migration 直後に誤降格されない
- [x] 複数 observer の同時 demote が冪等に収束する
- [x] 自分以外に host 候補がいない場合は demote しない
- [x] demote 後にゾンビ解凍した旧 host の遅延 saveSnapshot が fencing で棄却される (既存 snapshot-fencing テストの拡張)
- [x] `hostLiveness: false` で heartbeat・stale 判定とも動かない
- [x] (追加) config validation: 閾値不正 (2 倍未満・0・NaN) を createSynqux が同期 throw する

「凍結 host」は素の transport だけで presence を作る (client を作らない) ことで決定的に再現する — presence は生きているが engine がいないので heartbeat しない。

### ドキュメント (260812 実装済み)

- [x] ADR-0016: observer demote 方式の採用理由 (deriveHostId time-aware 化との比較)、trust model 上の位置づけ
- [x] SPEC-0001: host 決定ロジック節・failure mode 表へ「host 生存監視」を追記
- [x] SPEC-0002: 公開 API (`hostLiveness` 設定)・transport 契約 10/11 を転記

## Phase C — visibility hook (不採用・260812 決定)

- `visibilitychange → hidden` での自主降格 helper 案。heartbeat が本命対策として入った今、価値は「降格を最大 staleThresholdMs → 数秒に前倒しする UX 改善」のみのため**実施しない** (BACKLOG にも積まない)。必要になれば公開 API `setRole` だけで consumer 側に書ける

## Open Questions (260812 決着)

- **dedicated host の再昇格**: 自動・手動を問わず**復帰させない**。dedicated であっても `staleThresholdMs` 無応答だった端末は信用できず、復帰は新しいプロセスの新規接続 (`role: dedicated` での connect) として扱えばよい
- **孤立 guest presence の掃除**: **行わない (ライブラリ責務外)**。presence の物理的な掃除は group 終了時の data lifecycle として consumer が扱う

## 完了条件 (すべて達成・本 TASK クローズ)

1. [x] Phase A の計測数値が本 TASK に追記され、`staleThresholdMs` / `heartbeatIntervalMs` の既定値が決まっている
2. [x] Phase B のテストが全て green (`npm run fix` / `npm test` 29 files / 255 tests 通過、260812)
3. [x] ADR-0016 / SPEC-0001 / SPEC-0002 が更新されている
