# TASK: Phase 1 / B1 — in-memory 同期バックエンド (createMemoryHub)

- Status: **完了 (2026-07-05)**。codex exec への委譲指示書として作成されたもの。Phase 1 全体の記録は `TASK-260705-synqux-phase1.md`
- 完了後のレビュー修正 2 点 (oxfmt 除外の revert / `result: null` のキー除去化) も同記録を参照

## 前提 (必ず先に読むこと)

1. `AGENTS.md` — プロジェクト全体の制約 (特に「モジュール変数のグローバル状態は禁止」「at-least-once を前提に設計する」)
2. `src/core/types.ts` — 実装対象が満たすべき `SynquxTransport` / `SnapshotStore` 契約。**この型定義が正であり、変更してはならない**
3. `docs/SPEC-public-api.md` の「A2: Transport interface」「`synqux/testing`」節 — 背景と設計意図

## 目的

synqux の同期挙動テストの第一級基盤となる、決定的な in-memory 同期バックエンドを実装する。複数の仮想端末 (transport インスタンス) が 1 つの hub を共有し、テストコードが配送を明示操作で制御 (障害注入) できるようにする。

## 成果物

- `src/testing/memory-hub.ts` — 実装本体
- `src/testing/index.ts` — `export { createMemoryHub } from './memory-hub'` (公開面はこの 1 関数のみ)
- `src/testing/memory-hub.test.ts` — vitest によるテスト

## API 仕様

```ts
import type { Peer, RequestEnvelope, SynquxTransport } from '../core/types'

export type FaultTarget = {
  requestId: RequestEnvelope['id']
  /** 対象端末の peer id。省略時は全端末への配送が対象 */
  to?: Peer['id']
  /** 対象イベント種別。省略時は added / changed の両方が対象 */
  event?: 'added' | 'changed'
}

export type MemoryHub = {
  /** 仮想端末 1 台ぶんの transport を生成する。テストでは端末数ぶん作る */
  createTransport(): SynquxTransport

  faults: {
    /** 次の該当配送を同一 subscriber へ 2 回連続で届ける (二重配送) */
    duplicate(target: FaultTarget): void
    /** 該当配送を保留し、release() で保留分を元の順序のまま解放する */
    delay(target: FaultTarget): { release(): void }
    /** 次の該当配送を 1 回ぶん破棄する */
    drop(target: FaultTarget): void
    /** respondRequest の resolve (ack) だけを保留する。変更イベントの配送は保留しない */
    holdAck(requestId: RequestEnvelope['id']): { release(): void }
    /** 端末側の disconnect() を経ない切断 (プロセス死の模擬)。presence cleanup として全端末へ onRemoved を配送する */
    disconnect(peerId: Peer['id']): void
  }

  /** テストの assert 用の覗き窓。返り値はすべて deep copy */
  inspect: {
    requests(groupId: string): RequestEnvelope[]      // 挿入順
    peers(groupId: string): Peer[]                    // 接続順
    snapshot(key: string): string | null
  }
}

export function createMemoryHub(): MemoryHub
```

## 振る舞い仕様

### 状態と id 採番

- hub の全状態 (requests / peers / snapshots / 購読者 / fault 設定) は `createMemoryHub` のクロージャ内に閉じる。モジュールレベルの可変変数は禁止
- request id は hub 全体で単調増加するカウンタを 0 埋め文字列化したもの (例: `'000000000001'`)。**挿入順 = 辞書順**であること (`SynquxTransport` 契約 1)
- peer id も hub が採番する (例: `peer-1`)。`Peer.connected` は `Date.now()`
- `serverNow()` は `Date.now()` を返す (vitest の fake timers で制御可能にするため)

### イベント配送 (決定性の要)

- すべてのイベント (peers の onAdded / onChanged / onRemoved、requests の onAdded / onChanged) は subscriber ごとの FIFO キューに積み、`setTimeout(..., 0)` で非同期に配送する
    - 同期 (即時 callback) 配送にしないこと — 購読側の再入を防ぎ、fake timers (`vi.advanceTimersByTimeAsync` 等) でテストが配送タイミングを握れるようにするため
- 配送する envelope / peer は毎回 deep copy する (`structuredClone` 可)。subscriber 側の変更が hub の状態や他 subscriber に漏れてはならない (実インフラでは毎回新しいオブジェクトが届くことの模擬)

### transport インスタンス (createTransport の返り値)

- `connect({ groupId, role, label })`: peer を採番して hub に登録し、全 subscribePeers 購読者へ onAdded を配送する。インスタンスはこの groupId に束縛される
- `disconnect()`: peer を除去し onRemoved を配送する。以後このインスタンスのメソッド呼び出しは throw してよい
- `connect` / `serverNow` 以外のメソッドを connect 前に呼んだら `Error` を throw する
- `subscribePeers(handlers)`: 購読開始時、既存 peer ぶんの onAdded を (キュー経由で) 配送する。返り値の unsubscribe で以後の配送を止める
- `pushRequest(envelope)`: id を採番して格納し、全購読者へ onAdded を配送する。live 配送の prevKey は「同一 group 内で直前に挿入された request の id、先頭なら null」
- `respondRequest(id, patch)`: 該当 request に patch (prev / responsedBy / result) をマージし、**自分自身を含む**全購読者へ onChanged を配送する (local echo)。未知の id は throw。resolve は配送スケジュール後の次 tick (`holdAck` 中は release まで resolve しない — onChanged の配送自体は保留しない点が重要。これが移植元の既知の問題①の再現条件)
- `subscribeRequests({ after }, handlers)`: 購読開始時、「id が after より辞書順で後」の既存 requests を id 順に onAdded で一括配送する (responsedBy 付きもそのまま onAdded で流す — 振り分けは core の責務)。このときの prevKey は「配送集合内での直前 request の id、集合の先頭は null」(実際の直前 request があっても null にする。firebase の startAfter query の挙動の模擬)。以後は live 配送
- `saveSnapshot(key, payload)` / `loadSnapshot(key)`: 文字列をそのまま Map に保存・取得する。key の意味は関知しない

### fault の適用規則

- `duplicate` / `drop` は「次に該当した配送 1 回」で消費される one-shot。`delay` は release まで該当配送を全件バッファし、release で元の順序のまま一括配送する
- fault のマッチングは配送単位 (subscriber × イベント) で判定する。`to` 省略時は全端末への配送が対象、`event` 省略時は added / changed 両方が対象

## テスト要求 (memory-hub.test.ts)

最低限、以下のシナリオをカバーすること:

1. 基本フロー: 2 端末 connect → 片方が pushRequest → 両端末の onAdded に同一内容が届く → respondRequest → 両端末の onChanged に patch 反映済み envelope が届く
2. prevKey: 連続 push で prevKey が直前 request の id になる。先頭は null
3. `after` 指定の購読: 既存 3 件のうち after より後の 2 件だけが id 順で届き、先頭の prevKey が null になる (実際には直前 request が存在しても)
4. responsedBy 付き既存 request も onAdded で届く (restore 模擬)
5. faults.duplicate: 対象端末の対象イベントだけが 2 回届く。他端末は 1 回
6. faults.delay → release: 保留中は届かず、release で元の順序で届く (後続 request を先に届かせる順序入れ替えができること)
7. faults.drop: 対象配送 1 回だけが消え、以後の配送は正常
8. faults.holdAck: respondRequest の promise が release まで pending のまま、onChanged (local echo) は先に届く
9. faults.disconnect / disconnect(): 全端末に onRemoved が届く。unsubscribe 後は届かない
10. 購読側で受け取った envelope を破壊的に変更しても hub の inspect 結果が汚染されない
11. connect 前のメソッド呼び出しが throw する

fake timers を使う場合は `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(0)` 等で配送を進めること。実 timer でもテストが決定的なら可。

## 制約

- 実装・テストともに runtime 依存の追加は禁止 (devDependencies の追加も不要のはず)
- `any` / 不要な型 widen の禁止 (AGENTS.md)。コメントは既存コード同様に日本語で「意図」と「やっていること」を要所に書く
- モジュールレベルの可変状態の禁止 (AGENTS.md)

## 完了条件

1. `npm test` (vitest / oxlint / oxfmt --check / tsc --noEmit の全部) が pass すること
2. テスト要求 1〜11 がすべて実装されていること
3. `src/core/types.ts` と `docs/SPEC-public-api.md` に変更を加えていないこと (契約側の不備を見つけた場合は変更せず、作業ログに指摘として残すこと)
