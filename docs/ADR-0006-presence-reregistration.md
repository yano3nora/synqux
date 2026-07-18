# ADR-0006: 再接続時に初回序列のまま presence を復元する

- Status: **Accepted**
- Date: 2026-07-18
- 関連: `TASK-260718-presence-reregistration.md`、ADR-0001 Decision 2/7

## Context

Firebase SDK は WebSocket を自動再接続するが、切断中にサーバ側の `onDisconnect` が発火すると `connections/{groupId}/{selfId}` が消える。従来の adapter は `connect()` 時にしか presence を登録しないため、復帰後も他端末から不在のままとなり、host 候補にも戻れなかった。

host は presence の `connected` 降順で決まる。復帰時に新しい server timestamp を採番すると、回線が不安定な端末ほど再接続のたびに host を強奪し、host churn と dual-host 窓を増やす。

## Decision

1. Firebase adapter が初回登録後も `.info/connected` を監視し、`false` を観測した後の `true` で同じ connection id の presence を復元する。初回の `true` では再登録しない
2. 初回 `set` の ack 後に presence を読み戻し、解決済みの `connected` を session に保持する。再登録ではその値を維持し、読み戻せなかった場合だけ `serverTimestamp()` にフォールバックする
3. 再登録でも `onDisconnect(selfRef).remove()` の登録を `set(selfRef, presence)` より先に完了させる。再登録失敗は session を落とさず報告し、次の再接続サイクルで再試行する
4. watcher は adapter instance 内に閉じ、`disconnect()` の presence cleanup より先に解除する。core と transport interface は変更しない
5. オンライン状態は consumer API に公開しない。切断による適用停止は既存の sync health が検知・回復でき、今回必要なのは失われた presence の復元だけだからである

## Rejected Alternatives

- **新しい server timestamp で再登録する**: 復帰を新規参加として扱い、回線が不安定な端末による host 強奪・host churn・dual-host 窓を量産する
- **core へオンライン状態を公開する**: transport interface と core state の拡張が必要になる一方、切断の実害は sync health が既に扱う。現時点では YAGNI であり、必要になれば adapter の監視を利用して透過的に追加できる
- **現状維持**: 一時切断を含む長時間セッションでは presence 消失を避けられず、復帰端末が host 候補へ戻れない

## Consequences

- 一時切断から復帰した端末は同じ connection id と host 序列へ戻る
- 初回 `connected` の読み戻しが失敗した session だけは、復帰時の server timestamp により host 序列が変わり得る。presence を復元できない状態より安全な縮退として許容する
- consumer から直接オンライン状態は読めない。運用上必要になった時点で、実需に基づいて公開契約を追加する
