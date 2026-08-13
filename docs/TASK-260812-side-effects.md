# TASK-260812: listeners (適用済み synced action への宣言的購読。旧称 sideEffects)

- 目的: 「同期グループ内で特定の synced action が適用されたら副作用を実行する」ユースケースを library 機構として提供する。automations (ADR-0015) が「host 駆動の自動 **dispatch**」なのに対し、本件は「適用に反応する **副作用**」— 対になる機構として設計する。`mode: 'host-only'` (外部通知) と `mode: 'everyone'` (演出・analytics) の 2 系統を 1 つのルール表に集約する (2026-08-13 ユーザ裁定で当初の host-only 専用案から拡張)
- 背景: 消費 repo 群では社内管理画面への survey 送信として頻出するパターン。旧世代 consumer は rxjs `action$` + `useGameObserver({ condition: host })` を React component (`ui/components/app-container.tsx`) から購読して実装していた。現行テンプレ世代の consumer で rxjs observer 導線を全削除した結果、置き換え先が RTK listener middleware の手書きになり、下記の穴埋めを毎 consumer が繰り返す構造が残った
- 設計の正: `ADR-0017-listeners.md` (**Accepted**, 2026-08-13)。本書の「設計コンセプト」「論点」は起票時点の整理であり、ADR と食い違う場合は ADR が正
- 関連: ADR-0015 (automations), ADR-0007 (repeat contract), TASK-260812-consumer-boilerplate-absorption B (replay/live 可視化)

## consumer 側で構造的に解決できない問題 (library 行きの根拠)

1. **live / replay の区別**: subscribe 中の復帰 replay で再適用された action か、購読完了後のライブ配信かを consumer の listener は区別できない。区別せず外部送信すると host のリロードのたびに過去分を再送する。判定材料 (subscribe の進行 phase) は synqux 内部にしかない
2. **host gating と host migration**: `condition: host` の手動ゲートは書き忘れで全端末 fan-out する。host 交代を跨ぐと React の購読張り直しタイミング次第で漏れ・重複が出る。automations が engine 内で host 導出しているのと同じ理屈で、engine 側で閉じるべき判定
3. **React lifecycle への寄生**: 旧世代 consumer の実装は component の mount に副作用の生存が紐づく。headless な dedicated host でも動く必要があるため react 層には置けない (ADR-0015 Decision 1 と同じ制約)

## 設計コンセプト (ADR 起草のたたき台)

- automations と対称の宣言的ルール表を `createSynqux` config で受ける (仮称 `sideEffects`。命名は論点参照)

  ```ts
  export type SynquxSideEffect<TSynced, TAction extends Action> = {
    /** rule の識別子。配列内で重複したら createSynqux が throw */
    id: string
    /** 発火トリガー。synced action の適用完了に対して評価される */
    match: (action: TAction) => boolean
    /** 外部通知本体。dispatch は禁止 (automations と役割排他) */
    effect: (action: TAction, ctx: { synced: TSynced }) => void | Promise<void>
  }

  // CreateSynquxConfig へ追加
  sideEffects?: SynquxSideEffect<TSynced, TAction>[]
  ```

- **発火点**: host が synced action の適用を完了した直後、かつ**ライブ配信のみ** (restore replay では発火しない)。これが本機構の中核価値
- **発火主体**: 自端末が host のときだけ。host 判定は automations と同じく presence 由来の `deriveHostId` 直参照 (`selectIsHost` は `setEnabled(false)` 中に常時 true を返すため使わない — TASK-260811 作業ログの裁定を踏襲)
- **配達保証は best-effort (at-most-once 寄り) に倒す**: host が「適用後・effect 完了前」に落ちたら発火は失われ、新 host は過去 action を遡って再発火しない (引き継ぎ状態ゼロの原則、ADR-0015 Consequences と同型)。逆に dual-host 窓では二重発火があり得る。したがって effect には**冪等契約** (同じ内容の再送が安全であること) を課す。頻出ユースケース (survey の PUT upsert = 毎 phase 上書き) は取りこぼしても次の発火で回復するため、この契約と整合する
- **effect が読めるのは action と適用後 synced のみ**: locals は渡さない (ADR-0015 Decision 2 と同じ理屈)。previous state は旧世代 consumer の実測で不要だったため初版では渡さない
- **失敗の扱い**: effect の throw / rejection は console.error して握りつぶし、engine と他 rule は止めない。retry は提供しない (best-effort 契約の帰結。回復が必要なら次の発火 = 次の進行イベントに委ねる)
- **enabled gate は設けない** (ADR-0015 Decision 4 踏襲): `setEnabled(false)` 中の local 適用でも発火する。tutorial 中に送りたくない consumer は述語 (synced 上のフラグ等) で制御する。standalone は host 常時 true のため発火する — localhost 開発で外部送信が走る点は consumer 側の env ガード責務 (管理画面連携は origin 未設定で no-op になる慣行)

## 論点の裁定 (ADR-0017 起草時点。最終裁定は ADR の Accepted をもって確定)

1. **命名**: `listeners` に変更 (2026-08-13 ユーザ裁定)。「RTK listener middleware の synqux 版 (配置順序とゲートを engine が肩代わり)」という位置づけを名前で示す。あわせて `mode: 'host-only' | 'everyone'` を追加し、host だけの処理と全端末の処理を 1 つのルール表に集約する。live/replay ゲートは everyone 系 (効果音・analytics) にも必要であり、host-only 専用に絞る根拠がなかった
2. **automations への統合可否**: 棄却で確定 (ADR-0017 Context に棄却理由を明記)
3. **standalone / setEnabled(false) 中の発火**: 「発火する」に倒す (ADR-0015 Decision 4 との一貫性。ADR-0017 Decision 8)
4. **`match` に previous / synced を渡すか**: 渡さない。action match のみ。state 述語型は automations + synced フラグで表現する (ADR-0017 Decision 9)
5. **発火点の正確な位置**: actionRequestMiddleware の `next(action)` 直後 (`evaluateAutomationsAfterApply` と同じ点、同期適用と local 適用の両方を捉える)。live 判定は実装済みの `synqux.phase` (`'live'` のみ発火) を直接参照する — TASK-260812-consumer-boilerplate B は実装済みのため順序依存は解消済み
6. **(追加) effect への dispatch 提供**: v1 では渡さない。local dispatch を伴う反応 (modal 等) は consumer の RTK listener に残す。実測で要求が出たら「synced action は拒否するガード付き dispatch」を追補検討 (ADR-0017 Decision 6 / Consequences)

## テスト (実装 TASK で確定。想定 `src/core/listeners.test.ts`、memory hub)

- [x] `'host-only'`: host で match する action が適用されたら effect が 1 回発火する。非 host 端末は発火しない
- [x] `'everyone'`: 適用した全端末 (host 含む) でそれぞれ 1 回発火する
- [x] restore replay で再適用された action では発火しない (両 mode)。replay 完了後のライブ配信では発火する
- [x] 拒否された request (適用されない action) では発火しない
- [x] host migration 後、新 host が以後の action で `'host-only'` を発火する。過去 action の遡り発火はしない
- [x] effect の同期 throw / rejection で engine と他 rule が止まらない
- [x] effect の `ctx` に dispatch が存在しない (型契約。runtime 検証はしない — ADR-0017 Decision 6)
- [x] standalone で発火する。`setEnabled(false)` 中の local 適用で発火する
- [x] `id` 重複・不正な `mode` で createSynqux が throw する

## ドキュメント更新 (完了条件に含む)

- [x] ADR-0017 起草 (Context に新旧 consumer の実測、棄却案として automations 統合と consumer 手書き listener を明記)
- [x] SPEC-0002: 型 / config 追記
- [x] SPEC-0001: 設計ガイドラインへ「synced action への反応 (外部通知・演出・記録) は listeners で書く。synqux middleware 後段の手書き listener / React hook での自作を禁止。local dispatch を伴う反応のみ RTK listener 可」を追記
- [x] README: 公開 API 一覧へ追加

## 完了条件

- [x] ADR-0017 が Accepted (論点 1〜6 の裁定込み)
- [x] 実装とテストが green、`npm run fix` / `npm test` green (vitest 290 / oxlint / oxfmt / tsc / demo tsc)
- [x] ドキュメント更新完了 (SPEC-0001 ガイドライン 7 / SPEC-0002 / README How to + 発火タイミング解説)
- [ ] semver: minor 想定 (breaking なし)。release / publish は人間判断のため行わない
- [ ] 導入 consumer 側: 導入後に docs へ「synced action への反応は synqux listeners へ」を追記し、暫定 listener を置いた場合は撤去する

## 完了記録 (2026-08-13)

- 実装は codex exec に委譲 (指示書: 発火点 = actionRequestMiddleware の `next(action)` 直後・`evaluateAutomationsAfterApply` の手前、`isAutomationHost` → `isSelfHost` への共通化、phase gate、テスト観点 9 件)。Claude 側で diff レビューと `npm run fix` / `npm test` の再検証を実施し全 green
- restore replay のテストは snapshot load を人為的に保留し、`phase === 'subscribing'` 中に残存 envelope を response 経路へ注入する決定的な作りで固定した (`src/core/listeners.test.ts`)
- release (0.9.0 minor 想定) と導入 consumer 側の置換は未実施 (人間判断・後続作業)
