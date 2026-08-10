# ADR-0013: result のライフサイクル — 毎 synced action での再生成原則

- Status: **Accepted** (2026-08-10 実装)
- Date: 2026-08-10
- 関連: ADR-0008 (result 封筒の再形成), SPEC-0001 (reducer が唯一の判定器), SPEC-0002 (公開 API)

## Context

host の裁定は「rootReducer を試し実行し `selectSynced(next).result` を読む」構造だが、synqux core には result を action ごとにリセットする仕組みがない。restore 時に null へ落とすだけで、通常の適用では前 action の result が state に残留し続ける。

移植元ではこの前提を consumer 層が満たしていた。game module の extraReducers 先頭 matcher が「全 game domain action の適用冒頭で default success result を stamp し直す」ため、以下が同時に保証されていた:

1. **裁定の per-action 性**: 試し実行後の result は常に「今回の action 自身の裁定」であり、残留 result による誤裁定が構造的に起きない
2. **locals からの成功検知**: 全 accepted action が自分の hash 入り success result を持つため、locals reducer が「この action は成功したか (isSucceededGameAction 相当)」を result の hash 照合で判定できる

synqux は同期基盤 (移植元 constants/requests.ts) のみを移植したため、この必須部品が抜けた。現状は「result を積まない (silent success な) reducer 分岐」を consumer が書いた瞬間に穴が開く:

- 過去の message 付き error result は dispatch されて全端末の state に永続化される
- その後の silent success な request を、host が残留 error で誤って拒否する
- 残留 error が log 専用 (message なし) だった場合、受理されるべき mutation が dispatch 省略で黙って失われる

core のテストフィクスチャは各分岐に手書きの `result: null` を置いてこれを回避していたが、規律頼みであり、SPEC には error 側の契約しか書かれていなかった。

## Decisions

### 1. 原則: synced domain action の適用は、常に「その action 自身の result (success | error)」を残す

- silent success を存在させない。reducer が result を書かなければ default success (`generateResult({ action, type: 'success' })`、message / log なし = 通知なし・log 出力なし) がその action の result になる
- 実装は **pre-stamp 方式** (移植元の先頭 matcher 踏襲): synced reducer 実行前に result を default success へ差し替えてから reducer を実行する。logic validation は従来どおり `stateWithError` / `stateWithResult` で上書きする
- host の試し実行と各端末の実適用で stamp は同一に走るため決定性を壊さない (devDeterminismCheck とも整合)

### 2. 配置: createSynquxRootReducer に組み込み、primitive 方式にはヘルパーを提供する

- 「どの action が synced domain action か」は consumer しか知らないため、`createSynquxRootReducer` の config に `isSyncedAction` (required、`createSynqux` と同じ型ガード) を追加し、synced reducer の前段で stamp する
- `createSynquxRootReducer` は返り値に `isSyncedAction` を echo し、既存の spread 慣用句 `createSynqux({ transport, ...createSynquxRootReducer({ ... }) })` で述語が single source になるようにする
- stamp の実体は `stateWithDefaultResult(state, action)` として export し、primitive 方式 (自前 rootReducer) の consumer は自分の synced reducer の前段でこれを呼ぶ義務を負う (SPEC-0002 の primitive 契約に明記)

### 3. 移植元の「hash 同一なら result 引継ぎ」分岐は移植しない

移植元の stamp には「既存 result の action hash が今回の action と一致すれば引き継ぐ」分岐があったが、以下の理由で常に再 stamp とする:

- synqux は seq 線形化により同一 action の二重適用が発生しない (引継ぎが意味を持つ状況がない)
- standalone では action に hash がなく、判定が `undefined === undefined` で恒真になり「残留 result を永遠に引き継ぐ」誤動作になる (移植元では standalone に裁定がないため顕在化しなかった)

### 4. stateWithTransaction はこの原則を前提に reset なしで移植する

移植元の `stateWithTransaction` は冒頭で `draft.result = null` していたが、これは残留 result 対策の局所防衛であり、本 ADR の原則下では不要になる。むしろ null リセットは「silent success な transaction が stamp 済み success を破壊する」ため原則違反となる。reset なしで移植する (詳細は TASK-260810-result-lifecycle-and-transaction.md)。

## Out of scope

- **isSucceededGameAction 相当の locals 用 helper の提供**: consumer 側の数行で書けるため、テンプレ移行で必要性が確認できるまで synqux には持たない (YAGNI)。その後、必要性が確認されたため `TASK-260810-succeeded-action-matchers` で提供済み
- **result の自動クリア (時限・消費時)**: 「次の synced action まで残る」という現行の transient 性は変えない。表示済み判定は従来どおり hash 照合で行う

## Consequences

- **受理 response の封筒が常に result を持つ**ようになる (従来は silent success 時 null)。`RequestEnvelope.result` は既存の optional field のため SYNQUX_SCHEMA_VERSION は変更しない。封筒サイズは action の複製分増えるが、移植元が同じ挙動で 5 年運用された水準に戻るだけである
- **breaking**: `createSynquxRootReducer` の config に `isSyncedAction` が必須で加わる (0.5.0)。消費者は再導入時に述語を渡す 1 行の追従で済む
- characterization test の「result null = 受理」の表明を「default success = 受理」へ更新する
- core フィクスチャの手書き `result: null` は stamp に置き換わり、「stamp を忘れた primitive consumer」という失敗モードはテストと SPEC の両方で明示される
