# ADR-0021: restore replay の非発火保証と `fire: 'persisted'` (reset reload 無限ループ対策)

- Status: **Accepted** (2026-08-16 起草 → 同日 Codex レビュー反映 → 同日裁定・実装。実装は `docs/TASK-260816-replay-suppression-and-persisted-fire.md`)
- Date: 2026-08-16
- 関連: ADR-0002 (host-seq / 全量購読), ADR-0005 (requests retention), ADR-0010 (response immutability), ADR-0011 (snapshot fencing), ADR-0017 (listeners), ADR-0020 (listener scope)

## Context

消費 repo のゲームテンプレートで「ゲームデータ reset 時に全端末を alert + reload する
`mode: 'everyone'` listener」が無限リロードに陥るインシデントが起きた。調査の結果、
listener 単体の問題ではなく、engine 側の構造的な穴 3 つの合成だと判明した。

### 事故の機構

1. **reset の envelope は transport に残り続ける**: retention (ADR-0005) は適用窓
   (`APPLIED_WINDOW_SIZE`) より古い envelope しか prune せず、購読は after なしの
   全量購読 (ADR-0002 Decision 5) のため、リロード後の再購読で直近の裁定済み
   envelope は毎回再配達される。再配達の破棄は「restore した snapshot の ordering
   (appliedSeq / 適用窓)」に全依存している
2. **listener effect の reload が snapshot 永続化を kill する**: host の
   `persistSnapshot` は `respondRequest` の server ack 後に走るが、transport 契約 2
   により local echo の onChanged が ack より先に届く。さらに effect は
   `Promise.resolve(effect())` の評価時に**同期呼び出し**されるため、host 上では
   「echo → 適用 → effect (alert でスレッド全停止 → reload)」が
   `persistSnapshot` より確実に先行する。navigation する effect は自端末の
   post-adjudication 作業 (snapshot 保存と、その成功が前提の prune) を破壊できる
3. **live 遷移が初回一括配送より先**: `initializeSubscription` は
   `openRequestsSubscription()` から `changePhase(store, 'live')` まで await のない
   同期ブロックで、transport の初回一括配送 (firebase の onChildAdded) は非同期に
   届くため、**必ず live 遷移後に配送される**。ADR-0017 Decision 3 の
   「restore replay は 'subscribing' 中だから発火しない」は初回購読では構造的に
   成立しておらず、replay 抑止は実質 1 の ordering 破棄だけが担っていた

この 3 つが揃うと: stale snapshot で再購読 → reset envelope が
`seq == appliedSeq + 1` として再適用 → phase は既に 'live' → listener 再発火 →
reload → 新しい裁定が起きないため snapshot は永遠に進まず、無限ループが確定する。
現行実装で snapshot を進める点は host 裁定 fork 内の `persistSnapshot` 1 箇所しか
なく (Decision 4 で追加する)、「次の裁定が来れば治る」は回復保証ではない。

### 検討して棄却した代替案

- **request envelope へ persisted flag を焼き込む案** (「ここまで persist 済み」を
  封筒の update で全端末へ広報する): 3 つの理由で棄却。
  (1) 裁定確定後の封筒凍結 (ADR-0010) と正面衝突し、凍結契約への例外が
  fork survival の議論を再燃させる。(2) prune (削除 + logs 退避) と flag update の
  競合で、削除済み path への update が `{ persisted: true }` だけの壊れた封筒を
  再出現させる (firebase update は削除済み path にも部分 node を作る)。
  (3) 裁定ごとに write が倍増する上、欲しい情報は本質的に「どの fence まで
  persist 済みか」という単調水位 1 個であり、request 単位の flag は冗長。
  同じ目的は snapshot fence の購読 (Decision 3) で write 追加ゼロで達成できる
- **persisted の証拠へ request identity (requestId) を含める案** (fence の scalar
  水位では dual-host 窓の同 seq 分岐と区別できない、というレビュー指摘への対応):
  正確には snapshot ordering の適用窓との突合が必要で、fence を越える永続 marker の
  追加 (write 増・契約面積増) を要求する。ADR-0017 Decision 5 は dual-host 窓の
  二重発火を既に best-effort として許容しており、同格の希少ケースにだけ強い保証を
  足すのは釣り合わない。保証を明示的に弱める (Decision 3 の契約文言) 方に倒す
- **watermark 未達 timeout で発火する案** (初稿の設計): 保存が終わっていないのに
  発火して reload すれば、まさに保存を再び kill できる。それは `'persisted'` の
  名前が約束する契約の嘘になるため、timeout は「warn + 発火しない」に倒す
  (レビュー指摘の採用)。fallback が欲しい consumer は既定の `'applied'` を使う
- **`ctx.settled(): Promise<void>` を effect へ渡す案**: await の書き忘れが
  「まさに今回と同型のゲート忘れ」になる。ADR-0017 が listeners を作った動機
  (consumer の手書きゲートの構造的排除) と逆行するため、rule 宣言の option
  (Decision 3) に倒す
- **effect 内の blocking UI / navigation を runtime 検出して防ぐ案**: alert や
  location.reload の使用を engine から検出する信頼できる手段がない。docs 契約
  (Decision 5) に倒す

## Decisions

1. **初回購読は backlog を配りきってから live へ遷移する**。
   transport 契約に「subscribeRequests は初回一括配送の完了を handlers の
   `onReady()` (新設・optional) で通知すること」を追記し、core は
   `initializeSubscription` で (a) onReady 到達、(b) backlog 中の裁定済み envelope の
   適用完了 (`appliedSeq >= 配送済み maxSeenSeq`) の両方を待ってから
   `changePhase(store, 'live')` する。待機は有界 (timeout) とし、超過時は live へ
   進めて既存の health / recovery 機構に委ねる (gap は stalled → resubscribe →
   restore の既存経路が治す)。
   - **順序は「backlog 適用完了 → live 遷移 → automations / host-liveness 起動」に
     固定する**。現行の「engine 起動直後に live 化」へ await を挿すだけだと、
     automations が catch-up 途中の state を評価して request を発行し得るため、
     engine の起動を live 遷移の後ろへ移す
   - firebase adapter は「child 購読を attach → 同一 query を get() → 取得分を
     onAdded として配送 → onReady」で実装する。attach 済み購読との二重配送は
     core の added dedup (`ordering.acceptAdded`) が吸収する。get() の結果は
     裁定済みの最新値を含むため、attach と get の間の changed 取り逃しは起きない
   - **onReady の adapter 契約**: 1 購読につき高々 1 回発火する。unsubscribe 後は
     get() の完了・手動 onAdded・onReady のいずれも発火しない (cancellation
     guard)。get() の失敗は onError へ転送する (契約 8 と同じ扱い)
   - onReady を呼ばない旧 adapter は timeout 経由で従来挙動へ縮退する (breaking
     にしない。その分 subscribe 完了が timeout ぶん遅くなることは契約に明記)。
     MemoryHub は同期配送の直後に onReady を呼ぶ
   - standalone session は transport に触れないため対象外 (従来どおり local restore
     後に live)
   - live の意味論は「**初回購読 barrier までに観測した裁定列を適用済み**」に
     とどまる (耐久化済み・正史確定までは主張しない)。それでも `selectIsLive` を
     読む consumer・automations の初回評価・E2E の connected フラグは
     「catch-up 途中を live と誤認しない」前提を得る

2. **「既裁定のまま onAdded で届いた」envelope の適用では listener を発火しない**。
   routing (`requestHandlers.onAdded`) で `responsedBy` 付きの envelope を
   requestChanged へ振り分ける既存の分岐点で、その envelope を**端末ローカルに
   replay と印す**。responseListener がこれを適用するとき、delivery meta に
   replay 印を載せ、listener 評価 (`fireListenersAfterApply`) はこの印のある適用を
   スキップする。
   - 判定の根拠として、transport 契約 3 を 1 点強化する: 「**同一購読内では、
     同一 child について added が changed より先に配送されること**」。SDK の
     性質に頼らず adapter が能動的に保証する — firebase adapter は購読ごとの
     seenAdded 集合を持ち、added 前に届いた changed は buffer して added 配送後に
     flush する (Decision 1 の onReady は buffer flush 後に呼ぶ)。MemoryHub も
     同じ契約で実装する。これにより「新規の裁定は未裁定 onAdded → 裁定
     onChanged の順で観測される」が契約上の保証になり、既裁定 onAdded =
     restore・途中参加・recovery 再購読・再配送のいずれか (= その端末にとっての
     歴史) と確定する
   - 境界ケース: 購読確立と他 host の裁定が競合し「直前に裁定されたばかり」の
     envelope が既裁定 onAdded で届くことはあり得る。これは catch-up 中の端末に
     とって歴史であり replay 分類が正しい。逆向きの誤分類 (正当な live 発火の
     欠落) は ADR-0017 Decision 5 の best-effort 配達契約の範囲に収まる
   - 印は封筒には書かない (端末ローカルの配送経路判定であり、封筒凍結
     (ADR-0010) を破る理由がない)
   - Decision 1 の live 遷移タイミングに依存しない抑止であり、(1) が timeout で
     縮退した場合や recovery 再購読の再配送でも成立する。**listener の replay
     非発火はこの Decision が正であり、phase ゲートは防衛線に格下げされる**

3. **rule ごとの `fire?: 'applied' | 'persisted'` を追加する (既定 `'applied'`)**。
   `'persisted'` の rule は「永続化水位 (persisted watermark) が、この適用の
   裁定印 `(epoch, seq)` 以上に達したとき」に発火する。比較は snapshot fencing
   (ADR-0011) と同じ **(epoch, appliedSeq) の辞書順**で行う。既存 rule は挙動不変
   (minor release)。
   - **保証の範囲 (明示的に弱い)**: `'persisted'` が保証するのは「**CAS に受理
     された、その fence の snapshot が耐久化された**」ことだけであり、
     「自端末が適用したその request がその snapshot に含まれる」ことも
     「その snapshot が正史である」ことも保証しない (ADR-0011 自身が fencing は
     完全な正史選別でないと認めており、同値 fence の別分岐 payload は後書き勝ち
     になる)。dual-host 窓の同 seq 分岐は ADR-0017 Decision 5 が二重発火を許容
     するのと同格の best-effort として許容する。なお reload 型の effect はこの
     ケースで restore により耐久化済み snapshot へ収束するため自己修復的である
   - **watermark の情報源は 2 つ**: (a) 自端末の `persistSnapshot` が
     `committed: true` で resolve した fence、(b) transport へ新設する
     `subscribeSnapshotFence?(key, handler): Unsubscribe` (optional) による fence の
     変更購読。firebase は snapshot node のうち `fence` child だけを onValue で
     購読する (payload は重いため購読しない。fence は数十 byte)。write の追加は
     ゼロ — `saveSnapshot` が既に書いている fence を読むだけ
   - **optimistic local echo は adapter 契約で根絶する**: 「fence 購読イベントは
     server 確定値のみを配送すること」を契約とし、firebase は `saveSnapshot` の
     runTransaction を `applyLocally: false` で実行して楽観 local event 自体を
     発生させない。core 側に in-flight ガードのような補正規則は持たない
     (初稿の「自分の save 中は fence イベントを無視する」案は、remote の確定
     fence まで捨てる race があるため棄却)。副作用として明記するもの:
     自端末でも `'persisted'` 発火が最低 1 往復遅れる / offline 中は watermark が
     進まず timeout drop になる / fence 購読イベントと runTransaction resolve の
     前後順に依存しない実装にする (watermark は辞書順の単調 max 更新とし、
     重複・逆順イベントを吸収する) / ADR-0011 の「実質 set と同等」という性能
     説明は購読側の可視性については成立しなくなるため Amendment を追記する
   - **timeout は「warn + 発火しない」**: watermark が到達しないまま有界時間を
     超えたら console.warn して drop する。発火してしまえば契約の嘘になり、
     reload 型 effect が保存を再び kill し得る。到達性そのものは Decision 4
     (checkpoint) が引き上げる
   - **発火の遅延中も評価は適用直後に固定する**: `match`・`'host-only'` の host
     判定・`ctx` (synced / self) は**適用直後に評価・捕捉**し、遅延させるのは
     effect の実行だけとする (ADR-0017 Decision 2 の「ctx.synced は適用後 state」
     契約を保つ。host migration が待機中に起きても発火主体は適用時の判定に従う)
   - **standalone**: `persistLocalSnapshot` の save 試行が resolve した後に
     queued effect を実行する (現行の effect 同期呼び出しのままでは save より
     先に走るため、`'persisted'` rule だけ実行を遅延する)。localSnapshots 無効の
     session は永続化対象が存在しないため適用直後に実行する
   - **local action (scope: 'all')**: seq も persist も存在しないため
     `'applied'` と同義として適用直後に実行する (設定エラーにはしない — 同一
     rule が synced / local 両方に match する構成を許すため)
   - `subscribeSnapshotFence` 未実装の adapter では (a) のみが情報源になるため、
     **非 host 端末の `'persisted'` rule は実質 timeout drop になる**。firebase /
     MemoryHub はともに実装するため実害は仮想 adapter に限られるが、縮退挙動と
     して契約に明記する

4. **snapshot checkpoint の経路を追加する**: 「裁定時に persist」だけでは、host が
   persist 前に死んだとき誰も snapshot を進める者がいない (本インシデントの
   ループ持続条件そのもの)。そこで host は裁定時に加え、checkpoint として
   `persistSnapshot` を試みる経路を持つ。
   - **checkpoint の適格条件 (Critical)**: checkpoint は **Decision 1 の barrier
     (loadSnapshot 完了 + onReady + backlog 適用完了) より後**でのみ実行できる。
     現行の初期化順序では peer の初回 onAdded で host 判定が restore 前に成立し
     得るため、「昇格時に素直に保存」すると**初期 state で正しい旧 snapshot を
     上書きし、新 epoch の採番により fencing がその誤 snapshot を棄却不能に
     固定する**。barrier 前の昇格観測は checkpointPending として記録するだけとし、
     barrier 通過後に hosting epoch を確立してから保存する
   - **実行トリガー**: (a) barrier 通過後、host かつ checkpointPending のとき、
     (b) host 在任中、自分の local fence が既知の durable fence を **(epoch,
     appliedSeq) の辞書順で**追い越しているとき (既裁定 envelope の適用直後に
     評価。appliedSeq 単独比較にしない)
   - **到達性は best-effort**: checkpoint の保存失敗は有限回の backoff retry で
     追うが、それでも失敗し続ければ諦める (無限 retry は transport 障害時の
     帯域消費にしかならない — health 機構の既存判断と同型)。したがって
     「stale snapshot の温存が有界」は保証ではなく、通常運転での回復経路の提供
   - fencing (ADR-0011) が同値受理・辞書順棄却を保証するため、checkpoint の
     重複・競合はおおむね冪等に収束する。ただし**同値 fence の別分岐 payload
     (dual-host の同 epoch・同 seq fork) は同値受理により後書き勝ちになる**。
     これは Decision 3 の保証弱化と同じ希少ケースの許容として明記する

5. **「graceful でない effect は process を止めるな」を docs 契約にする**。
   スレッドを止める UI (alert / confirm) や navigation (location.reload) を含む
   effect は `fire: 'persisted'` の宣言を必須とし、rule 配列の最後に置き、
   「以後の進行が止まってよい終端イベント」(reset 等) に限る。この契約を
   `SynquxListener` の JSDoc と SPEC-0001 に明記し、本インシデント (無限リロード) を
   SPEC の Trouble Shooting へ記録する。
   - `fire: 'persisted'` でも解決しないことも同時に明記する: alert は発火時点以降の
     裁定・適用・他 rule の effect を凍らせる。並走する他 rule の in-flight effect
     (外部 PUT 等) は reload に殺され得る (ADR-0017 Decision 5 の best-effort 契約の
     範囲内)。cross-device の同時到達も保証しない (`'everyone'` の実行回数が
     端末間で揃わない契約は不変)。timeout drop があるため「必ず 1 回実行される」
     契約でもない

## Consequences

- 4 つの防衛線が役割分担する: Decision 1 が phase の意味論を復元し、Decision 2 が
  replay 非発火を配送経路の事実 (と強化された transport 契約) で保証し、
  Decision 3 が「live の正当な発火でも persist を破壊しない」余地を consumer に
  与え、Decision 4 が watermark の到達性 (と stale snapshot の解消) を best-effort
  で引き上げる。無限ループは Decision 2 単独でも死ぬ
- transport 契約の変更は「onReady (optional)」「subscribeSnapshotFence (optional)」
  「added-before-changed の順序保証 (強化)」「fence 購読の server 確定値限定」の
  4 点。optional 2 点は未対応 adapter でも動く (timeout 縮退)。順序保証の強化は
  「順序入れ替え可」だった公開契約に対する behavioral breaking change であり、
  自前 adapter (firebase / MemoryHub) は追随実装するが、仮想の第三者 adapter に
  とって無害とは言えない。消費者が自社 repo 群のみである前提 (AGENTS の YAGNI
  方針) に基づき 0.x minor として出す判断をここに記録する
- ADR-0017 Decision 3 の「live 配信のみ発火」は「replay と印された適用では
  発火しない (Decision 2) + phase ゲート (防衛線)」へ読み替える。ADR-0017 側に
  Amendment を追記する
- SPEC-0001 の更新が必要: transport 契約 (onReady / subscribeSnapshotFence /
  順序保証 / fence 配送規則)、listener 節 (`fire` option と docs 契約、保証の
  範囲)、snapshot 節 (checkpoint 経路)、Trouble Shooting (本インシデントの機構と
  調査手順)
- 実装は「バグを再現するテストを先に書く」原則に従い、MemoryHub simulation で
  (1) stale snapshot + 全量再配送で listener が再発火しないこと (Decision 2)、
  (2) backlog 適用完了前に live にならないこと・automations が barrier 前に
  評価されないこと (Decision 1)、(3) persisted rule が save resolve / fence 購読 /
  timeout drop の各経路で正しく動くこと (Decision 3)、(4) host 昇格 checkpoint で
  watermark が進むこと (Decision 4) を先に固定する
- 消費 repo 側は reset listener に `fire: 'persisted'` を宣言するだけでよく、
  手書きゲートは増えない (ADR-0017 の動機を保存)

## Implementation Notes (2026-08-16 実装時の差分)

- **MemoryHub は added-before-changed の buffer を実装しない**: MemoryHub の自然
  配送は購読単位 FIFO のため契約 3 の強化を構造的に満たしており、buffer を足すと
  faults (`drop` / `delay` の added 対象) が changed まで封じて fault 注入
  (契約外の敵対的注入に対する core の頑健性検証) が無意味化する。buffer を実装
  するのは attach + get() で順序が本当に乱れ得る firebase adapter のみ
- **checkpoint は durable fence と同値なら保存しない**: Decision 4 (a) の字面は
  「barrier 通過後、host かつ checkpointPending のとき」だが、実装は「local fence
  が watermark を辞書順で追い越しているとき」に限定した。同値 = 保存すべき進行が
  無い、として epoch インフレ (毎リロードでの beginHosting) と無駄 write を抑止
  する。checkpointPending の記録は不要になった (barrier 通過時に直接評価する)
- **watermark の情報源に load 済み snapshot の fence を追加** (情報源 (c)):
  subscribe / recovery restore で load できた snapshot の fence は耐久化済みの
  事実であり、fence 購読 (b) 未実装 adapter でも初期水位を与える
- **recovery 再購読の再配送における境界**: gap 中に live の changed で裁定を
  観測済みだった envelope は、再購読の replay 印が届くより先に既存 fork が適用へ
  到達するため live 発火として扱われる (丸ごと取り逃した envelope は replay
  非発火)。Decision 2 の境界ケース (best-effort) の範囲内として許容し、テスト
  (`src/core/replay-suppression.test.ts`) で挙動を固定した
- **checkpoint の評価トリガーに「peer 変化 (host 昇格観測)」を追加** (実装後の
  Codex レビュー指摘の反映): Decision 4 の (a)(b) だけでは「旧 host が persist 前に
  死に、live 適用済みの端末が昇格する」migration で checkpoint が永久に走らない
  (replay 適用も barrier 通過も再発生しない)。peerUpserted / peerRemoved で
  `maybeCheckpoint` を再評価する。fence 追い越しガードにより通常時は no-op
- **checkpoint の走行中ガードは session 識別で持つ** (同レビュー指摘): boolean の
  in-flight フラグだと、resolve しない保存が session を跨いで新 session の
  checkpoint を永久にブロックする。走行主 session の識別子でガードし、await 後の
  watermark 反映も session 一致を検査する
  (その後 TASK-260816-provider-removal-and-state-ownership で session 寿命の状態を
  `SessionSyncState` (session オブジェクト所有) へ集約し、識別子ガード方式は
  「旧 task は自分が捕捉した session の state にしか触れない」構造へ置換された。
  分類の正は SPEC-0001「engine 状態の所有権」)
- **裁定 fork の後処理は「裁定の土台 state を読んだ時点の session」でゲートする**
  (同レビュー第 2 ラウンド指摘): respondRequest の ack await 中に unsubscribe →
  再 subscribe されると、persistSnapshot が現在の session.groupId へ書くため、
  旧裁定の state を別 group の snapshot へ書き込み得た。session を裁定土台の
  読み取りと同期的に捕捉し、後処理 (保存 + watermark + prune) 全体を照合で
  スキップする。保存 await 中の切替にも prune 前の再照合で備える (pruneRequests は
  現在の transport 接続に束縛されるため、旧閾値で新 group を削らない)
- **checkpoint は「この session で同期の証拠を観測済み」を適格条件に持つ**:
  ordering は instance 状態のため、同一 instance を別 group へ再 subscribe すると
  前 group の進行を「local fence の追い越し」と誤認し、空の group へ前 group の
  state を checkpoint し得る。snapshot load 成功 or envelope 受信を証拠とし、
  証拠なしでは checkpoint しない。なお同一 instance の別 groupId 再 subscribe
  自体は非サポート (subscribe の JSDoc に明記) — 本ガードは壊れ方を
  「書き込みなし」に限定するためのもの
