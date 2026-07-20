# TASK-260720: 完了済み ADR / 現実装との文書不整合を解消

> BACKLOG P2「完了済み ADR / 現実装との文書不整合を解消する」の解消タスク。
> P1 から統合された「transport の request id 契約を seq 方式へ合わせる」を含む。

## 実施内容

### 文書不整合の修正

1. ADR-0003: 「自動回復は未解決」の 2 箇所へ ADR-0004 で解消済みの追記 (ADR は歴史記録
   のため本文は書き換えず、追記で現状へ導線を張る方針)
2. ADR-0001: 廃止済み `selectLatestResult` の言及へ廃止 NOTE を追記
3. ADR-0002: 旧語彙 `error & console` に ADR-0008 (`message` / `log`) への改称 NOTE を追記
4. README: ADR 一覧に 0010 / 0011 / 0012 を追加。demo の「CI 対象外」を実態
   (`test:tsc-demo` で型検査は npm test に含む) へ修正 — AGENTS.md の同記述も揃えた
5. Firebase test: ヘッダコメントの旧 `prevKey 正規化` (v2 の seq 化で消滅) を
   現在の検証対象 (abort / cancel callback の契約) へ差し替え

### transport request id 契約の緩和 (P1 から統合)

- 契約 1 を「挿入順で辞書順単調」から「group 内で一意かつ不変。順序性は要求しない」へ
  緩和した (types.ts / SPEC-0002 A2)。適用順は host 採番の seq だけが担う (ADR-0002) ため、
  core は id を dedup の set membership と適用窓の記録にしか使っていない
- `subscribeRequests` の `after` オプションは「挿入順辞書順単調な id を持つ transport
  でのみ意味を持つ」と明記し、初期配送の「id 順」要求を「配送順は問わない (core が seq で
  線形化する)」へ緩和した
- adapter 側の変更はなし: firebase push id / memory hub の連番 id はどちらも新契約を
  満たす (単調 id は要件を満たす一例)。core が id 順に依存しないことは既存の重複・遅延・
  順序入替 simulation が既に検証しているため、テスト追加もなし

## 完了条件

- [x] 上記 5 件の不整合が解消され、request id 契約が SPEC-0002 / types.ts で一致している
- [x] CHANGELOG に契約緩和を記録
- [x] BACKLOG の該当項目を削除 (action repeat contract 独立項目の廃止・統合も同時に反映)
- [x] `npm run fix` / `npm test` pass
