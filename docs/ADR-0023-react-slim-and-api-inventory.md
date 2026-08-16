# ADR-0023: react 読み取り hooks の廃止と公開 API 棚卸し

- Status: **Accepted** (2026-08-16 裁定・実装。実装は `docs/TASK-260816-public-api-inventory.md`)
- Date: 2026-08-16
- 関連: ADR-0022 (SynquxProvider 廃止), SPEC-0002 (公開 API 境界), BACKLOG P1「全体 refactoring」

## Context

BACKLOG P1 の「公開 API 表面積の棚卸し」と「`state as WithSynqux` キャスト整理」を、
導入済み consumer の実利用実績と突き合わせて実施した。調査結果:

- 導入済み consumer が `synqux/react` から使うのは **`useSynquxSubscription` のみ**。
  読み取り hooks 10 個 (`useIsHost` / `usePeers` / `useSelfId` / `useSelf` /
  `useSelfRole` / `useSyncPhase` / `useIsLive` / `useSyncHealth` /
  `useIsSyncStalled` / `useIsSyncUnrecoverable`) は使われていない
- 読み取りは core selectors (`selectIsHost` / `selectSelf` 等) を consumer 自身の
  typed `useAppSelector` へ渡す形で行われている — README が canonical として
  案内する typed selector 配線では、hook wrapper は `useAppSelector(selectIsHost)`
  に対してほぼ付加価値がない (むしろ `state as WithSynqux` の隠れキャストを
  ライブラリ側に 10 箇所抱える温床だった)。唯一の実利は `usePeers` の
  `shallowEqual` (毎回新配列を返す selector の不要再描画抑止) だったため、
  廃止と同時に `selectPeers` 自体を参照安定化 (state 世代キーの memo) し、
  hook なしでも同等以上とした
- ADR-0022 で result 読み取りを typed selector 直読みへ一本化した時点で、
  「ゲーム開発者は hooks だけ覚える」という当初の層分け (ADR-0001 Decision 7 /
  SPEC-0002) は「core selectors + typed selector」へ実質置き換わっていた

## Decisions

1. **react 読み取り hooks 10 個を削除し、`synqux/react` は `useSynquxSubscription`
   のみにする**。購読開始の排他・lifecycle という react 固有の関心だけが react 層に
   残る。読み取りの canonical は `useAppSelector(selectIsHost)` のように core
   selectors を typed selector 配線へ直接渡す形 (README / SPEC-0002 に記載)
2. **deprecate 期間は置かず、ADR-0022 (Provider 廃止) と同じ breaking release に
   同梱する** — BACKLOG の「breaking を伴う削除は Provider 存廃と同じ回に同梱」の
   方針どおり。第 2 の breaking window を作らない
3. **`WithSynqux` キャストは `useSynquxSubscription` 内部の 1 箇所に閉じる**。
   ライブラリ外へは漏れない (consumer は自分の RootState で型が付く)
4. **棚卸しの結果、以下は「実利用なし but 維持」と裁定する** (理由つき):
   - `selectPeers` / `selectSyncPhase` / `selectSyncHealth` /
     `selectIsSyncStalled` / `selectIsSyncUnrecoverable`: 接続表示・リロード案内
     UI の canonical 材料。導入済み consumer は callback (`onUnrecoverable` 等) で
     賄っているが、hooks 廃止後の読み取り面の正であり、テンプレート移行 (Phase 2)
     での使用を見込む
   - `stateWithDefaultResult` / `synquxRestored`: primitive 方式の正式契約
     (SPEC-0002)。helper を使わない consumer の脱出口として維持
   - `localStorageSnapshotStore`: standalone `localSnapshots` の既定実装の明示
     export。差し替え・明示指定の受け口として維持
   - `SYNQUX_SCHEMA_VERSION` / `SYNQUX_VERSION`: wire 契約の検出と診断
   - **型 export は一括維持**: 契約型 (Peer / Result / SynquxListener 等の実利用
     ありに加え、SynquxTransport / SnapshotStore / SnapshotFence /
     SnapshotEnvelope / RequestEnvelope / SynquxActionMeta / SynquxSynced /
     Unsubscribe / CreateSynquxConfig / Synqux / SynquxSubscribeOptions /
     SynquxListenerContext / SynquxHostLiveness / SynquxRootState /
     PendingRequest / SynquxHealth / SynquxPhase 等)。adapter 実装者・primitive
     方式・config 型付けの契約面であり、runtime 表面積ゼロのため棚卸しの削減
     対象にしない
   - 上記以外の main entry の **runtime export** はすべて実利用あり

## Consequences

- `synqux/react` の export は 1 つになり、「react 層自体を削る」将来検討
  (ADR-0022 Consequences) は「これ以上削るものがない」状態で実質完了
- 読み取り API の学習面が「selector は core から、購読は react から」の 1 軸に
  揃い、hooks / selectors の二重表面が消える
- 万一 hooks を使っていた consumer は `useAppSelector(selectIsHost)` への機械的
  置換で移行できる (1 hook = 1 行)
- テンプレート移行 (Phase 2) で新たな読み取りニーズが出ても、まず core selector の
  追加で受け、hook wrapper は復活させない
