# ADR-0029: respond CAS (裁定書き込みの審判) と昇格時の catch-up barrier

- Status: **Accepted** (2026-09-05 実装。経緯は `TASK-260905-respond-cas.md`)
- Date: 2026-09-05
- 関連: ADR-0002 (host 採番 seq / epoch fencing), ADR-0010 (response の凍結と再送冪等), ADR-0011 (snapshot fencing), ADR-0004 (sync health), ADR-0021 (persisted watermark), SPEC-0001 既知の問題, TASK-260905-automation-chain (発見)

## Context

TASK-260905-automation-chain の多段チェーン test で、**適用が遅れた端末が host に昇格すると前 host の確定済み response を上書きする**経路が見つかった (移植元系列 consumer で実際に起きた「終了後に host が遅れ端末へ移り、ゲーム中状態へ巻き戻る」issue と同型)。

1. 端末 b は request #2 の裁定 (changed) が未着 (バックグラウンドタブの遅延・遅配・drop) のまま host に昇格する
2. b の entity #2 には seq がないため、host fork は「未裁定」として裁定に入る。直列裁定ゲート (`hasInflight`) は seq 付き entity にしか効かない
3. `respondRequest` は無条件 `update()` のため、b の裁定が前 host の確定済み response を新 epoch で置き換える。added の到着順が前 host と違えば seq の付け替えと success→error の差し替えが起き、適用済み端末・snapshot と恒久分岐する

位置づけ: ADR-0011 で snapshot の上書きに fence (審判) を置いたが、**response の書き込みには審判がなく「後から書いた者勝ち」のまま**だった。ADR-0002 の epoch tiebreak は「異なる request が同一 seq を取る衝突」の収束先を決めるもので、「同一 request の確定済み裁定を別 host が置き換える」ことは防がない。ADR-0010 Decision 1 (裁定確定後は内容を変更しない) は同一 host 内の契約に留まっていた。

## Decisions

### 1. respondRequest を「観測済み response との CAS」にする (transport 契約 18)

- `respondRequest(id, patch, expected)`。`expected` は caller が観測している response の `(epoch, seq)`、未裁定として観測しているなら `null`
- adapter は保存済み response と `expected` を**原子的に比較**し、一致するときだけ書いて `{ committed: true }` を返す。不一致なら何も書かず (changed も配送せず) `{ committed: false, current }` で現在の封筒を返す
- 同一 `(epoch, seq, responsedBy)` の再送は冪等として受理する (ADR-0010 Decision 2 の再送冪等を adapter 側で保証)
- 判定は core の純粋関数 `acceptsResponse` に一本化し、memory hub と firebase adapter が共有する
- 守る不変条件は「**未裁定として観測した caller は、保存済み response を置換できない**」。観測済み敗者の正当な再裁定 (`expected` = 旧 response) とは区別する。`(epoch, seq)` の辞書順比較 (ADR-0011 と同型) では新 host が高い epoch で上書きできてしまうため採らない
- firebase は `runTransaction` + `applyLocally: false`。abort で巻き戻る楽観 local echo を購読へ流さないため (saveSnapshot と同じ)。abort 時の `snapshot.val()` を `current` として返す。updater が `null` (local cache に無い / prune 済み) で呼ばれたら abort し、`get()` で存在を確定 (= cache を温める) してから 1 度だけ再試行する。実在しなければ `Unknown request`。null に patch だけを書くと prune 済み request が孤児 node として復活するため

### 2. 棄却時は read-back で追いつく

- core は `committed: false` を「自分が観測していない裁定が確定している」とみなし、`retractIssue()` して自分の裁定を捨て、determinism の控えを削除し、`current` を changed の到着として即時反映する (`ordering.observe` + `requestChanged`)
- 元の changed が drop 済みでも、ここで裁定に追いつく。「棄却後に changed の到着を待つ」だけでは永久停止するため (Codex レビュー指摘)

### 3. 昇格時の catch-up barrier

- host fork は直列裁定ゲートに「自分の appliedSeq が耐久化済み水位 (persisted watermark、ADR-0021 Decision 3) に追いつくまで裁定しない」を加える
- 水位の情報源は既存の 3 経路 (自端末の committed / `subscribeSnapshotFence` / load した snapshot の fence) に加え、**昇格直後に最新 snapshot を 1 度読み直す** (`refreshHostWatermark`)。fence 購読 (契約 13) は optional で、実装済みでも permission error 等で黙って止まり得るため、昇格時点の水位だけは購読に依存せず確定させる。読み直しは昇格ごとに 1 read で、降格を観測したら次の昇格で再度行う (読み直し中の降格は完了扱いにしない)。読めなくても hosting は止めない (購読と自端末 persist が主経路)
- これにより、遅れ端末の昇格直後に「未裁定に見える request の再裁定」「既に使われた seq の再発行」が起きにくくなる。CAS は immutability を守るが、**別の request が同じ seq を取る**衝突 (dual-host 窓と同型) までは防げないため、barrier が主で CAS が最後の砦という関係になる
- **barrier は best-effort** である。読み直し・fence 配送と裁定書き込みは原子的でなく (読み直し後に他 host が snapshot を進め得る)、load 失敗は fail-open (fail-closed にすると hosting が永久停止する)。契約 13 未実装・購読停止中は昇格後の水位更新が止まる。この残余で起きるのは「別 request との seq 衝突」で、ADR-0002 の tiebreak / 再裁定 / restore が収束させる。**CAS の不変条件 (同一 request の確定済み裁定は置換されない) は barrier の成否に依らず成立する**
- 残余: 前 host が「respond ack 後・snapshot checkpoint 前」に死んだ response は水位に載らない。この窓では CAS の read-back が働く (再現テストあり)。同時に別の未裁定 request があれば seq 衝突が起き得るが、それは ADR-0002 の既知トレードオフ (tiebreak + 再裁定 + restore) の範疇

### 4. 耐久化済み水位を sync health の gap 証拠に数える

- gap 検知と restore 前の再判定の `maxSeen` を `max(ordering.maxSeenSeq(), maxPersistedAppliedSeq)` に統一する (`gapTargetSeq`)。restore 側を揃えないと、再購読でも欠落 response を取れない端末が snapshot load 直後に `ok` へ戻って restore も unrecoverable も到達できない (Codex レビュー指摘)
- 裁定 (changed) を失った端末は seq を観測できず、barrier で止まったままになるため。水位より遅れている端末は既存の回復手順 (再購読 → restore) で追いつく
- `maxPersistedAppliedSeq` は fence の appliedSeq の**単調 max**で、辞書順 (epoch 優先) の `persistedWatermark` とは別に持つ。高 epoch・低 seq の fence で watermark の appliedSeq が後退しても、barrier / health が「群が到達した位置」を忘れないため
- 副作用: 水位が先に見える端末では gap の開始が早まる (`recovery.test.ts` の段階時刻の前提を 1 件緩めた)

### 5. 細部の判断

- `retractIssue()` (棄却時・respond 放棄時) は裁定元 session が生きているときだけ行う。unsubscribe → 再 subscribe 後に旧 session の結果が返ると、新 session の発行を巻き戻して同一 seq の二重発行を許すため
- `ordering` は「自分の発行高水位」と「観測済み最大 seq」を分けて持つ。従来は 1 つのカウンタだったため `retractIssue()` が観測済み seq (gap の証拠) まで消していた。`maxSeenSeq()` は両者の max
- firebase の `get()` 待機中に disconnect / 再 connect されていたら再試行しない (離脱済み group への書き込み防止)。`get()` は cache miss 時にしか走らず (host は requests を購読済み)、通常経路の RTT は増えない
- `RespondPatch.result` は `string | null` に限定する (optional 由来の `undefined` を firebase が拒否するため)

## Consequences

- transport 契約の breaking change (`respondRequest` の引数と戻り値)。社内に custom adapter はなく、firebase adapter と memory hub は本 ADR で更新済み。0.19.0 (minor) で release し、release note に契約変更を明記する
- 性能: firebase の裁定書き込みが `update()` (patch) から `runTransaction` (node 全体) になる。通常 RTT は 1 回のまま (host は requests 購読済みで node が local cache にある)、衝突時のみ 2 回。送信 payload は封筒全体 (action + result) に増え、host 自身の適用は local echo ではなく server 確定後になる。**demo の rig (`?rig=1&probe=5` + storm) で before / after の裁定 latency を実測してから release すること** (TASK-260905-respond-cas の残項目)
- dual-host で同一 request に 2 host が同時応答するケースは「先勝ち・後手は採用」に変わる (従来は後書きが勝ち、tiebreak 頼み)。異なる request が同一 seq を取る dual-host 窓の扱い (ADR-0002) は変えない
- barrier により、他 host の snapshot が耐久化された後の dual-host 窓は best-effort で狭まる (窓は概ね「snapshot 耐久化前」に限られる)。recovery.test.ts の dual-host シナリオは誤認 host の snapshot を保留して窓を再現する形に更新した

## Alternatives considered

- **security rules による CAS** (`update()` のまま、rules で「未裁定または expected 一致」以外の write を拒否): 性能は現行のまま保てるが、正しさが consumer の rules 配備に依存し、ADR-0009 の「正しい consumer なら rules なしでも正しい」前提を崩す。rig 実測で transaction の性能が受け入れ線を超えた場合の代替として残す (core 側の変更は共通で、adapter 1 ファイルの差し替えで切り替え可能)
- **catch-up barrier のみ** (transport 変更なし): 「respond ack 後・snapshot 前の死」の窓で同じ上書きが残り、drop 済み changed からの回復も別途要る。barrier は本 ADR の一部として採用し、単独では採らない
- **`(epoch, seq)` の辞書順 CAS**: 新 host が高い epoch で上書きできるため不変条件を守れない (Codex レビュー指摘)

## Amendment (2026-09-05): ack 後の自己反映 (TASK-260905-respond-cas 計測より)

`applyLocally: false` で host の local echo が消えたことで、host は「自分の裁定の適用 = 次の裁定の直列ゲート解除」を server 経由の changed 到着まで待つようになり、localhost の emulator でも裁定が約 100ms/件で直列化して約 10 req/s で頭打ちになった (request→裁定 200ms 一定)。main は local echo で次の裁定へ即進むため CPU 律速 (4ms)。

- **ack (= CAS が commit した耐久化済みの確定) の直後に、凍結済み response を changed の受信と同じ経路 (`ingestResponded`) で自己反映する**。内容は server の保持値と同一なので幻の echo にならず、後から届く server の changed は適用済みガードが捨てる
- 直列ゲートの解除は「ack」に前倒しされ、裁定ごとの待ちは transaction 1 RTT に縮む。main の 0 RTT (echo は ack 前) には戻らないため、実網では 1/RTT が host の上限になる (RTT 30〜50ms で 20〜30 req/s 程度)。これは「裁定の書き込みに審判を置く」ことの本質的な代償として受け入れる
- ack 喪失 (respond の throw) 時は自己反映せず、ADR-0010 の再送経路に倒れる。session が替わっていたら自己反映しない
- 副作用: host 自身の `dispatchAndWait` は ack 時点で resolve する。単独 host で「配送待ち」の窓を作るテストは `holdAck` を併用する (`dispatch-and-wait.test.ts` / `replace-root-reducer.test.ts`)。characterization の「試し実行は store を書き換えない」は「ack 後に自己反映される」へ更新

