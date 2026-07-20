# production readiness review

- Status: **Done (2026-07-19)**
- 対象: `docs/` を正とした `src/core` / `src/firebase` / `src/testing` / `src/react` / package・配布設定・テスト全体のレビュー

## 目的

最初の consumer repo へ投入する前に、分散系の失敗モードと公開ライブラリ境界を横断確認する。正常系の機能追加ではなく、仕様上の不変条件が transport failure・host migration・復旧・配布時にも維持されるかを確認する。

## 結果

- 重複・遅配・順序入替・通常の host migration・seq gap recovery・retention の deterministic simulation は厚く、基本設計と実装の対応は概ね良好
- 一方、response / snapshot の失敗状態混同、旧 host snapshot の後着、host fork の生存条件、ordering restore、subscribe rollback に実践投入ブロッカーを確認
- Firebase の trust model、LICENSE、breaking version、tarball smoke も公開前 gate として不足
- 未解決事項は優先度と完了条件を付けて `docs/BACKLOG.md` へ集約した

## 検証

- `npm run fix`
- `npm test`

上記の実行結果はこのレビュー完了時の作業報告に記録する。
