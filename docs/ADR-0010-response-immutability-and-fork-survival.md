# ADR-0010: 裁定 response の確定後不変と host fork の適用完了までの生存

- Status: **Accepted** (2026-07-20 実装)
- Date: 2026-07-19
- 関連: ADR-0002 (host 採番 seq / fencing), ADR-0004 (sync auto recovery), SPEC-0001 不変条件 2〜4

## Context

`spawnHostFork` の裁定は単一の try/catch で「試し実行 → respondRequest(success) → persistSnapshot → prune」を包んでおり、2 つの構造的欠陥がある。

1. **確定済み裁定の上書き**: `respondRequest(success)` 成功後に `persistSnapshot` が throw しても同じ catch に落ち、配信済みの success を同一 `(requestId, epoch, seq)` の error response で上書きする。error (message なし) は dispatch されない log 専用拒否のため、success 版を適用した端末と error 版を観測した端末とで synced state が恒久分岐する。respondRequest の ack 喪失 (サーバでは確定したが Promise は reject) でも同じパスに入る
2. **未裁定 request の永久滞留**: respond の二重失敗後は `retractIssue()` して fork が終了する。retry も再起動イベントもなく、未裁定 request は seq を持たないため sync health の gap 検知にも掛からない。また裁定に入った fork は成否によらず無条件 `break` するため、「fork は request が適用されるまで生存する」という SPEC の記述と実装が乖離しており、ack 前 local echo 中の changed が `hostForkActive` で抑止される窓と組み合わさると、dual-host 敗者の再裁定が漏れる実運用タイミングがある

## Decisions

### 1. 裁定 = response 内容の確定。確定後は何があっても内容を変更しない

- 試し実行の完了 (成功 result / reducer throw による error result) をもって response 封筒 `(epoch, seq, responsedBy, responsed, result)` を**凍結**する
- 以後の失敗 (transport・snapshot) で凍結済み response と異なる内容を配信することを禁止する。「snapshot に失敗したから error に差し替える」は上記 1 の恒久分岐を作るため廃止

### 2. 配信は ack が取れるまで同一内容を再送する (再送冪等による ack 喪失の無害化)

- `respondRequest` の reject は「未確定」と「確定済みで ack だけ喪失」を区別できないが、**同一内容の再送はどちらの場合でも冪等**であり、区別自体が不要になる
- read-back (transport から裁定の確定を読み戻して確認) は transport API の表面積を増やすため不採用。楽観 resolve 禁止 (既存契約) + 同一内容再送で十分
- 再送間隔は `WAKE_FALLBACK_MS` 固定。exponential backoff は決定的 simulation test を複雑にする割に、リレーサーバ 1 host 構成で thundering herd が起きないため不要 (YAGNI)

### 3. 再送の離脱条件は「適用済み / entity 消滅 / host 交代 / session 終了」のみ。host 継続中は諦めない

- 離脱時は `retractIssue()` で発行を畳む。ack 喪失で実は確定済みだった場合も、changed 配送 → in-flight として適用され、未確定だった場合は新 host が同 seq・新 epoch で再裁定して tiebreak が収束させる (ADR-0002 の fencing がこの離脱を安全にしている)
- 再送回数の上限は設けない。諦め = 未裁定滞留の再来であり、transport 全断はどの設計でも進行できないため上限に意味がない。再送中は直列裁定ゲートが群の裁定を止めるが、これは「appliedSeq + 1 の一本道」仕様の帰結であり、transport 断が解消すれば自動で追いつく

### 4. snapshot / prune は「確定後の後処理」。失敗しても response に触らない

- `persistSnapshot` 失敗は log のみ。次の裁定のより新しい snapshot が上書きするため correctness を失わない
- snapshot 失敗時は prune をスキップする (stale snapshot + prune の組み合わせによる復元不能化の防止。snapshot fencing の BACKLOG 項とも整合)

### 5. host fork は適用完了まで生存する

- 裁定 (配信 ack) 後も `break` せず while ループへ戻り、`isApplied` になるまで entity を見張る。SPEC の「fork は request が適用されるまで生存し、敗者の再裁定も引き受ける」に実装を一致させる
- これにより ack 前 local echo 中の changed 起点 fork が `hostForkActive` で抑止されても、元 fork 自身が敗者判定〜再裁定を引き受けるため、上記 2 の再裁定漏れ窓が消える

## Alternatives considered

- **read-back 方式** (respond 失敗時に transport から確定状態を読んで分岐): transport 契約へ読み出し API を追加する必要があり、Decision 2 の再送冪等で同じ安全性を達成できるため不採用
- **有限 retry + 諦め**: 諦めた時点で滞留が再発し、seq を持たない request は health で検知できないため不採用
- **現状維持 (error 上書き)**: 恒久分岐の原因そのもの

## Consequences

- `src/testing/memory-hub.ts` に respondRequest / saveSnapshot の failure injection を追加し、各失敗点で SPEC 不変条件 2〜4 を固定する
- 裁定成功パスの挙動は不変 (既存テストは green を維持する)
- SPEC-0001 の「対策済み」表と host fork の記述を本 ADR の内容へ更新する
