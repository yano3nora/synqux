# ADR-0017: listeners (適用済み synced action への宣言的購読)

- Status: **Accepted** (2026-08-13 裁定。経緯は `TASK-260812-side-effects.md`)
- Date: 2026-08-13
- 関連: ADR-0015 (automations), ADR-0007 (repeat contract), ADR-0008 (result 2 系統), TASK-260812-side-effects, TASK-260812-consumer-boilerplate-absorption B (`selectSyncPhase` / `selectIsLive`)

## Context

「同期グループ内で特定の synced action が適用されたら副作用を実行する」パターンは消費 repo 群で 2 系統に分かれる。

1. **host だけが実行するもの**: 社内管理画面への進行状態送信 (survey の PUT upsert) が頻出。旧世代 consumer は rxjs `action$` + `useGameObserver({ condition: host })` を React component から購読していた
2. **全端末が実行するもの**: 効果音・演出トリガー・端末ローカルな analytics など。現行世代は RTK listener middleware の手書き

現行テンプレ世代で rxjs observer 導線を全削除した結果、両系統とも RTK listener middleware の手書きに置き換わり、毎 consumer が同じ 3 つのゲートを繰り返す構造が残った。

- **配置順序**: listener middleware は synqux middleware の**後段**に置かないと「request 化で握りつぶされた action」(未適用) で発火する。配置は暗黙知で、型でもテストでも守られない
- **live / replay の区別**: subscribe 中の復帰 replay で再適用された action もそのまま listener に届く。ゲートし忘れると host リロードのたびに外部再送・効果音の一斉再生が起きる。TASK-260812-consumer-boilerplate B で `selectIsLive` が公開され「書けなくはない」状態にはなったが、書き忘れは残る
- **host gating**: `selectIsHost` は `setEnabled(false)` 中に常時 true を返すため手動ゲートの材料として不適 (TASK-260811 作業ログの裁定)。正しくは presence 由来の `deriveHostId` 直参照だが、これは engine 内部にしかない。手動ゲートの書き忘れは全端末 fan-out として顕在化する

さらに、host-only の処理と everyone の処理が「createSynqux config (automations)」と「store 構築側の listener middleware」に分散し、同期起因の副作用の全景を 1 箇所で読めない。

検討して棄却した代替案:

- **consumer の RTK listener 手書き継続**: 上記 3 ゲートの反復。ゲート失敗が外部システムへの再送・fan-out として現れるため、失敗コストが consumer 内に閉じない
- **automations への統合** (「`when` 述語 + effect」として寄せる案): automations の自己終了契約 (適用で `when` が false に戻る) は「送信済み」が synced state に存在しない外部通知では成立しない。retry 前提のセマンティクスも冪等 PUT・one-shot な演出トリガーと噛み合わない。action-triggered one-shot が実態に合う
- **synqux が listener middleware を別途 export する案**: 配置順序の責任が consumer に残り、ゲート群も option 化で複雑になる。発火点を engine 内に閉じる方が構造的に安全

## Decisions

1. **`listeners` を core に追加する**。`createSynqux` config に宣言的ルール表を受け、engine が synced action の**実適用完了点**で評価・発火する。命名は当初案 `sideEffects` から変更 — redux 文脈で意味が広すぎ、「RTK listener middleware の synqux 版 (配置順序とゲートを engine が肩代わりするもの)」という位置づけを名前で示す。dispatch できない点が RTK の語感と異なるため、JSDoc と SPEC で明示する

   ```ts
   export type SynquxListener<TSynced, TAction extends Action> = {
     /** rule の識別子。配列内で重複したら createSynqux が throw */
     id: string
     /** 発火トリガー。適用された synced action に対して評価される (拒否された request では評価されない)。RTK の matcher (`isAnyOf` 等) をそのまま渡せる */
     match: (action: TAction) => boolean
     /** 'host-only': host 端末のみ発火 (外部通知向け) / 'everyone': 適用した全端末で発火 (演出・analytics 向け)。fan-out 事故の既定値を作らないため必須 */
     mode: 'host-only' | 'everyone'
     /** 副作用本体。dispatch は渡さない (Decision 6)。throw / rejection は握りつぶす (Decision 7) */
     effect: (action: TAction, ctx: { synced: TSynced }) => void | Promise<void>
   }

   // CreateSynquxConfig へ追加
   listeners?: SynquxListener<TSynced, TAction>[]
   ```

2. **発火点は「自端末での synced action の実適用完了直後」** — actionRequestMiddleware の `next(action)` 直後、automations の適用後評価トリガーと同じ点。同期適用 (responseListener 経由の再入 dispatch) と local 適用 (standalone / `setEnabled(false)`) の両方を捉え、request 化で握りつぶされた未適用 action では発火しない。effect が読む `ctx.synced` は適用後 state。これにより consumer が配置順序を管理する必要が構造的に消える。effect は同期パスから fire-and-forget で起動し (`void Promise.resolve(effect()).catch(...)`)、適用パスを block しない。複数 rule が match した場合は配列順に起動する
3. **live 配信のみ発火する**: `synqux.phase === 'live'` のときだけ評価する。restore replay 中 (`'subscribing'`) の再適用では発火しない。standalone も subscribe 完了後は `'live'` になるため同じ契約で動く。これが本機構の中核価値であり、mode によらず適用する (効果音・analytics も replay 再発火は事故)
4. **`'host-only'` の host 判定は automations と同一**: presence 由来の `deriveHostId` 直参照。`selectIsHost` は使わない。standalone は常時 host 扱いで発火する
5. **配達保証は best-effort に倒す**: host が「適用後・effect 完了前」に落ちたら発火は失われ、新 host は過去 action を遡って再発火しない (引き継ぎ状態ゼロの原則、ADR-0015 Consequences と同型)。dual-host 窓では二重発火があり得る。したがって effect には**冪等契約** (同じ内容の再実行が安全であること) を課す。頻出ユースケース (survey の PUT upsert = 毎 phase 上書き) は取りこぼしても次の発火で回復するためこの契約と整合する。`'everyone'` は「その端末が適用したときに 1 回」であり、端末間の実行回数は揃わない (未購読・離脱端末は実行しない)
6. **effect に dispatch は渡さない** (automations との役割排他): synced action の dispatch は `'everyone'` では全端末 fan-out、`'host-only'` では automations の領分 (state 述語駆動 + retry) の再発明であり、渡すと automations の存在意義が消える。また「synced action に全端末が追従すべき local state」は listener での dispatch ではなく locals reducer の extraReducers で表現すべきで (決定的で dispatch 不要)、dispatch の提供はその記述を分散させるきっかけになる。残る「local action の dispatch を伴う反応」(modal を開く等) は従来どおり consumer の RTK listener に残す — 本機構は通知・演出・記録の fire-and-forget に限定する。runtime 検証は行わない (型で渡さないことが契約。closure 経由の dispatch まで塞ぐ費用対効果がない)
7. **失敗の扱い**: effect の同期 throw / rejection は `console.error` して握りつぶし、engine と他 rule は止めない。retry は提供しない (best-effort 契約の帰結。回復が必要なら次の発火 = 次の進行イベントに委ねる)
8. **enabled gate は設けない** (ADR-0015 Decision 4 踏襲): `setEnabled(false)` 中の local 適用でも発火する。tutorial 中に実行したくない rule は consumer が述語 (synced 上のフラグ等) で制御する。standalone も発火する — localhost 開発で外部送信が走る点は consumer 側の env ガード責務 (管理画面連携は origin 未設定で no-op になる慣行)
9. **`match` が読めるのは action のみ**: previous / synced は渡さない (旧世代 consumer の実測で不要。「state がこの値に変わったら」型は automations + synced フラグで表現する)。TS の型 narrowing (type predicate による effect 引数の絞り込み) は v1 では提供しない — ルール配列の型を per-rule generics にする複雑さに見合わない。effect 内で narrowing する

## Consequences

- 消費 repo の「synqux middleware 後段の listener + isLive ゲート + host ゲート」の手書きが「rule 1 エントリ」に縮み、配置順序・replay 再送・fan-out の 3 事故クラスが構造的に消える
- host-only / everyone の同期起因副作用が `createSynqux` config に集約され、automations と並んで「同期が駆動する自動挙動」の全景を 1 箇所で読める
- host migration の引き継ぎ状態はゼロ — 新 host は以後の適用で発火するだけ。遡り発火・queue 移譲はない
- dispatch を渡さないため、local dispatch を伴う反応は consumer の RTK listener に残る (本機構が RTK listener を全廃するわけではない)。実測で要求が出たら「synced action は拒否するガード付き dispatch」を追補で検討する
- API 表面積の増分は型 1 つ + config 1 項目。breaking change なし (minor release)

## Amendment (2026-08-13): setEnabled の廃止 (ADR-0018)

runtime の `setEnabled(false)` は ADR-0018 で廃止され、tutorial は standalone session
(`subscribe({ mode: 'standalone' })`) で表現されるようになった。Context の
「`selectIsHost` は `setEnabled(false)` 中に常時 true」および Decision 2 / 8 の
setEnabled 言及は standalone session に読み替える (standalone は host 常時 true のまま)。
本文は当時の記録のまま残す。

## Amendment (2026-08-16): replay 非発火の正の移動と `fire` option (ADR-0021)

Decision 3 の「live 配信のみ発火する (`synqux.phase === 'live'` のときだけ評価)」は、
初回購読では live 遷移が transport の初回一括配送より先に完了するため構造的に
成立していなかった (reset reload 無限ループのインシデント)。ADR-0021 により

- replay 非発火の正は「**既裁定のまま added で届いた envelope の適用 (replay 印)
  では発火しない**」(ADR-0021 Decision 2) へ移り、phase ゲートは防衛線に格下げ
- live の意味論自体も初回購読 barrier (ADR-0021 Decision 1) が復元
- rule ごとの `fire?: 'applied' | 'persisted'` (ADR-0021 Decision 3) が追加され、
  スレッドを止める UI / navigation を含む effect は `'persisted'` が必須

と読み替える。

## Amendment (2026-08-13): local action の監視 (ADR-0020)

Decision 6 の「local action の反応は consumer の RTK listener に残す」という境界は、
ADR-0020 により「local action の **dispatch を伴う**反応だけが残る」へ縮小された。
fire-and-forget な反応は `scope: 'all'` で synqux listeners に集約できる。
