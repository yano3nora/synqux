# TASK-260821: テスト出力の console.error ノイズ対策

## 背景
- `npm test` (TTY 実行) で memory-hub の fault 注入エラー (`Injected saveSnapshot failure` など) が stderr へ大量に流れ、本物の regression ログと見分けがつかなかった
- core は transport 失敗を `console.error` で記録して処理継続する設計のため、注入テストではログが出ること自体は仕様通り

## 対応
- `vitest.setup.ts` (新規) — 全テストで `console.error` を capture する共有 setup
    - memory-hub の注入エラー 4 種 (`EXPECTED_ERROR_PATTERN`) は想定内として黙殺
    - それ以外の想定外 `console.error` は afterEach でテスト失敗に昇格
- `vitest.config.ts` — `setupFiles` を追加 (既存の `environment` / `include` は維持)
- `tsconfig.json` — include へ `vitest.setup.ts` を追加
- 意図的にエラーログを出す 5 テスト (automations / host-migration / listeners ×2 / session-mode) へ per-test の opt-out spy を追加
- 運用規約は AGENTS.md > Testing 節に記載済み

## Codex レビュー (codex exec, session 01a02066-fcf7-7e52-bbe9-d39535a0a1a5)
- 指摘 1 (重要): per-test opt-out はそのテストの全 console.error を黙殺するため、監視の抜け穴になる。`allowConsoleError(matcher)` 共有ヘルパー方式を推奨
    - → 見送り。既存テスト群が同じ blanket spy 慣習で書かれており、AGENTS.md でも per-test opt-out を契約として明文化済み。ヘルパー化は抜け穴が実害になったときの upgrade path とする
- 指摘 2 (中): allowlist が「全引数 + stack 連結への部分一致」で広い。Error 単一引数 + message 完全一致の構造判定を推奨
    - → 見送り。`Injected ...` は memory-hub 専用の一意な文言で、偶然の衝突は現実的でない
- 指摘 3 (中): テスト終了後 (spy 復元後) の非同期ログは捕捉できない
    - → 仕様として受容。テスト側で settle / timer drain を済ませる既存契約でカバー
- 全テスト green (40 files / 395 tests) を確認済み

## 備考
- listeners の 2 テストで determinism check が `meta.responsed` の 1ms ズレを検出してログを出す (host 試行と local 適用で fake timer の時刻が進む fixture 起因)。挙動自体は仕様通り収束するが、fixture の時刻固定で消せる可能性あり
