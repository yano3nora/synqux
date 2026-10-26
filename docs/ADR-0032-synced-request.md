# ADR-0032: createSyncedRequest — host の外部 I/O を synced action にする

- Status: **Accepted**
- Date: 2026-10-26
- 関連: ADR-0007 (action repeat contract)、ADR-0015 (automations)、ADR-0017 (listeners)、ADR-0021 (replay 非発火と fire option)、ADR-0026 (定義フェーズ)、ADR-0031 (validate / mutate 記法)、SPEC-0002

## Context

- consumer には「host だけが外部 I/O をして、結果を全端末に配る」処理がある。代表は AI への問い合わせ。参加者の発言を host が AI に送り、返答を synced state に入れる
- 既存の primitive では書けない
    - automations は同期で、synced state から action を返すだけ
    - listeners は effect に dispatch を渡さない (ADR-0017 Decision 6)
- 導入 consumer は公開 API だけで仮実装した。host-only listener に dispatch を注入する形である。listener 契約の外だが、発火点 (適用時、host だけ、live のみ) が欲しい形と一致した。仮実装を使って、形が次の 4 点で固まった
    - 1 つの依頼を `requested` / `resolved` / `aborted` の 3 つの synced action に分ける
    - 台帳を synced state に置き、同じ key の処理中は次の依頼を拒否する
    - timeout は automation にし、host 交代で perform を引き継がない
    - 遅れた結果・二重の結果は、台帳の id 照合で落とす
- consumer 側に残すと、listener の契約外の配線を consumer ごとに書き直すことになる。live のみ発火、host 交代時の二重発火と欠落、replay 除外は engine の領分である

## Decisions

### 1. `createSyncedRequest` を定義フェーズに足す

- `defineSynqux` の戻り値に `createSyncedRequest` を足す。3 つの action は定義の `createSyncedAction` で作り、registry に登録する。理由: 定義を通らない creator を作らせない (ADR-0026)
- 戻り値は `{ key, requested, resolved, aborted, reducer }`。`reducer` は 3 action の `addCase` で、synced slice の `extraReducers` に渡す
- 3 つの creator は validate / mutate 記法 (ADR-0031) で作る。UI と bot は `requested.validate` で押下条件を読める

```ts
const ask = createSyncedRequest<{ text: string }, { answer: string }>({
  key: 'ask',
  request: { validate, mutate },          // 処理中の拒否は primitive が先に行う
  resolve: { mutate: (state, action, inflight) => {} },
  abort: { mutate: (state, action, inflight) => {} },  // reason: 'timeout' | 'failed'
  timeoutMs: 20_000,
  perform: async (payload, { synced }) => output,      // host だけが実行する
})
```

### 2. 配線は engine の内部に閉じる

- `createSynqux({ requests: [ask] })` で宣言する。engine は request ごとに timeout の automation と perform の listener を作り、consumer の rule と同じ engine に載せる
- perform の結果は engine が dispatch する。consumer に dispatch を渡す口は作らない。ADR-0017 Decision 6 は変えない
- 結果は perform 開始時の session にだけ流す。unsubscribe した後や別の session では捨てる
- perform の listener は consumer の listeners より前に置く。理由: 配列の末尾は reload などの終端 listener の置き場である (ADR-0021 Decision 5)
- `replaceRules` は `requests` も受ける (dev の HMR 用)

### 3. 台帳は consumer の synced state に置く

- synced state に `inflight: InflightState` を要求する。`result` と同じく型で要求し、consumer が `inflight: {}` で初期化する。持たない state で `createSyncedRequest` を呼ぶと型エラーになる
- `inflight[key]` は処理中の 1 件か null。1 件は `{ id, requestedAt, requestedBy, payload }`。`id` は requested の hash、`requestedAt` は requested の dispatched (サーバ基準時刻)
- 理由: 拒否の判定 (`validate`) が台帳を読むので、台帳は synced state に無いといけない。snapshot と restore にもそのまま乗る
- 名前は `inflight` にする。理由: `PendingRequest` は request 封筒の型名として既に export している

### 4. 発火と失敗の規則

- requested: 同じ key の台帳があれば拒否する。無ければ台帳に書いてから利用側の mutate を呼ぶ
- resolved / aborted: 台帳の id と一致しなければ拒否する。一致すれば利用側の mutate を呼んでから台帳を消す。同じ action の再適用は拒否になる (ADR-0007 の rejects-repeat)
- perform は requested の適用時に、host だけで、live のときだけ走る。発火の規則は listeners と同じである (ADR-0017、ADR-0021)
- perform が throw したら `aborted({ reason: 'failed', detail })` を出す。detail は throw した値の message
- timeout は automation が出す。条件は `now >= requestedAt + timeoutMs` で、誰が host でも同じ式である
- host 交代で perform は引き継がない。新しい host は時間切れを待って aborted を出す。restore で戻った台帳も同じ扱いになる
- dual-host 窓の二重発火と、timeout 後に届いた結果は、id 照合が落とす。落とした request は log 付きの error result になる

### 5. 入れないもの

- 再試行。理由: 再試行の方針 (回数、どの失敗で再試行するか) は consumer ごとに違う。consumer は aborted を見て requested を出し直せる
- perform の中断 (AbortSignal)。timeout 後も perform は最後まで走り、結果は id 照合で捨てる
- 1 つの key に複数件を積む queue。直列化は 1 件に限る

## Consequences

- consumer は listener への dispatch 注入をやめ、`requests` の宣言 1 行で配線できる
- API の増分は定義の関数 1 つ、config の項目 1 つ、型 8 つ。破壊的変更は無い (minor release)
- 外部 I/O の結果は必ず synced action を通る。全端末は同じ結果を同じ順で適用する
- perform は timeout 後も止まらない。外部 API の費用は捨てた結果の分も掛かる。頻発するなら Decision 5 の中断を検討する
- 導入 consumer の仮実装はそのまま動く。synqux 版へ移すかは consumer が決める
