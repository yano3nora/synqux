# TASK-260901: channels — 裁定なし高頻度同期チャネル

260901 channels
===

## asis

- synqux のチャネルは requests (裁定つき synced action) / snapshot / presence の 3 系統のみ
- consumer (fc-310 docs/TASK-260901-whiteboard-features.md 参照) はカーソル座標・ドラッグ中座標のために「RTDB 直書き + rxjs throttle + onDisconnect + jotai」の同型実装を 3 回複製している (cursors / card-positions / block-positions)
- この経路は synqux の transport 抽象の外にあり、standalone mode で動かず、テスト (MemoryHub) でも扱えない

## tobe

- 「高頻度・上書き (LWW)・裁定不要・非永続」データ用の第 4 チャネル **channels** を提供する
- transport 契約へ optional メソッド 3 つを追加し、firebase / MemoryHub が実装。standalone は in-memory self-loop で同一意味論
- instance API `synqux.channel<T>(name, options)` で publish (throttle 付き) / remove / subscribe を提供。Redux store は通さない
- 設計判断は ADR-0028 を正とする

## todo

- [x] ADR-0028 起票
- [x] types.ts: transport 契約 14-16 と optional メソッド追加
- [x] core: channels engine (`src/core/channels.ts`) + create-synqux 配線
- [x] firebase adapter 実装 (`channels/{groupId}/{channel}/{key}` + onDisconnect cleanup)
- [x] MemoryHub 実装 (配送 queue / faults.disconnect 連動 / inspect)
- [x] テスト (multi-peer 配送 / throttle trailing / cleanup / standalone / 未対応 transport fail-fast)
- [x] SPEC-0002 / README 更新
- [x] Codex レビュー 5 巡 (送信直列化 / onDisconnect 競合 / in-flight coalesce / barrier 跨ぎ / cancel 競合を修正) → approve
- [ ] release (人間判断。0.17.0 想定 — transport optional 拡張のため非 breaking)

## testcases

- [x] 2 端末間で publish → onChanged が配送され、購読開始時に既存 entry が届く
- [x] throttle が中間値を coalesce しつつ最終値を必ず配送する (trailing)
- [x] cleanup 'disconnect' の値が publish 元切断 (faults.disconnect) で onRemoved になる
- [x] standalone で self-loop 配送・再購読時の既存 entry 配送が成立する
- [x] channels 未対応 transport で synced subscribe が fail-fast する

## notes

- 発端は fc-310 プロジェクトテンプレートへのホワイトボード機能取り込み (fc-310 の docs/TASK-260901-whiteboard-features.md)
- React binding (jotai atomFamily) は consumer 側 (ADR-0023 の react slim 方針)
- 座標を game 判定に使う場合の「synced への明示 commit」規約は consumer 側 ADR で規定する
