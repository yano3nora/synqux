# TASK-260812: sideEffects (host 駆動の外部通知)

- 目的: 「同期グループ内で特定の synced action が適用されたら、host だけが外部システムへ進行状態を送信する」ユースケースを library 機構として提供する。automations (ADR-0015) が「host 駆動の自動 **dispatch**」なのに対し、本件は「host 駆動の外部 **通知**」— 対になる機構として設計する
- 背景: 消費 repo 群では社内管理画面への survey 送信として頻出するパターン。旧世代 consumer は rxjs `action$` + `useGameObserver({ condition: host })` を React component (`ui/components/app-container.tsx`) から購読して実装していた。現行テンプレ世代の consumer で rxjs observer 導線を全削除した結果、置き換え先が RTK listener middleware の手書きになり、下記の穴埋めを毎 consumer が繰り返す構造が残った
- 設計の正: 実装前に ADR を起草して裁定する (ADR-0017 想定)。本書は起票時点の設計コンセプトと論点の整理
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

## 論点 (ADR で裁定する)

1. **命名**: `sideEffects` は redux 文脈で意味が広すぎるか。候補: `notifiers` / `effects` / `emitters`。「外部通知専用で dispatch 禁止」が名前から読めるものにしたい
2. **automations への統合可否**: 「`when` 述語 + effect」として automations に寄せる案は棄却見込み — automations の自己終了契約 (適用で `when` が false に戻る) は「送信済み」が synced state に存在しない外部通知では成立せず、retry 前提のセマンティクスも冪等 PUT と噛み合わない。action-triggered one-shot が実態に合う。ADR に棄却理由として明記する
3. **standalone / setEnabled(false) 中の発火**: 上記コンセプトでは「発火する」に倒したが、tutorial 中の誤送信リスクと consumer 述語の手間のトレードオフ。ADR-0015 Decision 4 との一貫性を優先するか要裁定
4. **`match` に previous / synced を渡すか**: 「state がこの値に変わったら」型のトリガーを match で表現したい要求が出る可能性。初版は action match のみに絞り、state 述語型は automations + synced フラグで表現する整理でよいか
5. **発火点の正確な位置**: responseListener の適用完了点 (automations の評価トリガー (a) と同じ点。`createWaker` 流用可) でよいか。live 判定は TASK-260812-consumer-boilerplate B の購読 phase (`'subscribing' | 'live'`) と判定材料を共有できるはずで、実装順序の依存を整理する

## テスト (実装 TASK で確定。想定 `src/core/side-effects.test.ts`、memory hub)

- [ ] host で match する action が適用されたら effect が 1 回発火する。非 host 端末は発火しない
- [ ] restore replay で再適用された action では発火しない。replay 完了後のライブ配信では発火する
- [ ] host migration 後、新 host が以後の action で発火する。過去 action の遡り発火はしない
- [ ] effect の throw / rejection で engine と他 rule が止まらない
- [ ] effect 内で dispatch できない (または禁止契約の検証方法を ADR で裁定)
- [ ] standalone で発火する。`setEnabled(false)` 中の local 適用で発火する (論点 3 の裁定次第で反転)
- [ ] `id` 重複で createSynqux が throw する

## ドキュメント更新 (完了条件に含む)

- [ ] ADR-0017 起草 (Context に新旧 consumer の実測、棄却案として automations 統合と consumer 手書き listener を明記)
- [ ] SPEC-0002: 型 / config 追記
- [ ] SPEC-0001: 設計ガイドラインへ「外部システムへの通知は sideEffects で書く。app 側 listener / React hook での自作を禁止」を追記
- [ ] README: 公開 API 一覧へ追加

## 完了条件

- [ ] ADR-0017 が Accepted (論点 1〜5 の裁定込み)
- [ ] 実装とテストが green、`npm run fix` / `npm test` green
- [ ] ドキュメント更新完了
- [ ] semver: minor 想定 (breaking なし)。release / publish は人間判断のため行わない
- [ ] 導入 consumer 側: 導入後に docs へ「外部通知は synqux sideEffects へ」を追記し、暫定 listener を置いた場合は撤去する
