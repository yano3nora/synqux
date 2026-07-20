# trust model の確定

- Status: **Done (2026-07-19)**

## 決定

最初の consumer は不正操作耐性を必要としない。synqux の適用範囲を「認証・認可済みの協調的な非敵対クライアント」とし、cheat / tamper 耐性は非目標とする。

## 反映先

- `docs/ADR-0009-trust-model.md`
- `docs/SPEC-0001-requests-sync.md`
- `README.md`
- `docs/BACKLOG.md` — trust model の判断項目を解消し、本番 rules / lifecycle checklist だけを consumer 導入時の残作業へ整理
