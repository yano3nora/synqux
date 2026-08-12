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

### A-2. 再現 rig (demo + firebase emulator)

- 構成: host タブ (Chrome) + guest (別ブラウザ)。guest は 30 秒ごとに request を送り続け、response の有無と遅延を記録する
- host タブへ計測ログを仕込む (in-memory ring buffer、タブ復帰時に dump。demo 配下に置き build 対象外とする):
  - 定期 tick の実発火間隔 (timer throttling の実測)
  - `visibilitychange` / `freeze` / `resume` (Page Lifecycle)
  - Firebase `.info/connected` の遷移
  - transport イベント受信 (onAdded / onChanged) と host 裁定の実行時刻
- 再現操作:
  1. host タブを hidden にして 5 分以上放置 (intensive timer throttling の発動)
  2. `chrome://discards` で host タブに Toggle freeze (tab freeze の人為再現)
- 停止中に guest 側から presence ノードを直接観測し、host の presence が残存しているか記録する

### A-3. 判定と出力

| 復帰後のログ所見 | 判定 |
| --- | --- |
| 全イベントに時間ギャップ (tick も transport 受信も止まる) | tab freeze (JS 完全停止) |
| tick は間引かれるが transport 受信・裁定は継続 | throttle のみ (停止の真因は別にある) |
| host の JS は動くがイベント未達、guest から presence は残存 | ゾンビ接続 |

- 出力: 判定結果、**throttle 下での timer 最悪発火間隔** (heartbeat 閾値の根拠)、freeze 中の presence 残存時間。数値は本 TASK に追記する

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
   - 自端末が host の間、`heartbeatIntervalMs` (既定 30s 仮置き) ごとに `heartbeat()` を呼ぶ。失敗は握りつぶして次回 retry (automations engine と同じ政策)
   - 全端末は「周期 tick + peer 変化イベント」で stale 判定を評価する: `now - (host.lastSeenAt ?? host.connected) > staleThresholdMs` なら `demotePeer(hostId)`。`lastSeenAt` 未記録の新 host は `connected` を起点にする (migration 直後の誤検知防止)
   - **候補不在ガード**: demote 後の pool で `deriveHostId` が undefined になる場合は demote しない (host 不在の完全停止は元の症状より悪い)
   - 複数端末の同時 demote は同値書き込みで冪等。demote の再発はしない (role が guest に変わった時点で stale 判定の対象外)
4. **設定値** (`CreateSynquxConfig` へ追加、SPEC-0002 に転記):
   - `hostLiveness?: { heartbeatIntervalMs?: number; staleThresholdMs?: number } | false` — `false` で機能ごと無効化。既定値は Phase A の実測で決める。制約: `staleThresholdMs` は「throttle 下の heartbeat 最悪間隔 (実測)」を十分上回ること (throttle されているだけの機能する hidden host を誤降格させない)
5. **firebase adapter**: `lastSeenAt` は `serverTimestamp()` で書く。demote は対象 peer の presence path への role 上書き

### 降格された側の復帰 (scope 外・consumer 責務)

- demote された端末は presence の onChanged で自分の role 変化を観測できる。visible 復帰時に `setRole('player')` へ戻すかは consumer の UX 判断 (自動で戻すと「最新接続が host」の導出により host へ返り咲いて flapping し得るため、core では自動復帰しない)

### テスト (in-memory transport + fake timers、決定的 simulation)

- [ ] host の heartbeat 停止 → `staleThresholdMs` 経過 → guest が demote → migration → 滞留していた request が新 host で裁定される (元不具合の再現 → 回復)
- [ ] heartbeat 継続中・閾値内は demote されない
- [ ] `lastSeenAt` 未記録の新 host が `connected` 起点で判定され、migration 直後に誤降格されない
- [ ] 複数 observer の同時 demote が冪等に収束する
- [ ] 自分以外に host 候補がいない場合は demote しない
- [ ] demote 後にゾンビ解凍した旧 host の遅延 saveSnapshot が fencing で棄却される (既存 snapshot-fencing テストの拡張)
- [ ] `hostLiveness: false` で heartbeat・stale 判定とも動かない

### ドキュメント

- [ ] ADR-0016: observer demote 方式の採用理由 (deriveHostId time-aware 化との比較)、trust model 上の位置づけ
- [ ] SPEC-0001: host 決定ロジック節・failure mode 表へ「host 生存監視」を追記
- [ ] SPEC-0002: 公開 API (`hostLiveness` 設定) を転記

## Phase C (optional・別 pick 可) — visibility hook

- `visibilitychange → hidden` での自主降格 + `visible` での復帰を helper 化する (公開 API `setRole` のみで書けるため consumer レシピ or `src/react/` の小さな hook)
- heartbeat が本命対策のため、Phase B 完了後に必要性を再評価してから着手する

## Open Questions

- dedicated host が stale で降格された場合の再昇格運用 (headless プロセスは visibility での自己復帰ができない。監視プロセス側の再起動 + `setRole('dedicated')` で戻す想定でよいか)
- `demotePeer` を transport 契約に足す代わりに「presence 削除 (evict)」とする案は、evict された端末の presence 再登録で「最新接続 = host」に返り咲く flapping があるため不採用としたが、demote でも guest のまま孤立する端末の掃除は必要か (retention/lifecycle は consumer 責務の整理と重複)

## 完了条件

1. Phase A の計測数値が本 TASK に追記され、`staleThresholdMs` / `heartbeatIntervalMs` の既定値が決まっている
2. Phase B のテストが全て green (`npm run fix` / `npm test` 通過)
3. ADR-0016 / SPEC-0001 / SPEC-0002 が更新されている
