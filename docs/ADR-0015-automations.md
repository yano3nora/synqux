# ADR-0015: automations (host 駆動の自動 dispatch) と dispatchAndWait

- Status: **Accepted** (2026-08-11 実装。経緯と実装ノートは `TASK-260811-automations.md`)
- Date: 2026-08-11
- 関連: ADR-0002 (host 採番 seq), ADR-0007 (repeat contract), ADR-0008 (result 2 系統), ADR-0012 (AbortSignal), SPEC-0001 設計ガイドライン 2, SPEC-0002 (公開 API), BACKLOG P1 (適用完了 await)

## Context

消費 repo 群 (移植元系列 2 repo の全数調査) で「ユーザー操作起点ではない dispatch」は 3 パターンに集約された。

1. **状態 watcher 型**: 「特定のゲーム状態になったら即 action」。useEffect や reducer の addMatcher で実装され、host 判定がないため**全端末が同時に同じ request を投げる** (fan-out)。依存配列漏れ・端末ローカルな演出状態が抑止条件に混ざる等の温床
2. **タイマー + retry 型**: 「開始 N 分後に action、未実行なら retry」。正しく作ると「毎秒 retry + 端末側クールダウン + reducer 側 execute-once ガード」の 3 層を component / hook / reducer に手書きする必要があり、実装されない (dead code 化する) か、ガード漏れで壊れる
3. **演出途中 dispatch 型**: UI の setTimeout から content 埋め込み action を dispatch。cleanup 漏れ・unmount 後発火・複数 request 化による順序依存の温床

SPEC-0001 ガイドライン 2「1 度しか発火しない自動 dispatch を作らない。state 監視 + retry かユーザ操作起点にする」は存在するが、実現手段が consumer の手書きに委ねられていた。

検討して棄却した代替案:

- **request の予約 queuing**: 予約という新しい同期語彙 (永続化・host migration での引き継ぎ・キャンセル契約) を持ち込む。synqux には snapshot restore があり「発火すべきか」は synced state から毎回導出できるため、予約の永続化自体が不要
- **saga 的 effect middleware**: 命令的な待ち合わせ (`take` / `delay`) がローカルタイミング依存を再導入し、「reducer が唯一の判定器」の原則と衝突する。消費 repo の実態 (宣言的ルール表) とも合わない

## Decisions

1. **automations を core に追加する**。`createSynqux` config に宣言的ルール表を受け、**host である端末だけ**が評価して request を発行する。host は常に 1 台の存在が保証され (host migration)、`dedicated` role の「安定進行・無人進行」ユースケースと整合する。react 層には置かない (headless な dedicated host でも動く必要があるため)

   ```ts
   export type SynquxAutomation<TSynced, TAction extends Action> = {
     id: string                                             // 一意。重複は createSynqux で throw
     when: (synced: TSynced, ctx: { now: number }) => boolean  // now は transport.serverNow() 基準
     action: (synced: TSynced) => TAction
     retryMs?: number                                       // when が true であり続ける間の再発行間隔。既定 1000
   }
   ```

2. **`when` が読めるのは synced state とサーバ時刻のみ**。locals は渡さない。host のローカル state が群の判定に混入する事故クラス (移植元での全チーム進行停止インシデントと同型) を型の入口で排除する
3. **自己終了契約**: 「action が適用されたら `when` が false に戻る」ことを rule の契約とする。engine は exactly-once を保証しない (dual-host 窓で二重発行があり得る)。rule の action は ADR-0007 の `idempotent` または `rejects-repeat` 契約を必須とし、retry の拒否 result は message なし (log 専用、ADR-0008) を推奨する。`when` と reducer validation の条件重複は仕様 — reducer が唯一の判定器で、`when` は発行トリガーにすぎない
4. **enabled gate は設けない** (tutorial 中も評価継続)。`setEnabled(false)` 中は送信ゲートの既存仕様どおり local 適用になる。tutorial 中に動かしたくない rule は consumer が述語 (synced 上の tutorial フラグ等) で制御する。standalone (enabled=false 生成) は host 常時 true のため動作する — `now` は transport に触れず `Date.now()` を使う
5. **`canRequest` には従う** (readonly 端末の意図の尊重)。readonly 端末が host になると automations が止まるため、それを避けたい consumer は当該端末を `role: 'guest'` で subscribe して host 候補から外す
6. **dispatchAndWait を追加する** (BACKLOG P1 の格上げ)。`dispatchAndWait(action, options?: { signal? }): Promise<Result>` — dispatch し、**自端末でその action (hash) の裁定結果の処理が完了**した時点で Result を resolve する (success / error とも resolve、reject は abort のみ)。契約は「自端末適用まで」— 全端末への適用完了は分散システム上保証できない。timeout は提供せず consumer が `AbortSignal.timeout()` 等で選ぶ (ADR-0012 踏襲)。automations はこれを使わない (述語駆動なので待つ必要がない)
7. **演出途中 dispatch (パターン 3) は API で救わず、ガイドラインで禁止に倒す** (SPEC-0001 へ追記)。ユーザー起点操作は即時 dispatch し、付随効果は reducer 内で同一 request として原子的に適用する。演出は state を読んだ render 制御のみで表現し、端末ローカルな演出タイマーをロジックのゲートにしない。表示と同時の自動実行が必要なら automations の汎用ルールで行う

## Consequences

- 消費 repo の watcher / timer / retry の手書き 3 層が「rule 1 エントリ + 既存の reducer validation」に縮む。全端末 fan-out が構造的に消える
- host migration の引き継ぎ状態がゼロになる — 新 host は synced state から同じ結論を導出するだけで、queue の移譲も再スケジュールも不要。リロード・途中参加も snapshot restore がそのまま復旧手段になる
- dual-host 窓・push 失敗・遅延は「次の評価パスでの再発行 + reducer 契約」で吸収する。retry 由来の拒否 result は log 専用推奨により UI ノイズにならない
- API 表面積の増分は型 1 つ + config 1 項目 + instance メソッド 1 つ。breaking change なし (minor release)

## Amendment (2026-08-13): setEnabled の廃止 (ADR-0018)

runtime の `setEnabled(false)` は ADR-0018 で廃止され、tutorial は standalone session
(`subscribe({ mode: 'standalone' })`) で表現されるようになった。Decision 4 の
「enabled gate は設けない (tutorial 中も評価継続)」は「mode gate は設けない
(standalone session でも評価継続・local 適用)」と読み替える。本文は当時の記録のまま残す。
