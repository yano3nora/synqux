# TASK-260720: firebase peer 範囲の実証と是正

> BACKLOG P1「firebase peer 範囲 (`>=9`) の宣言が実証済みか検証する」の解消タスク。
> ランタイムで弾く機構は作らない (バージョン不整合の警告は npm の peer 解決に任せる)。

## 検証方法

scratch dir に `src/core/types.ts` + `src/firebase/index.ts` をコピーし、本 repo と同じ
tsconfig (`target: ES2022` / `moduleResolution: Bundler` / `strict`) で firebase の各
バージョンに対して `tsc --noEmit` を実行した。

## 結果

| firebase | 型検査 | 備考 |
| --- | --- | --- |
| 9.0.0–9.8.0 | ❌ FAIL | package.json `exports` に types 条件がなく、`moduleResolution: Bundler` で `firebase/database` の型解決が不能 (TS7016)。API 自体の欠落ではない |
| 9.9.0 / 9.9.4 / 9.10.0 / 9.23.0 | ✅ PASS | 9.9.0 で exports に types が追加された |
| 10.0.0 / 11.0.0 | ✅ PASS | major 境界も確認 |
| 12.x | ✅ PASS | 本 repo の devDependencies (通常テストで常時検証) |

- 懸念していた RTDB `startAfter` は 9.0.0 の modular API から存在しており、API 欠落は
  なかった。落ちたのは型解決 (exports の types 条件) のみ
- NOTE: 旧式の `moduleResolution: node` (node10) なら 9.0.0 でも型解決し得るが、
  consumer 想定 (vite ベースのゲーム repo 群) は Bundler 解決のため、実証できた
  範囲だけを宣言する

## 対応

- [x] peerDependencies を `firebase: ">=9.9.0"` へ狭めた (実証済み範囲のみ宣言)
- [x] CHANGELOG に記録 (未リリースの 0.3.0 に含める)
- [x] BACKLOG の該当項目を削除
