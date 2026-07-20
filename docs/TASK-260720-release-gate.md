# TASK-260720: 公開前の法務・version・配布物 gate

> BACKLOG P0「公開前の法務・version・配布物 gate を整える」の解消タスク。

## 項目

1. **LICENSE 追加**: `package.json` は MIT を宣言しているが本文がない。MIT License 全文 (`Copyright (c) 2026 yano3nora`) をリポジトリ直下 `LICENSE` に追加し、`files` に `dist` しか載っていなくても npm が LICENSE を自動同梱することを確認する
2. **pack smoke test**: stale `dist` を pack しないよう、tarball を対象に runtime import・型・version を検証する `scripts/pack-smoke.mjs` を追加する
   - `npm pack` で tarball を作り、`node_modules/.synqux-smoke/` へ展開 (bare specifier が repo の node_modules へ解決される位置)
   - main / react / testing / firebase の 4 entry を file URL で dynamic import し、主要 export の存在を assert
   - `SYNQUX_VERSION === package.json の version` を assert (**stale dist 検出の本丸**) と `SYNQUX_SCHEMA_VERSION` の期待値一致
   - 小さな consumer .ts を生成し、paths mapping で展開済み d.ts を参照して `tsc --noEmit` (型配布の smoke)
   - npm script `smoke` として追加し、`prepublishOnly` を `run-s test build smoke` へ変更 (通常の `npm test` には含めない)
3. **version 判断 (人間)**: 現在の `0.2.0` に breaking な Result API / wire v3 が混在。`0.3.0` か `1.0.0` かはユーザが決定する。決定後に CHANGELOG の Unreleased を切り、`npm version` を実行する (publish はユーザ)

## 完了条件

- [x] `LICENSE` が存在し npm pack の同梱リストに含まれる (pack-smoke が毎回 assert する)
- [x] `npm run build && npm run smoke` が green / dist の SYNQUX_VERSION を故意にずらすと fail することを確認
- [x] version はユーザ判断の記録をこの TASK に追記
  - **決定 (2026-07-20)**: 次リリースは `0.3.0`。0.x のうちは minor で breaking を出す運用とし (^0.2.0 の caret は 0.3.0 を自動で拾わないため consumer の意図しない追従は起きない)、P1「main entry の公開範囲再判断」(breaking 候補) を消化してから `1.0.0` を切る
  - `npm version 0.3.0` (commit / tag が切られる) と publish はユーザが実行する
- [ ] `npm run fix` / `npm test` pass
