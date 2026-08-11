# TASK-260811: automations + dispatchAndWait

- 目的: ADR-0015 の実装。非ユーザー起点 dispatch の統一 API (host 駆動 rule engine) と、synced action の自端末適用を await できる公式 API を同一イテレーションで公開する
- 設計の正: `docs/ADR-0015-automations.md`。本書は実装仕様と完了条件
- BACKLOG P1「synced action の『適用完了』を待てる公式 API」を本 TASK で pick 済み

## A. automations

### 公開 API (SPEC-0002 へ転記する)

```ts
export type SynquxAutomation<TSynced, TAction extends Action> = {
  /** rule の識別子。配列内で重複したら createSynqux が throw */
  id: string
  /**
   * 「今この action が必要か」。synced とサーバ時刻のみ読める (locals 遮断)。
   * 契約: action が適用されたら false に戻ること (自己終了)。true であり続ける間は
   * retryMs おきに再発行される
   */
  when: (synced: TSynced, ctx: { now: number }) => boolean
  action: (synced: TSynced) => TAction
  /** 再発行間隔 ms。既定 1000 */
  retryMs?: number
}

// CreateSynquxConfig へ追加
automations?: SynquxAutomation<TSynced, TAction>[]
```

### engine のセマンティクス

1. **稼働条件**: subscribe セッション中のみ。開始は初期 restore 完了後 (restore 前の空 state で発火させない)。unsubscribe で停止 (interval 破棄は既存 cleanups へ登録)
2. **発火主体**: 自端末が host のときだけ発行する (内部の host 導出を参照)。standalone は host 常時 true なので動作。`setEnabled(false)` 中も評価・発行を止めない (ADR-0015 Decision 4。off 中は既存の送信ゲート仕様で local 適用になる)
3. **評価トリガー**: (a) synced action の適用完了後 (responseListener の適用完了点。既存 `createWaker` の流用可) と (b) 周期 tick。tick 間隔は全 rule の `retryMs` の最小値。評価パスごとに `transport.serverNow()` を 1 回だけ呼び `now` を共有する (standalone は `Date.now()`)
4. **発行判定**: rule ごとに「`when` が true」かつ「最終発行から `retryMs` 経過」なら `store.dispatch(rule.action(synced))`。最終発行時刻はインスタンス内部 (session スコープ) に持つ — モジュール変数禁止
5. **経路**: 通常の middleware 経路 (meta setter → actionRequest) を通す。`canRequest` false なら発行しない (ADR-0015 Decision 5)。`isSyncedAction` を満たさない action を rule が返したら console.error + skip (発行しない)
6. **失敗の扱い**: push 失敗は握りつぶす (次パスの retry が回復手段)。`serverNow()` 失敗時はそのパスでは発行せず次パスで再試行する (時刻なしで発行しない)。`when` / `action` の throw は console.error + その rule のみ skip し、engine と他 rule は止めない
7. **validation**: `id` の重複、および `retryMs` 指定時に正の有限数でない場合は createSynqux が同期的に throw する

### テスト (`src/core/automations.test.ts`、memory hub + fake timers)

- [x] 時刻条件 rule: `now` が閾値を超えたパスで発行され、適用されて `when` が false に戻ると再発行されない
- [x] retry: 発行 request を `faults.drop` で落とすと、`retryMs` 経過後の次パスで再発行され、最終的に適用される
- [x] host gate: 非 host 端末は `when` true でも発行しない。host migration 後、新 host が同じ rule を引き継いで発行する (引き継ぎ状態なしで成立することの確認)
- [x] dual-host 相当の二重発行が reducer の rejects-repeat 契約で 1 回適用に収束する
- [x] standalone (enabled=false 生成) で動作し local 適用される。`setEnabled(false)` 中も評価が継続し local 適用される
- [x] `when` が throw する rule があっても他 rule は動き続ける
- [x] `id` 重複で createSynqux が throw する

## B. dispatchAndWait

### 公開 API (SPEC-0002 へ転記する)

```ts
// Synqux instance メソッド
dispatchAndWait(action: TAction, options?: { signal?: AbortSignal }): Promise<Result<TAction>>
```

- 契約は「**自端末での裁定結果の処理完了**まで」。success / error (拒否) いずれの Result も resolve で返し、reject するのは signal abort のみ。全端末への適用完了は保証しない (BACKLOG P1 の契約どおり)
- timeout は提供しない。consumer が `AbortSignal.timeout()` 等で選ぶ (subscribe / ADR-0012 と同じ政策)
- 未 subscribe は throw (setRole と同じ扱い)。`isSyncedAction` を満たさない action・`canRequest` false (request 化されず永遠に解決しない) は即 reject
- standalone / `setEnabled(false)` 中は local 即時適用なので、dispatch 直後の synced result を読んで即 resolve

### 実装方針

- hash を dispatchAndWait 側で採番して `meta.hash` に焼いてから dispatch する (meta setter は既存 hash を尊重する仕様)。hash → resolver の map はインスタンス内部 (session スコープ) に持つ
- resolve 点は 3 経路すべてを塞ぐ: (a) responseListener の適用完了 (success / message あり error)、(b) log 専用 error (dispatch されず console 出力のみで終わる経路)、(c) standalone / setEnabled off の即時 local 適用
- abort / unsubscribe 時は resolver を破棄して reject する (unsubscribe 後に残る pending を作らない)

### テスト (`src/core/dispatch-and-wait.test.ts`、memory hub)

- [x] success result で resolve する (host 裁定 → 自端末適用後)
- [x] message あり error result で resolve する (Result.type === 'error')
- [x] log 専用 error (message なし) でも resolve する
- [x] `faults.holdAck` / `delay` で裁定が遅れても、解放後に resolve する
- [x] signal abort で reject する。unsubscribe で pending が reject される
- [x] standalone で即 resolve する
- [x] 未 subscribe で throw、非 synced action / canRequest false で reject する

## C. ドキュメント更新 (完了条件に含む)

- [x] SPEC-0002: `SynquxAutomation` 型 / `automations` config / `dispatchAndWait` を追記し、subpath exports 表を更新
- [x] SPEC-0001: 設計ガイドラインへ追記 — 「自動発火 (watcher / タイマー / retry) は automations で書く。UI からの自動 dispatch・演出タイマーをロジックのゲートにすることを禁止。ユーザー起点操作の付随効果は reducer 内で同一 request として原子的に適用する」(ADR-0015 Decision 7)。ガイドライン 2 の実現手段として automations を参照させる
- [x] README: 公開 API 一覧へ追加
- [x] BACKLOG: P1 の適用完了 await 項目を本 TASK リンクへ差し替え → 完了時に削除

## 完了条件

- [x] A / B の実装とテストがすべて green
- [x] `npm run fix` / `npm test` green (firebase emulator 依存テストは増やさない)
- [x] C のドキュメント更新完了
- [x] semver: minor (breaking なし)。release / publish は人間判断のため行わない

## 作業ログ (2026-08-11 完了)

- A / B とも codex 実装 + レビューで完了。28 files / 245 tests green
- レビューでの裁定・実装ノート:
  - engine の host 判定は `selectIsHost` ではなく presence 由来の `deriveHostId` 直参照。
    `selectIsHost` は `setEnabled(false)` 中に常時 true を返すため、tutorial 中の非 host
    端末が host を自認して発火する誤りを避ける意図的な選択
  - automation の発行 action には評価パスの serverNow を symbol marker で引き渡し、
    request 化時の `requested` に再利用する (パスあたり serverNow 1 回の徹底)
  - `canRequest` false と `setEnabled(false)` が同時の場合は local 即時適用を優先
    (canRequest は送信抑止であり、middleware の挙動と一致させた)
  - dispatchAndWait は hash に加えて `meta.dispatched` も補完する (meta setter が
    既存 hash の action を素通しするため)。同期経路では request 化時にサーバ時刻で
    上書きされるので実害なし
- 本 TASK の仕様セクション 6 / 7 (serverNow 失敗時の skip & retry、retryMs validation)
  は実装時の要判断事項を裁定して追記したもの
