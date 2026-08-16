# TASK-260816: 公開 API 棚卸しと react 層の縮小

- BACKLOG P1「全体 refactoring」残件 (公開 API 表面積の棚卸し / `WithSynqux` キャスト整理) の消化
- 裁定は `docs/ADR-0023-react-slim-and-api-inventory.md` を正とする

## 調査結果 (棚卸し)

導入済み consumer (1 repo。テンプレートは Phase 2 未移行) の import を全走査した。

- **実利用あり**: createSynqux / createSynquxRootReducer / createSyncedActionMatchers / isDeliveredSyncedAction / generateResult / isResultForPeer / isSynquxAction / selectIsHost / selectIsLive / selectSelf / selectSelfId / selectSelfRole / stateWithError / stateWithResult / stateWithTransaction / synquxReducer / 契約型 (Peer / PeerRole / Result / ResultMessage / SynquxAutomation / SynquxListener / SynquxState) / firebaseTransport / createMemoryHub / assertActionIdempotency / useSynquxSubscription
- **実利用なし → 削除** (ADR-0023 Decision 1): react 読み取り hooks 10 個
- **実利用なし → 維持** (ADR-0023 Decision 4 に理由): selectPeers / selectSyncPhase / selectSyncHealth / selectIsSyncStalled / selectIsSyncUnrecoverable / stateWithDefaultResult / synquxRestored / localStorageSnapshotStore / SYNQUX_SCHEMA_VERSION / SYNQUX_VERSION
- **型 export → 一括維持** (runtime 表面積ゼロの契約面): SynquxTransport / SnapshotStore / SnapshotFence / SnapshotEnvelope / RequestEnvelope / SynquxActionMeta / SynquxSynced / Unsubscribe / CreateSynquxConfig / Synqux / SynquxSubscribeOptions / SynquxListenerContext / SynquxHostLiveness / SynquxRootState / SynquxHealth / SynquxPhase / SynquxState / PendingRequest ほか
- **付随修正**: `selectPeers` を参照安定化 (WeakMap memo)。`usePeers` の `shallowEqual` が担っていた再描画抑止を selector 側で保証する (再現テスト: `src/core/selectors.test.ts`)

## タスク

1. [x] ADR-0023 起草
2. [x] react 読み取り hooks 10 個の削除、`useSynquxSubscription` のみ残す (WithSynqux キャストは内部 1 箇所へ)
3. [x] pack-smoke / README / SPEC-0002 / テストの追随
4. [x] `npm run fix` / `npm test` / `npm run smoke` 通過
5. [x] codex exec でレビュー → 指摘反映 (第 2 ラウンドで LGTM)
    - [M] 棚卸しに型 export の分類が欠けていた → 「一括維持 (契約面)」を追加
    - [M] `usePeers` の `shallowEqual` を失うと `selectPeers` が毎回新配列で不要再描画 → selector 自体を WeakMap memo で参照安定化 + 再現テスト
    - [L] pack-smoke を react export の完全一致検証へ / README structure 記述の追随
6. [x] BACKLOG 更新 (P1 残件の消化)

## 完了条件

- `synqux/react` の runtime export が `useSynquxSubscription` のみ
- 棚卸し表 (上記) と ADR-0023 の裁定が一致
- 全テスト・lint・smoke 通過、codex LGTM
