# ADR-0028: channels — 裁定なし高頻度同期チャネル (LWW KV)

- Status: **Accepted**
- Date: 2026-09-01
- 関連: ADR-0001 (transport 抽象)、ADR-0009 (trust model)、ADR-0023 (react slim)、
  SPEC-0002、`TASK-260901-channels.md`

## Context

- 移植元系 consumer (fc-310 docs/TASK-260901-whiteboard-features.md 参照) は
  マウスカーソル座標とドラッグ中のオブジェクト座標を「RTDB 直書き + throttle(70ms) +
  onDisconnect + jotai」で同期しており、同型実装が 3 回複製されている (cursors /
  card-positions / block-positions)
- この種のデータは requests 経路と要件が正反対: 高頻度 (mousemove)、per-key の
  最新値だけが意味を持つ (LWW)、裁定・順序保証・正史 (snapshot) が不要、
  むしろ request 化すると帯域と host 裁定を無意味に食い潰す
- 一方で「移植元の直書き」は synqux の transport 抽象の外にあるため、standalone
  mode で動かず、MemoryHub でテストできず、切断 cleanup の実装も consumer 任せ
- presence (Peer) は role / label / lastSeenAt 固定で、座標のような任意 payload を
  載せる口は意図的にない (host 導出・heartbeat と結合しているため)

## Decision

1. **第 4 チャネル「channels」を新設する**。(channel, key) ごとの
   last-write-wins な KV で、裁定・順序保証・snapshot/restore の対象外。
   requests (正史) / snapshot (復元) / presence (接続) と責務が重ならない
2. **transport 契約へ optional メソッド 3 つを追加する**
   (`publishChannel` / `removeChannelValue` / `subscribeChannel`、契約 14-16)。
   optional なのは pruneRequests / subscribeSnapshotFence と同じ整理 —
   correctness に関与しない拡張機能のため、未対応 adapter も synced 同期自体は
   従来どおり成立する。channels を使う subscribe だけが fail-fast で拒否される
3. **payload は core が JSON 直列化し、adapter は不透明文字列を運ぶ**
   (RequestEnvelope.payload と同じ原理。形状保存問題を core で一度だけ解く)
4. **cleanup 政策は channel 単位で宣言する** (`cleanup: 'disconnect' | 'none'`)
   - `'disconnect'`: publish した接続の切断 (プロセス死含む) で値が削除され、
     onRemoved が全端末へ配送される。カーソル用 (key = selfId を推奨)
   - `'none'` (既定): session 中は保持される。ドラッグ座標用。物理削除は
     connections / requests と同じく group 終了時の data lifecycle (consumer 責務)
5. **instance API は `synqux.channel<T>(name, options)`**。返る handle は
   `publish(key, value)` (fire-and-forget) / `remove(key)` / `subscribe(handlers)`
   - **Redux store を通さない**。高頻度データが reducer / middleware / DevTools を
     通ると再レンダーとログの嵐になる — 移植元が jotai を導入した理由そのもの。
     React binding (jotai 等) は consumer 責務 (ADR-0023 の react slim と同じ線)
   - publish の throttle は core が持つ (per-key、leading + trailing、既定 70ms =
     移植元実測値)。移植元の rxjs throttleTime (leading only) には「最終値が
     配送されない」欠陥があり、trailing 保証で修正する
   - handle は session を跨いで生存する。session 未開始の publish は静かに drop
     (mousemove handler は接続前から発火するため throw は UX 事故)、subscribe は
     session 開始時に自動 attach・終了時に detach される
6. **standalone は in-memory self-loop で同一意味論**。publish → 自端末の購読へ
   非同期配送 (RTDB の local echo と同じ観測順)。値は session 中 in-memory 保持し、
   途中購読にも既存 entry を配送する。永続化しない — リロード復元が必要な値は
   consumer が synced state へ commit する (規約は consumer 側 ADR)

## Rejected Alternatives

- **presence (updateSelf) への任意 payload 拡張**: presence は host 導出・
  heartbeat・再登録と結合した接続管理チャネルで、mousemove 頻度の書き込みを
  混ぜると onChanged の嵐が host 判定系全体に波及する。責務が違う
- **requests 経由 (synced action 化)**: 裁定・seq 採番・封筒永続化のコストが
  LWW データに全て無駄。移植元も最初から分離していた
- **consumer 直書きの継続 (現状維持)**: 3 回複製の重複に加え、standalone /
  テスト不能・cleanup 手実装という構造問題が template 化で更に複製される
- **React binding (jotai) の同梱**: synqux は react optional peer の slim 方針
  (ADR-0023)。atomFamily の粒度設計は consumer の UI 事情
- **channels の snapshot 永続化**: 「非永続・session scoped」が要件。永続が
  必要な値は synced state の領分で、二重の正史を作らない

## Consequences

- SynquxTransport に optional 3 メソッドと契約 14-16 が増える。adapter 実装者の
  負担は増えるが、未実装でも既存機能は完全動作する
- channel データはゲームの正誤判定に使ってはならない (裁定・順序・復元の外)。
  判定に使う値は synced へ明示 commit する — この規約は consumer 側で ADR 化する
- cleanup 'disconnect' の (channel, key) は publisher-unique な key (典型は
  selfId) が**必須契約**。複数端末が同一 key へ publish した場合の削除
  タイミングは未定義 — firebase では全 publisher の onDisconnect 予約が残る
  ため、過去のどの publisher の切断でも最新値が消え得る
- 型パラメータ T は宣言であり検証されない (payload の実在検査をしない
  isSyncedAction と同じ trust model、ADR-0009)
