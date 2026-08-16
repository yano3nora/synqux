# ADR-0022: SynquxProvider と context 依存 result hooks の廃止

- Status: **Accepted** (2026-08-16 裁定・実装。実装は `docs/TASK-260816-provider-removal-and-state-ownership.md`)
- Date: 2026-08-16
- 関連: ADR-0001 (design / Decision 7), ADR-0008 (result 2 系統), BACKLOG P1「SynquxProvider 存廃」

## Context

`synqux/react` の `SynquxProvider` は、context 依存の 2 hooks
(`useLatestResult` / `useMyLatestResult`) へ `selectSynced` (synced state の位置) を
解決するためだけに存在していた。BACKLOG P1 で存廃検討としていたが、判断材料が
揃った:

- 先行導入 consumer は `useSynquxSubscription` (Provider 不要) と core selectors
  (`selectIsHost` / `selectSelfId` / `isResultForPeer`) を自前の typed selector に
  組み込むだけで完結しており、**SynquxProvider を配線していない**
- consumer は synqux instance を module から直接 import できるため、context 経由で
  `selectSynced` を運ぶ動機が薄い。call-site で `<TAction, TMessage>` を毎回指定
  する generics は、typed selector を 1 つ書く方式に DX で劣る
- result は「consumer 自身の synced state の所有物で直読みできる」が SPEC-0002 の
  原則であり (`selectLatestResult` 廃止の経緯と同根)、context 迂回はこの原則の
  例外を 1 つ残しているだけだった

## Decision

1. **`SynquxProvider` / `useLatestResult` / `useMyLatestResult` を削除する**。
   `synqux/react` に残るのは Provider 不要の hooks (`useSynquxSubscription` +
   peer / phase / health selector hooks) のみ
2. **core instance の `Synqux.selectSynced` (公開 echo field) も削除する**。
   存在理由が「react の result hooks への位置解決」のみで (SPEC-0002 で内部用と
   明記済み)、hooks の廃止で用途が消える。config の `selectSynced` (createSynqux
   への入力) は不変
3. **canonical な読み方は「typed selector + core selectors」**として README /
   SPEC-0002 に記載する:
   ```ts
   // consumer 側に 1 つ書けば型引数の毎回指定も不要
   const selectMyLatestResult = (state: RootState) =>
     isResultForPeer(state.game.result, selectSelfId(state))
       ? state.game.result
       : null
   ```
4. **deprecate 期間は置かず 1 段階で削除する** (BACKLOG 案の「minor で deprecate →
   major で削除」からの逸脱)。理由: 0.x であること、消費 repo 群のうち唯一の導入
   consumer が Provider を配線しておらず実影響ゼロであること、テンプレート
   (Phase 2) は未移行で今が最安値であること。breaking を含む 0.x minor として
   出す扱いは ADR-0021 の release 判断と同じ

## Consequences

- `synqux/react` の API 表面積が縮み、「Provider を配線すべきか」という setup 層の
  判断が 1 つ消える。react 層は「購読開始 (`useSynquxSubscription`) + 読み取り
  selector hooks」だけの薄い glue になる
- result の読み方が「自分の synced state から直読み」に一本化され、SPEC-0002 の
  直読み原則の例外がなくなる
- `react-redux` / `react` への依存理由が減り、将来「react 層自体を削って core
  selectors のみにする」検討 (BACKLOG の API 棚卸し) の下地になる
- 万一 Provider を使う consumer が現れていた場合は、上記 typed selector への
  書き換えが必要 (機械的な置換で済む)
