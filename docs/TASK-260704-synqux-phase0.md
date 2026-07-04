# synqux Phase 0: 移植元の characterization test

- Status: **完了 (2026-07-04)**
- 作業は移植元 repo (社内、パスは git 管理外の `CLAUDE.local.md` 参照) で実施。**記録の正は移植元の `docs/TASK-260704-synqux-phase0.md`**

## 要約

切り出しに先立ち、移植元の現挙動 (既知の問題①①′②を含む) をテストで固定した。Phase 1 はこのテスト群を仕様として実装された。

- `src/constants/requests.test.ts` — isDelayedRequestId / generateResult / stateWithError の unit
- `src/ui/modules/requests/middlewares.test.ts` — 3 middleware の挙動固定 (firebase mock + 直接 dispatch ハーネス)

## Phase 1 へ引き継いだ知見

1. ①′ (二重 dispatch 窓) は「未発火と推定」ではなく機構として実在 (同時二重配送で再現)
2. ① (revisions 二重記録) は ack 遅延時のみ発生 (fake timers で決定的に再現可能)
3. `launchTalks` / `clearTalks` は移植元に dispatch 箇所なし → ADR Migration Notes の宿題は解消
