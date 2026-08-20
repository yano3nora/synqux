# ADR-0018: session 固定 mode への統合と setEnabled の廃止

- Status: **Accepted** (2026-08-13)
- Date: 2026-08-13
- 関連: SPEC-0001 (setEnabled の契約), SPEC-0002 (公開 API), TASK-260719-setenabled-contract, ADR-0002 (host 採番 seq), ADR-0016 (host liveness)

## Context

`setEnabled(false)` は tutorial 用途の runtime 送信ゲートとして提供してきた。契約は「送信のみ停止・受信 / host 責務 / 購読は継続」であり、グループに他端末がいると remote 適用の混入や、自端末が host の場合の正史汚染が起きるため「他端末がいない / 動いていない前提で使う」注意書きで守っていた (SPEC-0001)。受信側も止める変種は、peer pool に籍を残す限り seq 欠番・health 自動回復の誤発動・host 導出の全端末合意崩壊を誘発するため棄却済み (TASK-260719)。

導入 consumer の tutorial 実装で、standalone instance との併用バグが発覚した。`synqux.enabled` が「instance 設定 (standalone) の反映」と「runtime 送信ゲート」の二義を 1 つの boolean で兼ねており、standalone では両者を区別できないため「off 中は localSnapshots へ保存しない」ガードが表現できない。結果、standalone 構成で tutorial を遊ぶと synced action のたびに本編セーブが上書き破壊される。

修正案として (a) middleware closure に runtime フラグを持つ対症療法、(b) state を `mode` + `enabled` の二軸へ分割、(c) `detach()` (transport のみ畳んで session を継続する片道遷移 API) を検討した。(c) は group からの正式離脱 (presence 離脱) なので棄却済み変種と違い consensus を壊さないが、「transport なし・session 継続」という新しいハイブリッド状態と cleanup の分割手術が必要になる。

最終的に「**runtime 可変フラグ自体を消す**」方向へ収束した。mode を session 生成時に固定し、切替は session の作り直し (unsubscribe → subscribe) で表現する。移植元の tutorial 実装も実態は「requests 停止 + 使い捨て key での再接続」= session の作り直しであり、これはそのパターンの公式化である。

## Decisions

1. **mode (`'synced' | 'standalone'`) は subscribe 時に固定し、runtime に変える API は提供しない**。`setEnabled` action と `SynquxState.enabled` を廃止し、`SynquxState.mode` に置換する。`sessionStarted` が session の mode を state へ反映し、`selectIsHost` は standalone で常に true (従来挙動を継承)。
2. **config の `enabled?: boolean` を `mode?: 'synced' | 'standalone'` (既定 `'synced'`) へ改名する**。instance の mode は subscribe 時の既定値であり、subscribe options の `mode?:` で session 単位に上書きできる。
3. **subscribe options に `localSnapshots?: false` を追加する** (session 単位の永続化無効化)。tutorial は `unsubscribe()` → `subscribe({ mode: 'standalone', localSnapshots: false })` で開始する。tutorial session は本編セーブの key に一切触れないため、上記バグは構造的に消滅する。
4. **tutorial からの復帰は「mode 遷移の逆操作」ではなく subscribe の再実行**とする: unsubscribe → subscribe (synced) で snapshot の正史から再出発する (reload はその app 層実装の 1 つ)。local 分岐 state のマージは host 採番 seq による線形化モデルと非互換のため、将来も提供しない。
5. 内部の `instanceEnabled` closure 分岐 (request 化判定・serverNow・setRole・dispatchAndWait・isSelfHost・persistLocalSnapshot) は `state.synqux.mode` と session が保持する実効 localSnapshots への参照に置換する。
6. `SYNQUX_SCHEMA_VERSION` は変更しない。mode は端末 local の概念で、versioned な request / snapshot 封筒には含まれない。

## Consequences

- SPEC-0001 の setEnabled 契約節と「グループに他端末がいない前提」の注意書きは削除される。tutorial session はそもそも group に参加しないため、正史汚染の footgun は文書ではなく設計で防がれる。
- tutorial 中の session は通常の standalone 構成と同一コードパスに乗る。専用状態 (送信だけ止まった synced session) のテスト・保守が不要になる。
- 切替の遷移中、phase は live → idle → subscribing → live と遷移する。この窓で synced action を dispatch しないことは consumer (tutorial 開始 thunk) の責務。in-flight の `dispatchAndWait` は unsubscribe で reject される (既存挙動)。
- `setEnabled` / `config.enabled` / `SynquxState.enabled` の削除は pre-1.0 の breaking change (0.9.0)。既知の利用は導入 consumer 1 repo の未リリース listener 1 行のみ。
- standalone session の `connections` は空 (selfId null) になる。peers 表示系 UI は standalone 構成と同じ見え方になる。

## Amendment (2026-08-21): standalone subscribe の seedSynced (初期 synced state 注入)

実装は `TASK-260821-seed-synced.md`。

導入 consumer の tutorial 実装は、Decision 3 の「standalone session への作り直し」までは
本 ADR 通りに移行できたが、**新 session の初期 state を注入する公式経路がなかった**ため、
synced slice の `reducers` ブロックに非同期 action (`game/_` prefix の system action) を
残して standalone live 後に dispatch していた。この抜け穴は「synced reducer が case で
扱う action は全部 synced action」という認知モデルを歪める。実体は game action ではなく
**session bootstrap = restore の亜種** (synced subtree の全量差し替え) である。

1. `SynquxSubscribeOptions` に `seedSynced?: TSynced` を追加する。standalone 分岐で
   既存の restore 経路 (`synquxRestored` + result 除去) に合流し、新しい不変条件を
   作らない。ordering は「snapshot なし」と同じく新規に始める
2. **standalone 限定**。synced session の正史は transport snapshot のため、mode
   'synced' との併用は subscribe を throw で reject する。「tutorial state が裁定
   経路・snapshot 正史に乗ること自体が構造的に不可能」を維持する (synced action 化
   + 呼び出し規律で守る代替案は、synced reducer が session mode を読めない (決定性)
   ため reducer 側で防御できず棄却)
3. 優先順位: seedSynced 指定時は localSnapshots を load しない (明示 > 永続)。
   localSnapshots 有効との併用は「seed 起点の新規セーブ開始」の意味論になる
4. **seed は session-scoped**。session 開始時に ordering を新規化し (restore が維持
   する transient 群も含む。`Ordering.reset` の doc 参照)、teardown で synced
   subtree を reducer の初期 state へ戻す。どちらか一方だけだと snapshot 欠損の
   synced 復帰で「seed state + backlog replay」の暗黙マージ (Decision 4 の
   マージ非互換に抵触) か「added guard 残留による replay 破棄」が起きる。
   両方を対にすることで、その縮退でも「initial + backlog replay = 正史」が成立する
5. tutorial の推奨形は `unsubscribe()` → `subscribe({ mode: 'standalone',
   localSnapshots: false, seedSynced: buildTutorialState() })`。tutorial 状態は
   action ではなく pure な builder 関数で表現する
