# ADR-0008: Result / 封筒形状の刷新 (message 構造化・log 分離・responsed)

- Status: **Accepted (2026-07-19)**
- 対象: `Result` 型 (公開 API)、`RequestEnvelope` / transport `respondRequest` 契約 (wire format v3)

## Context

v2 までの `Result` は移植元踏襲で `message: string` / `console?: true` / `duration?: number | null` を持っていた。ドキュメント読み返しで以下の問題が確認された。

1. `duration` (toast 表示時間) は純粋に UI の都合であり、synqux が運ぶ必然性がない
2. `console: true` は「message の行き先を console に切り替える」boolean で、UI 通知と console 出力が 1 フィールドを取り合う。また識別子 `console` はグローバル `console` を shadowing する footgun だった (`results.ts` の destructuring で実際に発生)
3. 裁定時刻が封筒に残らず、「依頼から裁定までの遅延」を requests export だけで調査できない

一方で「UI 都合を全部消す」ことはできない。**拒否された request は state に痕跡を残せない** (reducer は error 時 state 不変が契約) ため、`Result` が失敗 feedback を UI へ届ける唯一のチャネルである。成功時の演出は consumer が synced state (game.messages 等) へ別出しできるが、失敗時は構造上 `Result` に載せるしかない。

## Decision

### 1. `Result.message` を UI 表示想定データとして構造化する

```ts
export type ResultMessage = { text: string }

export type Result<
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
> = {
  action: TAction
  type: 'error' | 'success'
  message?: TMessage        // UI 表示想定データ。undefined = 画面通知なし
  targets: Peer['id'][]
  log?: string              // console 出力。synqux が出力する
}
```

- `duration` / severity / icon などの拡張は consumer が `TMessage` generics で型付けして載せる (`duration` フィールドの削除はこの拡張点への移譲)。generics は default param のため未指定 consumer には従来同様の使い勝手
- 値は JSON 直列化して封筒で運ぶため JSON-serializable であること

### 2. `console` / `duration` を削除し `log?: string` へ置換、出力は synqux の責務にする

- `message` (UI 表示、表示自体は consumer 責務) と `log` (console 出力、synqux が出力) の 2 チャネルに分離。併用も可能
- synqux は result 適用時に `type` に応じて `console.log` / `console.error` へ `log` を出力する。出力は targets 準拠 (空 = standalone 扱いで無条件、指定ありは自端末が含まれるときのみ)
- **log 専用の error result (`type === 'error' && !message`)** は UI に出すデータがないため、v2 の `error && console` と同様に dispatch 自体を省略して console 出力のみ行う (連打・遅延で弾かれた操作のノイズ抑制と負荷軽減)
- `stateWithError` のデフォルト挙動は踏襲: `message` 省略時は `action.type` を `log` とした log 専用の拒否になる

### 3. `RequestEnvelope.responsed` (裁定時刻) を追加する

- `requested / requestedBy` と対になる `responsed / responsedBy`。host が裁定時に `serverNow()` で焼き、transport `respondRequest` の patch に含める
- 用途はデバッグ・調査 (requests export だけで裁定遅延を確認できる)。correctness には使わない
- 取得コストは firebase adapter で `Date.now() + offset` (offset は instance cache) の O(1)。serverNow 失敗時は端末時計で代用する (調査用途のため許容)
- host fork 内の取得位置は **state (`current`) 読み取りの前**: current 読み取り → 直列ゲート判定 → seq 発行 → 試し実行 → orderingState 評価固定までの同期ブロックに await を挟むと、待機中の host 交代・response 適用で古い土台のまま裁定する窓が開くため (既知の問題①と同じ構図)。時刻は数 ms 早めに記録されるが調査用途では問題ない

### 4. wire format v3 (`SYNQUX_SCHEMA_VERSION = 3`)

result の直列化形状が変わるため increment し、新旧混在は既存機構 (検出して明示的に拒否) に載せる。synqux は未デプロイのため移行パスは用意しない。

## Consequences

- consumer の reducer は `stateWithError(state, action, { message: { text: '...' } })` の形になる (breaking)。`useLatestResult<TAction, TMessage>` で拡張 message も型付きで読める
- 「UI 通知の表示自体は consumer 責務、console 出力は synqux 責務」と責務線が明確になった
- v2 の `error && console` の挙動 (dispatch 省略) は `error && !message` に置き換わり、SPEC-0001 の設計上の割り切りを更新した
- host の試し実行は middleware を通らないため log の二重出力はない。過去 result の再出力は「直前 dispatch と同一 hash の result か」で防ぐ
