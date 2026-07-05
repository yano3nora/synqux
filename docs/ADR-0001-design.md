# ADR-0001: 同期基盤のパッケージ化設計

- Status: Accepted
- Date: 2026-07-03（起草）/ 2026-07-04（全論点収束）

## Context

社内ブラウザゲームはテンプレート repo を丸ごと複製して出荷しており、端末間同期基盤（クライアントホスト型 × Redux × Firebase RTDB、詳細は `SPEC-0001-requests-sync.md`）はテンプレートに埋め込まれた状態で約 5 年運用してきた。この形には以下の問題がある。

1. **修正の伝播が手作業**: 年数回の不具合修正のたびに「ゲーム repo で直す → テンプレ repo へ入れ直す → 他のアクティブな repo へも手で反映」が発生する
2. **bus factor 1**: 同期基盤は分散システムの知識を要する聖域で、feature 開発者は触れない。コードがテンプレ内にあることで境界も曖昧
3. **テスト困難**: 処理済みリスト等がモジュール変数で、firebase に直接依存しているため、重複配信・遅延などの分散シナリオを決定的に再現できない。実際に競合バグが 3 件潜在していた（SPEC の既知の問題①①′②）
4. **インフラ固定**: firebase の型・API が中核コードに直接現れており、将来のインフラ乗り換え（DynamoDB 等は検討段階）ができない

要求はシンプルで、「npm ライブラリのようにバージョンアップをサクッと行えるようにしたい」。

## Decision

### 1. 単機能ライブラリ `synqux` として npm 公開する（MIT）

- 個人 npm アカウントで MIT 公開しつつ、自社ゲーム repo 群が第一の消費者となる
- **framework 化はしない**。消費者は実質自社 repo のみであり、仮想ユーザ向けの柔軟性は YAGNI。API 表面積を最小に保つことが breaking change の抑制 =「サクッとバージョンアップ」の実現条件
- **パッケージ分割はしない**。単一 package + subpath exports（`synqux` / `synqux/react` / `synqux/testing` / `synqux/firebase` など）で提供する。multi-package はバージョン整合の運用コストが「サクッと」に反する

### 2. transport 抽象を導入し、firebase を adapter の 1 実装に格下げする

- core が依存するのは「NoSQL な JSON を websocket で高速に sync できるインフラ」を抽象化した transport interface のみ
- 必要な能力は (a) request の追記 push、(b) 変更イベントの購読、(c) snapshot の永続化と取得、程度に絞る
- 将来のインフラ変更（DynamoDB 等）は adapter 追加で対応し、core と consumer コードに手を入れない

### 3. インスタンスベースの API にする（モジュール変数の廃止）

```ts
// 設計コンセプト: 「firebase 依存」と「consumer アプリ依存」の両方を注入に変え、
// core は「順序保証つき request/response ステートマシン」だけになる
const sync = createSynqux<GameState, GameAction>({
  transport: firebaseTransport(db),   // adapter。テストでは in-memory 実装に差し替え
  isSyncedAction,                     // 何を request 化するか (consumer が決める)
  rootReducer,                        // 判定器の注入 (host が試し実行する)
})
// sync.middlewares / sync.reducers / sync.subscribe(...) を store 構築時に配線
// 処理済みリスト (REVISIONS 相当) 等の同期状態はすべてインスタンス内部に持つ
```

- 移植元のモジュール変数（`REVISIONS` / `REQUESTS` / `unsubs`）が原因だった「リロード時の暗黙リセット」「テスト間の状態漏れ」「二重購読ガードの脆さ」を、API の形の時点で構造的に解決する

### 4. テストユーティリティを公開 API に含める（`synqux/testing`）

- in-memory transport + 障害注入（重複配信・遅延・順序入れ替え・ドロップ・切断）による決定的 simulation test を core の開発基盤とする
- **host migration 境界のシナリオ（dual-host 窓・未応答 request の引き継ぎ・昇格待機中の滞留）を simulation test の必須カバレッジとする**。移植元の既知の問題は全て migration / 離脱境界で発生しており、firebase 相手では再現が運任せだったものを決定的に再現可能にすることが、パッケージ化の中心的な価値
- consumer 向けに action 冪等性ハーネス（「二重適用 / ドロップしても不変条件が守られるか」の検証）を提供し、「toggle 型 action の脆弱性」クラスの問題を consumer の CI で検出可能にする。教育をドキュメントから機械的強制に変える

### 5. 段階的に移行する（各フェーズ単体で出荷可能）

1. **Phase 0**: 移植元 repo の現挙動を characterization test で固定する（既知の問題①①′②を再現するテストを含む）。テストなしの切り出しは 5 年動いたコードの盲目リライトになるため禁止
2. **Phase 1**: 公開 API 境界の確定と core の移植・インスタンス化。既知の問題の修正もここで行う
3. **Phase 2**: npm publish、テンプレ repo を synqux 依存に置換して薄くする
4. **Phase 3**: 分散制御層の本格リファクタ（ポーリングのイベント駆動化、host 採番の連番導入など）を semver の中で安全に行う

### 6. バージョニング運用

- テンプレ repo は `^latest` を追従、出荷済みゲーム repo は exact pin
- backport は「進行不能クラスの修正のみ」。全 repo を常に最新へ追わせる運用はしない

### 7. 消費者向け API は「セットアップ層」と「ゲーム開発者層」の 2 層に分ける

connections / requests は core に含めた上で（host 判定は「全端末が同じ結論に達する純粋関数」であることが同期の成立条件のため、consumer に委ねない）、ゲーム開発者からは実装を隠蔽する。

- **セットアップ層**（テンプレに 1 ファイル、feature 開発者は触らない）: `createSynqux()` によるインスタンス生成と store 配線。内部 slice（requests / connections 相当）は予約 key（`state.synqux`）配下にライブラリ自身が mount し、consumer は直接読み書きしない
- **ゲーム開発者層**（教育対象はここだけ、覚えることは 3 つ）:
    1. 「同期 state は直接触るな、action を dispatch しろ」— request 化は自動で起きる。書き方は普通の Redux と同じ
    2. 「validation は reducer で、ダメなら `stateWithError` を返せ」— reducer ヘルパーとして export
    3. 「host か・誰がいるか・結果通知は selector / hooks で読め」— `selectIsHost` / `selectPeers` / `selectLatestResult` 等。react hooks は `synqux/react` から
- 隠蔽の線引きは「**仕組みと書き込みを隠す、情報は隠さない**」。requests / prev チェーン / revisions は語彙ごと見せない。host / peers / 自身の接続状態 / result は読み取り専用で公開する
- `result`（判定器が書き host が読むフィールド）は同期 state 側に住む必要があるため、consumer の synced state に `result` 等を持たせる型契約 `SynquxSynced<T>` を提供する
- ゲーム reducer を独自ラッパー（`createSyncedSlice` 等）で包ませることは**しない**。「普通の RTK の書き方がそのまま同期される」ことが本ライブラリの価値であり、書き方への介入は教育コストを逆に増やす

### 8. 「synced reducer は純粋関数、locals は前段参照」を直列 helper として提供する

同期状態と端末ローカル状態の管理方法（移植元の serial rootReducer + `meta.root` イディオム）は、同期ソリューションの How の一部としてライブラリが提供する。

- **synced reducer の契約**: `(synced state, action)` の純粋関数。読んでよいのは payload と、request 封筒由来の決定的な meta（`requestedBy` / サーバ採番 timestamp）のみ。**synced reducer に `meta.root` は渡されない** — host の試し実行と各端末での適用が同一結果になること（決定性）が構成上保証され、端末ローカル state 参照による同期分岐も構造的に不可能になる（防止は目的ではなく副産物）
- **local slice 向けに `createSynquxRootReducer`（仮）を同梱**:
    - 実行順は「synqux 内部 slice → synced（meta.root なし）→ locals（**宣言順**、meta.root 付き）」
    - `meta.root` は直列進行に応じて更新される。locals は「適用後の synced state」と「自分より前に実行された local state」を読める — 移植元 store.ts と同一セマンティクス
    - 内部のデータ受け渡しチャネルは抽象しておき、将来 ctx 引数方式（第 3 引数）へ移行できる余地を残す
- primitive API（Decision 7 の spread 方式）は残し、helper はその上の sugar とする。helper が合わない consumer への脱出口
- RTK の serializableCheck に `ignoredActionPaths: ['meta.root']` が必要な点をドキュメント化する
- 検討した代替案: listener middleware への誘導（1 tick 遅延と既存イディオムの全面書き換えのため不採用）、ctx 引数方式（action を汚さず型も綺麗だが、安全な方向の既存コードまで書き換えが必要になるため初期版では不採用）
- 純粋性契約でも防げない残余クラス（reducer 内の `Date.now()` / `Math.random()` 等）に対し、dev モードで「host の試し実行結果 vs 実適用後 state」を比較する検出網を設ける

### 9. Redux Toolkit を peerDependency とする

- `stateWithError` 規約（draft を直接書き換えて返す）は immer 前提であり、plain redux をサポートすることは「reducer が判定器」という中核規約の二方言サポートを意味してコストが大きい
- キュー処理の fork は `createListenerMiddleware` に実績があり、redux-saga は縮小傾向の依存を増やすだけ
- 消費者は実質自社 repo のみのため、RTK 前提で開き直る

### 10. host 採番の連番導入は Phase 3 で行う（前倒ししない）

順序判定の client 時計依存（push id 比較）を host 採番 seq に置き換える案（clock skew ドロップの根治 + prev チェーン/REVISIONS 配列のカウンタ化）は、v1 では**やらない**。

- Decision 7 により requests / prev / revisions は消費者から隠蔽済みのため、seq 導入は公開 API に影響しない。「API に影響するなら前倒し」の条件が満たされない
- 本パッケージ化の目的は「穴をテスト可能な状態にして潰す」ことであり、Phase 1 は 5 年の実績がある実装の忠実移植を守る。seq は dual-host 窓での採番衝突という現行に存在しない失敗モードを持ち込むため、fencing（host 世代番号等）の新規設計を伴う。テスト基盤が整った Phase 3 で行うのが正道
- ただし Phase 1 で保険を 2 つ仕込む:
    1. 順序判定（遅延か・次に適用すべきか・適用済みか）を小さな内部モジュールに隔離し、Phase 3 の seq 化が差し替えで済む形にする
    2. 永続化する封筒（request / snapshot）に schema version フィールドを入れ、将来の形式変更時に新旧混在を「検出して明示的に拒否」できるようにする
- wire format 変更に伴う端末間バージョン混在は「出荷済みは exact pin / セッション進行中にデプロイしない」の運用（Decision 6）で吸収する

### 11. snapshot は「core が canonical JSON 文字列化、adapter は不透明文字列の KV」に分割する

snapshot の正しさの条件は「request 列上の正確な一点と、その時点の state が原子的にペアで取れること」のみ。鮮度は正しさの条件ではなく（古い snapshot は requests の replay で追いつける）、cost の問題である。この性質に基づき責務を分割する。

- **transport の snapshot API は不透明文字列の KV**（`saveSnapshot(key, payload: string)` / `loadSnapshot(key)`）
- **封筒の構築と canonical JSON 文字列化は core の責務**。封筒 = synced state + 順序判定モジュールの状態（現行の revisions 相当、Decision 10）+ schema version
    - 形状保存問題（RTDB が空配列・空オブジェクト・undefined を落とす等、ストレージ固有の直列化の罠）を core で一度だけ解き、adapter 実装コストを最小化する
    - どのインフラでも snapshot が同一フォーマットになるため、export 解析による調査手順（`SPEC-0001-requests-sync.md` の Trouble Shooting）が infra 非依存の資産として残る
- **「いつ永続化するか」は core の policy**。v1 は移植元踏襲で「受理 request ごと」とし、policy を 1 箇所に隔離して将来の throttle（受理 N 件ごと / debounce）に備える
- **retention 契約を transport interface に明記する**:「adapter は最新 snapshot 地点より新しい requests を保持しなければならない」。requests を prune する将来の transport（TTL 等）が復帰不能バグを作ることを防ぐ
- **差分永続化は不採用**。復元経路（同期基盤の信頼性の立脚点）に「base + patch 再構築」という新しいバグクラスを持ち込まない。書き込み削減は頻度 policy で行い、チャンク分割・圧縮は adapter 内部の自由とする（例: DynamoDB の 400KB item 制限への対応）
- 検討した代替案: 構造化封筒を adapter が直列化する案は、adapter の最適化自由度（差分・部分クエリ）と引き換えに形状保存問題を adapter ごとに再解決させるため不採用。snapshot の分析的クエリが必要になった場合は、snapshot の構造化ではなくイベントログ等の別経路で対応する

## Alternatives Considered

- **全ゲームの monorepo 化**: 修正の伝播は最速になるが、ゲームごとに納品先・アクセス権が分かれる受託の形と衝突するため不採用
- **git submodule / subtree**: DX が悪い（submodule）、マージが煩雑（subtree）。バージョンという概念が弱く「pin と ^latest の使い分け」ができないため不採用
- **GitHub Packages (private)**: 当初候補だったが、MIT で一般公開する方針としたため public npm を採用
- **framework 化（設定・プラグイン機構の整備）**: 消費者が自社のみのため不採用。必要になった時点で ADR を起こす

## Consequences

### 良くなること

- 同期基盤の修正が「synqux で直す → publish → 各 repo で `npm update`」に一本化される
- transport 抽象により firebase 依存の解消パスができる。simulation test により競合バグを決定的に再現・回帰検証できる
- SPEC / ADR / テストが 1 repo に集まり、聖域の bus factor が下がる

### リスク・コスト

- **切り出し境界の山場は `meta.root` を使うカスタム rootReducer と consumer State 型の絡み**。generics でどこまで縛るかの型設計に最も時間がかかる見込み
- 公開ライブラリとしての体裁（README、semver 規律、CHANGELOG）の維持コストが発生する
- 移植元との二重管理期間（Phase 1〜2 の間）は修正を両方に入れる必要がある。期間を短くする

## Migration Notes（移植元テンプレートへの影響）

Decision 8 の純粋性契約により、移植元で「synced reducer が `meta.root` から端末ローカル state を読んでいる」4 action が構成的に壊れる（元々 payload 不足の不具合であり、修正が正道）。

- 対象: `launchMessages` / `launchTalks` / `clearTalks`（`meta.root.scenes.phase` 参照）、`debugUpdatePhasePoint`（同・validation 用）
- 修正レシピは共通で「**phase を payload に含める**」。dispatch 側（UI / debug tool）は scenes.phase を知っている
- `isSucceededGameAction` / `isMySucceededGameAction`（`meta.root.game.result` / `connections.selfId` 参照）は **local slice からのみ呼ばれる方向 A のヘルパー**であり、helper 経由の locals では引き続き動作する
- いずれも Phase 0 の characterization test 対象に含める。`launchTalks` / `clearTalks` は静的な dispatch 箇所が見当たらないため、間接 dispatch（message の next action 等）の有無を Phase 0 で確認する

## Open Questions

すべて解決済み: connections の内包と隠蔽方針（→ Decision 7）、パッケージ分割（→ Decision 1）、`meta.root` と同期/ローカル状態管理の提供方法（→ Decision 8）、RTK 依存（→ Decision 9）、host 採番連番のタイミング（→ Decision 10）、snapshot 永続化の責務分割（→ Decision 11）。

本 ADR の設計論点は収束した。

## Progress

- **Phase 0 完了（2026-07-04）**: 移植元 repo に characterization test を整備した（`src/constants/requests.test.ts` / `src/ui/modules/requests/middlewares.test.ts`、詳細は移植元の `docs/TASK-260704-synqux-phase0.md`）。特記事項:
    - 既知の問題①（revisions 二重記録）は fake timers で決定的に再現・固定済み（ack 遅延時のみ発生、対照テストあり）
    - 既知の問題①′（二重 dispatch 窓）は「未発火と推定」から「**機構として実在を確認**」へ更新。同一 response の同時二重配送で二重適用が再現した（時間差配送なら既存ガードで冪等）
    - 既知の問題②（clock skew ドロップ）の判定機構を unit test で固定済み
    - `launchTalks` / `clearTalks` は移植元に dispatch 箇所なし（間接 dispatch 機構 `message.next.action` は存在するが未使用）。Migration Notes の宿題は解消
- **Phase 1 完了（2026-07-05）**: 公開 API 境界の確定と core の移植・インスタンス化。特記事項:
    - API 境界の正は `docs/SPEC-0002-public-api.md`（レビュー決定: `agent`/`guest` → `role: 'player'|'dedicated'|'observer'`、`selectLatestResult` 廃止で result は synced state 直読み、standalone の local 永続化を `SnapshotStore` として責務に内包、`@yano3nora/ts-utils` は依存に含める）
    - 既知の問題①（revisions 二重記録）①′（二重 dispatch 窓）は「再現テストが落ちることを確認 → 修正」の手順で解消済み。②（clock skew）は再現テストと明文化のみ（根治は Phase 3 の Decision 10）
    - host migration 境界（dual-host 窓・未応答 request 引き継ぎ・host 不在滞留 → dedicated 昇格）を `synqux/testing` の memory hub で決定的にカバー
    - 意図的な移植元からの変更: host 導出に同時刻接続の tiebreak（id 辞書順）を追加（列挙順依存で端末間の結論が割れ得たため）
    - `createSimulation` は公開しない（memory hub + 自前 store 構築で成立するため。SPEC-0002-public-api.md 参照）
- **Phase 2 synqux 側完了（2026-07-05）**: `synqux/firebase` adapter 実装（実機は未検証）、publish 可能な体裁（0.1.0）。publish 実行とテンプレ置換はユーザ側の残タスク（手順書は git 管理外の docs/local/）
- **Phase 3 完了（2026-07-05、テンプレ置換より前倒し）**: 順序判定を host 採番 seq へ刷新（`ADR-0002-host-seq.md`、schema v2 / 0.2.0）。既知の問題②を機構ごと根絶、fork 待機のイベント駆動化で直列 2ms/req・migration 回復 10ms。前倒しの経緯と負荷実測は `TASK-260705-synqux-phase3.md`。snapshot throttle のみ意図的に残置（帯域問題が顕在化してから）
- 次: publish（ユーザ判断）→ テンプレ repo の置換（v2 形式へ一度で移行）
