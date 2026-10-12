# ADR-0031: validate / mutate 記法 — 拒否条件を reducer の外から呼べる形で定義する

- Status: **Accepted**
- Date: 2026-10-12
- 関連: ADR-0001 Decision 4 (reducer が唯一の判定器)、ADR-0007 (action repeat contract)、ADR-0015 Decision 3 (automations の自己終了契約と validation 重複)、ADR-0025 (consumer 語彙と wrap の採否基準)、ADR-0026 (定義フェーズ)、ADR-0027 (locals slice)、SPEC-0002。consumer 側の経緯は導入 consumer (テンプレ repo) の ADR

## Context

- synced reducer の validation (`withErrorResult` を返す分岐) は reducer の中にしか無く、外から呼べない。consumer の UI は同じ条件を別に書いて disabled にし、AI プレイテスト (reducer を直接回す到達性テストと、ブラウザで dispatch する周回 bot) は UI の条件を手で写して候補を絞っていた。写した条件のズレが「偽の詰み」(本当は押せるのに bot が詰んだと報告する) の主因だった (導入 consumer の実測)
- locals reducer も「この条件なら何もしない」を黙って `return` で書く。UI の disabled と共有されず、外からは変化なしと区別がつかない
- automations は `when` が true の間 `retryMs` ごとに action を再発行し、拒否は reducer に委ねる (ADR-0015 Decision 3)。README は「retry の拒否は log 専用の `withErrorResult` にして UI ノイズを避ける」と案内しており、engine 自身が拒否される request を量産する構造を持つ
- consumer 側で wrapper を作る案 (導入 consumer の初案) は、creator 型の導出 (`SyncedSliceActionCreator`) が synqux 内部にあり外から見えないため、同じ導出を 100 行で複製し synqux の更新で壊れる。automations の発行前判定も consumer からは触れない
- 「validation と適用を分ける」は Command パターン (CanExecute / Execute)、CQRS (command 検証 / event 適用)、Replicache の mutator と同型で、ゲーム実装者がカスタムする層ではない。ADR-0025 の採否基準「既知の primitive の型強化版」に、`withErrorResult` の延長として収まる

## Decisions

### 1. case 定義に `{ validate?, mutate, prepare? }` 記法を足す (additive)

- `createSyncedAction(type, { validate?, mutate, prepare? })` を既存 2 overload (payload / prepare) に加える第 3 の形とする。戻りは従来どおり synced action creator で、`validate` と `reducer` をプロパティとして持つ。配線は consumer が `builder.addCase(creator, creator.reducer)` と明示する (自動配線しない。理由: reducer の置き場が builder から見えなくなる。配線忘れは「何も起きない」で即バレする)
- `createSyncedSlice` / `buildCreateLocalSlice` の reducers ブロックに、plain / `{ prepare, reducer }` に加えて `{ validate?, mutate, prepare? }` の第 3 記法を足す。生成される `slice.actions.x` は `validate` を持つ
- `mutate` は従来の case reducer そのもの (immer draft を受け、validation を書かない)。`reducer` は synqux が生成する: `validate` が理由を返せば拒否、null なら `mutate`
- `validate` を省略した場合も creator の `validate` は存在し、常に null を返す。理由: UI と bot は「validate 記法の creator は全て `validate` を持つ」と一様に扱える
- 既存の記法は残す。consumer が記法を混在させるのは自由だが、「拒否は `validate`、`mutate` に書かない」を規約とする (SPEC-0001 設計ガイドラインへ追記)。validate 記法の `mutate` が `withErrorResult` を返すのは実装ミスとして扱う。synqux は検出しない。理由: `validate` を通った request が reducer で拒否されると、bot は競合と区別できない

### 2. `validate` の署名: 見える state は「その case reducer が見る state」

```ts
// synced (createSyncedAction / createSyncedSlice)
validate: (state, payload, meta?) => string | { message?, log? } | null
// local (buildCreateLocalSlice)
validate: (root, payload) => string | null
```

- 戻りは拒否か `null`。boolean にしない。理由: bot の報告と console に「なぜ拒否されたか」が出る。消費者の UI がフォームの validation error と同じ読み方で disabled にできる
- synced の拒否は **`withErrorResult` の option と同じ形** (`{ message?, log? }`、型は `SyncedRejection<TMessage>`)。`string` は `{ log }` の短縮形。理由: 競合で負けた側への UI 通知 (message) は既存 consumer の UX で、string だけだと黙って log 専用に落ちる。既存の `withErrorResult(state, action, { message })` を validate へ移すときも message を捨てずに済む。未リリースの今広げておけば、読み手 (UI) の互換を後で壊さない
- local の拒否は `string` のみ。理由: result が無く message の行き先が無い
- synced の第 1 引数は `state`。`createSyncedAction` では TSynced (withTypes の束縛)、`createSyncedSlice` ではその slice の TState。root を渡さない。理由: synced reducer は決定性のため root を読めない (ADR-0024 / ADR-0027 Rejected)。UI は `useSelector` で同じ state を選んで渡す。生成 reducer は `validate(state, action.payload, action.meta)` と呼び、draft をそのまま渡す。validate は同期的に読むだけで、書き換え・保持・参照同一性への依存を禁止する
- **`createSyncedSlice` の validate 記法は `result` を持つ state (SynquxSynced) 専用**。型で制約する。理由: 拒否は `withErrorResult` で表現するため、`result` を持たない sub-slice には書けない。合成 reducer の sub-slice は従来どおり result を top-level へ写す構成で、validate は top-level の slice か `createSyncedAction` に書く
- local の `root` は `TRoot` (buildCreateLocalSlice の束縛)。生成 reducer は `action.meta.root` を渡す。**`validate` を持つ case は root を required にする契約**: `meta.root` が無ければ throw する (store 経由では rootReducer が常に注入する。slice reducer の単体テストは `createTestRootState` で root を付ける)。ADR-0027 Decision 6 の「root は optional」は plain 記法と、`validate` を省略した mutate 記法に対して維持する。root は「適用後の synced + 宣言順で自分より前の locals + 前回の root」で、自分と後続 locals は前回値
- local の validate は meta を受けない。local action には hash / dispatched の保証が無く (LocalAction の meta は `{ root?, ...TMeta }`)、SyncedActionMeta の契約を結べない。端末ローカルの時刻が要るなら consumer が root 外から読む (locals は決定性の対象外)
- synced の `meta` は `SyncedActionMeta` (hash / dispatched / requestedBy)。時刻に依存する拒否 (期限前の発行など) は `meta.dispatched` で書く。UI やテストの事前判定は meta を渡さないので、consumer は「meta が無いときは時刻の条件を通す」と書く (規約。SPEC-0001 ガイドラインへ)
- `validate` は pure で軽く保つ (UI が毎 render 呼ぶ)。state を書き換えない

### 3. 拒否の扱い

- synced: `withErrorResult(state, action, rejection)`。`string` は `{ log: reason }` に展開する。message の有無は consumer が validate の戻りで決める (log 専用なら string、競合時に UI へ出したいなら `{ message }`)
- local: state を変えずに返す。result の概念は無い (host の裁定を通らない)。console には出さない (UI と bot は dispatch 前に `validate` を読む前提)

### 4. automations は発行前に `validate` を見る

- **automations は host だけが発行し、host は裁定者でもある**。pre-check が見る synced は、直後の裁定で reducer が見る synced と同じ端末の同じ state になる。ずれるのは評価から裁定までに他 request が割り込んだときだけで、その拒否は従来どおり reducer が出す
- registry を `Set<string>` から `Map<string, { validate? }>` にし、定義の配線フェーズ (`definition.createSynqux`) が `isSyncedAction` と並べて `validatorOf(type)` を core の config に渡す (optional。primitive 方式で core を直接使う場合は無く、pre-check も無い)。同一 type の再登録は後勝ち (dev の HMR で creator module が再評価される経路)
- engine は `automation.action(synced)` の後、その type の validate があれば `validate(synced, action.payload, meta)` を評価する。理由が返れば request を発行しない (`lastIssuedAt` も更新しない。純関数なので次の評価で再判定する)。validate の例外は `when` と同じく rule 単位で捕捉して console.error し、後続 rule の評価を続ける
- pre-check の `meta` は `{ hash: action.meta.hash, dispatched: now, requestedBy: selfId }`。host が発行者なので `requestedBy` は自端末 id で裁定時と一致する。`dispatched` は request 化で serverNow に上書きされるが、`now` も同じ時計 (synced では serverNow、standalone では Date.now) で、ずれは評価から適用までの ms 単位に収まる
- **validate で止めた事実は、rule ごとに状態が切り替わった瞬間だけ console.warn する**。「発行できる → validate で止まる」に変わった最初の 1 回で理由付きで出し、止まり続ける間は出さない。「止まる → 発行できる」に戻ったら状態をリセットし、次に止まったとき再び 1 回出す。理由: retryMs ごとに出すと console が埋まる。初回だけ永久に出さないと 2 回目の設定ミス (when が true のまま validate が常に拒否する) を見逃す。inspections には残さない (裁定の記録であり、transport 契約を増やさない)
- 裁定は従来どおり host の reducer 試し実行のみ (ADR-0001 Decision 4)。これは裁定の二重化ではなく「拒否が確定している request を transport に流さない」発行側のフィルタで、`when` と同じ位置づけ (ADR-0015 Decision 3 の「reducer が唯一の判定器、when は発行トリガー」を変えない)
- user の dispatch には pre-check を入れない。UI が `validate` で disabled にしており、それでも届く拒否は競合か実装ミスで、inspections に残す価値がある。middleware に判定を置かない原則 (AGENTS.md) も維持する

### 5. 語彙は `validate` / `mutate`

- `mutate`: 導入 consumer の拡張ポイント (spec 表) と Replicache の語。RTK の `reducer` は生成物の名前に使う
- `validate`: 戻りが理由の文字列なので、フォームの validation と同じ読み方になる。`can` は boolean を連想させるため採らない
- `candidates` (bot が列挙する候補) は**この ADR に含めない**。synqux が呼ぶ場所が無い (YAGNI)。導入 consumer の ADR も「candidates と bot は同期と無関係で synqux に入れない」と決めている。consumer は creator に `Object.assign(creator, { candidates })` で生やす。多端末 random 交錯の harness を synqux/testing に置くときだけ再考する (BACKLOG)

### 6. payload 型の導出

- `prepare` があればその引数と戻りが優先 (既存の prepare 記法と同じ)。無ければ `validate` の第 2 引数 → `mutate` の action 注釈 (`SyncedAction<P>` / `LocalAction<P>`) の順に推論する
- `validate` の第 2 引数と `mutate` の action payload が両方注釈され食い違うときは型エラーにする (RTK の `ValidateSliceCaseReducers` と同じ mapped 型で、`mutate` 側に期待型を押し付ける)
- slice 記法 (`createSyncedSlice` / `buildCreateLocalSlice`) では、`mutate` の action を注釈しないと mutate 内の `action.payload` は any になる (RTK の case reducer と同じ制約。推論が効くのは生成 creator と `validate` の側)。`createSyncedAction` は overload の generic で validate と mutate を束ねるため、どちらか一方の注釈で両方に型が付く
- `createSyncedSlice` の `SyncedSliceActionCreator` 条件型に `mutate` キーの分岐を足す。**既存の `{ prepare: infer PA }` 分岐より前に置く** (prepare 付きの新記法が既存分岐に吸われるため)
- `createSyncedAction` は options object を受ける第 3 overload。既存 overload の第 2 引数は関数 (prepare) なので object とは推論で区別できる
- `buildCreateLocalSlice` は RTK `createSlice` への素通しをやめ、mutate 記法だけ `{ prepare, reducer }` へ変換して委譲する。戻りは RTK `Slice` のまま、mutate 記法の `actions.x` に `validate` を交差で足す

## Rejected Alternatives

- **consumer 側の wrapper (導入 consumer の初案)**: creator 型の導出を複製し、synqux の更新で壊れる。automations の発行前判定に届かない。定義の形はゲーム実装者がカスタムしない層なので、library が持つのが自然
- **拒否関数を consumer が定義し、reducer と `when` と UI で共有する (記法を足さない)**: 規約であって API ではなく、流用先で崩れる。automations engine からは届かない。型導出の複製を避けるだけならこれでも足りるが、本 ADR の目的は「拒否の置き場を API で 1 つにする」こと
- **synced の validate に部分 root `{ [syncedKey]: state }` を渡す**: UI が完全 root をそのまま渡せる利点はあるが、sub-slice では key の中身が sub-state になり、呼び元で形が変わる。「その case reducer が見る state」に揃える方が規約が 1 つで済む
- **`validate` を boolean にする**: 理由が消える。bot の報告と debug 表示に使えない
- **`validate` の戻りを `string | null` だけにする (初案)**: シンプルだが、競合時の UI 通知 (message) を表現できず、既存 reducer の移植で message を捨てる判断を強いる。リリース後に object を足すと読み手が壊れる
- **host 裁定で `validate` を先に呼ぶ**: 試し実行がそのまま判定で、二重化する意味が無い
- **user dispatch の middleware pre-check**: 判定の分散 (AGENTS.md)。競合による拒否が inspections から消える
- **automations の未発行を毎回 log する / inspections に残す**: retryMs ごとの log はノイズ。inspections は裁定の記録で、automation 用の record を足すと transport 契約が増える
- **`candidates` を記法に含める**: synqux に呼ぶ場所が無い。consumer の ADR も synqux に入れないと決めている
- **factory が reducer を自動配線する**: 配線の置き場が builder から見えなくなる。明示配線で足りる
- **`can` / `apply` と命名する**: どちらも業界標準ではない。消費者の既存語と戻り値の意味に合わせる
- **local の validate で root 欠落時に skip する**: 単体テストで validation が黙って外れる。throw で fail-fast にする
- **local の拒否を dev build で console.debug に出す**: UI と bot は dispatch 前に `validate` を読む前提で、黙って無視が仕様。bot 運用で困ったときに足す

## Consequences

- consumer は「拒否は `validate`、適用は `mutate`」の 1 規則で synced / local を同じ形で書ける。UI と bot は `validate` を読むだけで、条件を写さない
- automations の retry が拒否される request を transport に流さなくなる。README の「log 専用 withErrorResult でノイズ回避」案内は「validate を書けば発行されない」に変わる
- `assertActionIdempotency` の `rejects-repeat` は変えない。2 回目の拒否が `validate` 由来かは実装詳細で、harness の契約は「2 回目が error result」で足りる
- semver: additive な minor (0.21.0)。既存の prepare / plain 記法と公開 API は変えない。内部の registry 型は変わる。`buildCreateLocalSlice` の runtime が素通しから変換付きになるが、plain / prepare 記法の生成物は RTK と同一
- 更新対象: SPEC-0002 (defineSynqux / buildCreateLocalSlice の記法、CreateSynquxConfig の `validatorOf`)、SPEC-0001 設計ガイドライン (拒否の置き場、meta 無しの時刻条件)、README (createSyncedSlice の例と automations の案内)、`src/index.test.ts` (公開面)
- 導入 consumer は自前 wrapper 案を取り下げ、この記法を採用する

## Progress

- 2026-10-12: 起票。導入 consumer の壁打ち (consumer wrapper → library) から移管。Codex レビュー 8 件 (root の型、automations の meta、local の meta、初期化時の root、registry の接続、型分岐の順序、consumer 名、述語共有案) を反映
- 2026-10-12: Accepted。synced の validate を部分 root から「case reducer が見る state」へ変更。automations の pre-check を「host が発行者かつ裁定者」で整理し、未発行の通知を遷移時 1 回の console.warn に決定。Open Questions を全て閉じた (rejects-repeat は変えない、candidates / harness は BACKLOG、local の拒否は出さない)。実装は TASK-261012-validate-mutate
- 2026-10-12: synced の validate の戻りを `string | null` から `withErrorResult` の option 互換 (`SyncedRejection`) へ広げた。string は `{ log }` の短縮形
- 2026-10-12: 実装完了 (TASK-261012)。Codex レビュー 4 件を反映 (primitive state の local 拒否、prepare 付き記法の整合検査、standalone の dispatched、replaceRules 後の抑止状態)。automations の pre-check は stamp した meta (hash と `dispatched = now`) をそのまま dispatch し、pre-check と実 request の meta を揃える
