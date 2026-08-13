# ADR-0020: listener scope (local action dispatch への opt-in 監視)

- Status: **Accepted** (2026-08-13)
- Date: 2026-08-13
- 関連: ADR-0017 (listeners), TASK-260813-listener-scope

## Context

ADR-0017 の listeners は「適用済み synced action」だけを発火対象とし、local action
(`isSyncedAction` が false の action) への反応は consumer の RTK listener に残した。
しかし ADR-0017 Decision 6 が棄却したのは「effect から local action を **dispatch** する」
話であり、「local action を **match** する」ことは検討されていなかった。

local action の監視を engine 側で提供する根拠:

- **ゲートの書き忘れの構造的排除** (ADR-0017 Context と同じ): host 判定自体は
  ADR-0018 以降 `selectIsHost` が engine 内部の判定と一致するため consumer でも
  書けるが、live ゲート・host ゲートを rule 1 エントリに畳むことで書き忘れの
  余地を消せる。live ゲート (`selectIsLive`) の手書きは特に漏れやすい
- 適用後 `ctx.synced` と「同期起因の副作用を config 1 箇所で読める」利点も
  そのまま local action に乗る。RTK listener middleware の配置・購読管理という
  boilerplate 自体も不要になる

一方で無条件に全 listener の評価対象を広げると、既存 rule の手書き matcher
(type 文字列チェックでないもの) に local action が流れて挙動が変わるため、
既定挙動は変えられない (実質 breaking)。

## Decisions

1. **rule ごとの `scope?: 'synced' | 'all'` を追加する (既定 `'synced'`)**。
   既存 rule は挙動不変 (minor release)。`'local'` 単独 scope は作らない —
   action type は synced / local で排他なので matcher で表現でき、YAGNI
2. **型は discriminated union にする**: `scope: 'all'` の rule だけ `match` / `effect` の
   action 型を `Action` に広げる。narrowing は RTK matcher (`isAnyOf` 等) か effect 内で行う
3. **発火点は従来と同一** (actionRequestMiddleware の `next(action)` 直後)。local action は
   request 化されず常にそのまま適用されるため、「実適用完了直後」の契約は同型に保たれる
4. **synqux 内部 action では発火しない**: `scope: 'all'` でも `isSynquxAction` に該当する
   内部 slice action (presence 更新等の高頻度 action を含む) は listener 評価に流さない。
   内部 action の型は実装詳細であり、consumer の matcher が結合するきっかけを作らない
5. **ゲート・失敗隔離は scope によらず同一**: live ゲート (`phase === 'live'` のみ発火。
   subscribe 完了前の local action では発火しない)、`'host-only'` の `deriveHostId` 判定、
   effect の fire-and-forget と失敗の握りつぶし、冪等契約・dispatch 非提供は
   ADR-0017 Decision 2〜7 をそのまま適用する

## Consequences

- consumer の RTK listener に残るのは「local action の dispatch を **伴う** 反応」
  (modal を開く等) だけになり、fire-and-forget な反応は action の種別によらず
  listeners へ集約できる (ADR-0017 Decision 6 の境界の縮小)
- 既存 consumer は挙動不変。`scope: 'all'` を書いた rule だけが全 action 評価の
  コストと型の widening を負う
- local action は端末ローカルな出来事なので、`'everyone'` × local は
  「dispatch した端末で 1 回」を意味する (他端末には流れない)。端末間の実行回数が
  揃わない点は ADR-0017 Decision 5 の contract と同じ

## Amendment (2026-08-13): ctx.self の追加

導入 consumer の実測 (local action 起点の role 昇格 listener) で、effect が自端末の
presence role を読む必要が出た。role は `ctx.synced` にも locals にもない synqux
自身の presence 状態で、consumer が store 参照の closure で読もうとすると
listeners 定義 → store 構築の依存方向と逆行して import cycle になる。

そこで effect の ctx を `SynquxListenerContext<TSynced> = { synced, self }` とし、
**`self: Peer | null`** (自端末の presence peer。echo 未着・未接続は null) を追加した。
「locals は渡さない」原則 (ADR-0015 Decision 2 と同型) は維持する — self は
locals ではなく engine 自身の状態であり、host ゲートが presence を参照するのと
同じ層の公開である。root 全体を渡す案は locals が漏れるため棄却した。
