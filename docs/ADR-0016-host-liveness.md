# ADR-0016: host liveness heartbeat と observer demote

- Status: **Accepted** (2026-08-12 実装)
- Date: 2026-08-12
- 関連: ADR-0001 Decision 7 (host 導出), ADR-0002 (epoch fencing / 敗者再裁定), ADR-0009 (trust model), ADR-0011 (snapshot fencing), ADR-0014 (mutable role), TASK-260812 (実測と実装仕様)

## Context

「host 端末のブラウザが非アクティブ放置され、presence は生きたまま room 全体が停止する」不具合が実運用で繰り返し報告されていた。host 導出は presence pool の変化にのみ反応するため、「接続は生きているが JS が止まっている host」を検知できない。

TASK-260812 の実測で真因を切り分けた:

- background tab の timer throttling (約 60 秒粒度) だけでは現行の event-driven な host は止まらない (メッセージ受信イベントは throttling の対象外。v1 の polling 駆動とは異なる)
- tab freeze (`chrome://discards` で再現) では「request は書き込まれるのに裁定が返らず、presence は pool に残存する」という報告どおりの停止が再現した
- timer throttling 下でも serverTimestamp の定期書き込みは最悪 62.3 秒間隔で成功し続けた — heartbeat は成立する

## Decisions

1. **host だけが heartbeat を書く**。自端末が導出 host の間、`heartbeatIntervalMs` (既定 30s) ごとに presence の `lastSeenAt` をサーバ基準時刻で touch する (transport 契約 10)。非 host の生存は同期の成立に関与しないため書かない (write 帯域の節約)。
2. **stale host の降格は他端末 (observer) が行う**。導出 host の `max(lastSeenAt ?? 0, connected)` が `staleThresholdMs` (既定 180s) を超えて古ければ、observer が `demotePeer` で対象の role を `guest` へ書き換える (transport 契約 11)。pool の変化として全端末へ配送され、既存の host migration に合流する。
3. **`deriveHostId` は peer pool の純粋関数のまま変えない**。各端末が local に stale 除外する time-aware 化は、端末ごとの時刻観測差により「全端末が同じ host に合意する」成立条件が閾値境界で恒常的に割れ得る (修復機構のない split-brain) ため不採用。demote は transport 上の共有事実になるので、合意メカニズムを保てる。
4. **誤検知の防御は 2 段**。(a) observer は「現在の host を観測し始めてから `staleThresholdMs` 経過」するまで判定しない — 一度 host を降りた端末が古い `lastSeenAt` のまま再昇格した直後の誤 demote を防ぐ端末ローカルのヒステリシス (correctness には使わない)。(b) `staleThresholdMs < heartbeatIntervalMs * 2` の設定は createSynqux が生成時に拒否する — 1 回の heartbeat 欠落で demote される設定は dual-host 窓を無用に開くだけ。
5. **候補不在ガード**。demote 後の pool で `deriveHostId` が undefined になる場合は demote しない。host 不在の完全停止は元の症状より悪く、「最悪でも現状維持」を保証する。
6. **降格された端末の自動復帰は core に入れない**。visible 復帰で自動的に player へ戻すと「最新接続が host」の導出により即 host へ返り咲き、flapping の温床になる。復帰は consumer が `setRole` で行う UX 判断とする。
7. **`hostLiveness: false` で機能ごと無効化できる**。既定は有効。既定値 (30s / 180s) は TASK-260812 の実測 (throttle 下の heartbeat 最悪間隔 62.3s) に基づく。

## Why this is safe

- demote は新しい状態遷移を発明しない。role の書き換え (ADR-0014 の mutable presence 属性) → pool 変化 → 既存 migration という通常経路のみを通る。
- 誤検知 (生きている host の降格) の結果は dual-host 窓であり、これは新規参加のたびに開いている既知の窓。決定的 tiebreak・敗者再裁定 (ADR-0002)・snapshot fencing (ADR-0011) の既存防御にそのまま還元される。ゾンビ解凍した旧 host の遅延書き込みも fencing が棄却する。
- 他 peer への書き込み (`demotePeer`) は API としては新しいが能力としては新しくない。ADR-0009 の非敵対クライアント前提では、書き込み権限を持つ端末はもともと presence を偽装できる。攻撃面は拡大していない。
- 同時 demote は同値書き込みで冪等。demote 済み host (role: guest) は stale 判定の対象外になるため、再発ループは構造的に存在しない。

## Consequences

- transport 契約に `heartbeat` (契約 10) と `demotePeer` (契約 11) が増える。pre-1.0 の breaking change であり、既存の adapter / transport スタブは 2 メソッドの実装が必要になる。
- host が存在する限り `heartbeatIntervalMs` ごとに presence への書き込みが発生する (firebase: 30s ごとの update 1 件。実測 ack 数十 ms)。
- 誤検知は「確実な room 停止」を「低確率で回復可能な dual-host 窓」に交換するトレードであり、ゼロコストではない。稀に sync health の restore / unrecoverable (リロード案内) に至るケースはあり得る (ADR-0004 の既存挙動)。
- firebase adapter の切断復帰 (再登録) は `lastSeenAt` もサーバ時刻で焼き直す。demote された端末がゾンビ的な切断復帰で自己申告 role を書き戻し、host へ返り咲く競合は許容する — 復帰後も stale なら再度 demote され、健全なら機能する host として成立するため収束する (既知の挙動として記録)。
- 降格された端末は dedicated であっても復帰させない (260812 決定)。`staleThresholdMs` 無応答だった端末は role を問わず信用せず、dedicated の復帰は新しいプロセスの新規接続として扱う。孤立した guest presence の物理的な掃除もライブラリ責務外とし、group 終了時の data lifecycle (consumer 責務) に委ねる。
