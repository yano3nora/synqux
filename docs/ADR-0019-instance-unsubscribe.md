# ADR-0019: instance-level unsubscribe

- Status: **Accepted** (2026-08-13)
- Date: 2026-08-13
- 関連: ADR-0018 (session 固定 mode), ADR-0012 (subscribe の abort), SPEC-0001 (tutorial 節), SPEC-0002 (公開 API)

## Context

ADR-0018 で tutorial は「unsubscribe → subscribe の session 作り直し」で表現することになった。しかし unsubscribe の唯一の入口は `subscribe()` の返り値 closure (`Promise<() => Promise<void>>`) であり、consumer に 2 つの問題を残している。

1. **closure の持ち回り**: 初回 subscribe (bootstrap) と tutorial thunk は別ファイルにあるのが通常で、closure を共有するには consumer 側に mutable な module 変数が必要になる。これは本ライブラリ自身が移植元の反省として排除した module 変数方式 (SPEC-0001 既知の問題) を、consumer に押し付ける構図である。再代入を挟む分、subscribe 失敗時に「実行済みの古い closure」が変数に残り、consumer の認識とライブラリの session 状態がズレる失敗経路もある。
2. **react hook は closure を破棄している**: `useSynquxSubscription` は購読開始専用の入口として設計され、返り値 closure を保持しない。つまり react hook 経由の consumer には unsubscribe の手段が存在せず、ADR-0018 の tutorial パターンがそもそも組めない。

一方で instance は `session` / `subscribing` を内部に持ち、「already subscribed」を判定できる唯一の主体である。instance 1 つにつき session は最大 1 本という不変条件があるため、「現在の session を畳む」操作は instance 上で曖昧なく定義できる。

## Decisions

1. **`Synqux` instance に `unsubscribe(): Promise<void>` を追加する**。現在の session の teardown (返り値 closure と同一の逆順 cleanup) を実行する。
2. **未 subscribe 時は no-op で resolve する** (throw しない)。`setRole` / `dispatchAndWait` の「未 subscribe は throw」と非対称だが、それらが「session を前提とする操作」なのに対し unsubscribe は「session が無い状態へ持っていく操作」であり、目標状態に既に居るなら成功として扱う (冪等)。tutorial thunk や React の teardown 経路から無条件に呼べることを優先する。
3. **`subscribing` (初期化 in-flight) 中は throw する**。in-flight の中断は ADR-0012 の通り subscribe options の `AbortSignal` が唯一の契約であり、unsubscribe に第二の中断経路を持たせない。
4. **teardown は session 単位の single-flight にする**。instance の `unsubscribe()` と返り値 closure は同一 session の同一 teardown を共有し、並行・重複呼び出しは同じ Promise を返す。破棄済み session の closure を後から呼んでも、新しい session には一切作用しない (現状は古い closure の再実行が cleanup を二重実行し得る latent bug であり、これも同時に塞ぐ)。
5. **`subscribe()` の返り値 closure は互換のため維持する**。追加のみの minor change とし、既存 consumer のコードは壊さない。ドキュメント (README / SPEC-0001) の tutorial 例は instance method 前提へ書き換える。
6. **teardown 進行中は第 3 の状態「unsubscribing」として扱う** (2026-08-13 review 追補)。逆順 cleanup の途中で `endSubscriptionSession` が `session = null` にするため、`session` の有無だけでは idle と teardown 進行中を区別できず、(a) 進行中の `unsubscribe()` が即時 resolve で嘘をつく、(b) `subscribe()` がガードをすり抜けて新 session を張り、旧 teardown の `disconnect()` / phase idle 化が新 session を破壊し得る穴があった。対策として instance が teardown の in-flight Promise を保持し、進行中の `unsubscribe()` は同じ Promise を返し、進行中の `subscribe()` は throw する (メッセージで unsubscribe の完了待ちを案内)。

## Consequences

- tutorial thunk は `synqux.unsubscribe()` → `synqux.subscribe({...})` と instance だけで完結し、consumer 側の closure 持ち回り変数が消える。react hook 利用時も同様に組める (hook 自体の変更は不要)。
- 返り値 closure と instance method の二重呼び出し・stale closure 呼び出しは single-flight により無害化される。teardown が cleanup 失敗で reject した場合も全 cleanup は実行済み (`runSubscribeCleanups` は失敗しても続行するため) であり、session は終了している。
- 追加 API は 1 メソッドで、mode や phase の状態機械には手を入れない。`SYNQUX_SCHEMA_VERSION` も変更しない。
- instance のライフサイクルは idle → subscribing → subscribed → unsubscribing → idle の 4 状態になり、`subscribe()` は idle 以外の全状態で throw する。consumer は `await synqux.unsubscribe()` してから subscribe すればこの状態を意識する必要はない。
