# synqux Phase 2: npm publish とテンプレ repo の置換

- Status: **synqux 側完了 (2026-07-05)。残タスクは publish 実行 (手動) と消費者テンプレート側の置換作業**
- 根拠: `ADR-0001-design.md` Decision 5 (段階移行) / 6 (バージョニング運用)
- ゴール: テンプレ repo が synqux 依存で薄くなり、移植元との二重管理期間が終わること

## 完了 (2026-07-05)

### 1. `synqux/firebase` adapter — `src/firebase/index.ts`

- データ配置は移植元互換 (`connections/` / `requests/` / `games/`)。auth は consumer 責務
- at-least-once 対応は core 移設済みのため素朴に流すだけ。onDisconnect 登録 → set の順で presence cleanup を保証
- unit test 9 本 (SDK 全 mock、emulator なし)。**実機は未検証** — テンプレ置換の検証チェックリスト (GUIDE 7 節) が初実機

### 2. publish 準備 — 0.1.0

- private 解除 / subpath exports 4 本 / firebase・react は optional peer / `prepublishOnly` (test+build 強制) / `version` script (SYNQUX_VERSION 自動同期) / engines >=20
- ts-utils は public npm + MIT を確認済み (前提クリア)
- **publish 前の重大バグ修正**: 相対 import の拡張子なし emit で dist が Node ESM 非対応だった → 全 import に `.js` 付与、3 entry の smoke test で解決確認
- GitHub への push・npm publish はユーザが判断・実行する (エージェントは行わない)

## 残タスク

### publish 実行 (手動と決定)

手順は README の「Publishing (maintainer 向け)」節。`npm version` → `git push --follow-tags` → `npm publish --access public`

### 消費者テンプレート repo の置換 (手順書だけ作ると決定)

**手順書: `docs/local/GUIDE-template-migration.md` (社内情報を含むため git 管理外)** — ファイル対応表 / store 書き換えレシピ / 4 action 修正 / toggle→set + 冪等性 CI / 実機検証チェックリスト / 旧 snapshot 互換の注意 (schema version なしは restore 拒否 → 進行中セッションのない時間帯にデプロイ)

## 留意

- 二重管理期間 (移植元にも修正を入れる期間) を短くする (ADR Consequences)
- 出荷済みゲーム repo は exact pin、テンプレは ^latest 追従 (Decision 6)
