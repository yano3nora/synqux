# synqux demo: firebase emulator での手動同期確認

- Status: **完了 (2026-07-05)**
- 成果物: `demo/` (counter reducer + plain DOM UI + emulator 設定)。使い方と確認シナリオは `demo/README.md`

## 目的と位置づけ

- `synqux/firebase` adapter は unit test (SDK 全 mock) のみで実機未検証だったため、emulator で同期挙動を目視確認できる場を作る (テンプレ置換前の実機検証チェックリストの前倒し)
- README の Getting Started と同じ配線の「動く実例」としてレビュー・デモに使う

## 決定事項

1. **別 package にせず repo 内 `demo/` + devDependencies** — 別 package は API 変更のたびに追従リリースが要る二重管理の再発。同 repo なら breaking change と同じコミットで demo が直り、壊れること自体が検証になる
2. **配布・CI 非依存のガードレール**: `files: ["dist"]` により npm へ混入しない / build (`tsconfig.build.json`) と vitest の対象外 / `npm test` は emulator 不要 (型チェック `test:tsc-demo` のみ) — AGENTS.md「emulator 依存のテストを増やさない」は維持
3. vite alias で **src を直接読む** (dist ビルド不要、consumer と同じ `from 'synqux'` の import 文を保つ)
4. firebase-tools は devDependencies に入れず `npx -y` 取得 (重いため)。emulator は Java 必須
