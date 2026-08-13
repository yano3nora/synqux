# SPEC: 公開 API 境界

- Status: **Accepted (2026-07-05 レビュー反映済み)**。本書を正として Phase 1 の実装に入る
- 根拠: `ADR-0001-design.md` Decision 3 / 7 / 8 / 10 / 11、移植元 (社内 repo) の現物コード
- 実装が進んで型定義が実体化したら、詳細シグネチャはコード (d.ts) を正とし、本書は「境界の線引きと理由」を保守する

## 設計コンセプト

移植元で「firebase 依存 (`subscribe-*.ts` / `create-request.ts` / `update-game-state.ts`)」と「consumer アプリ依存 (`GameState` / `isGameDomainAction` / rootReducer)」だった箇所をすべて注入に変え、core を「順序保証つき request/response ステートマシン」だけにする。モジュール変数 (`REVISIONS` / `REQUESTS` / `unsubs`) はインスタンス内部状態へ移す。

語彙の対応 (移植元 → synqux): `game` → synced (consumer が key 名を決める) / `gameId` → `groupId` / `Connection` → `Peer` (公開語彙のみ、封筒内部は connection のまま)。

## A1: 公開型シグネチャ

```ts
// ============================================================
// 共有語彙 (synqux main entry)
// ============================================================

export type PeerRole = 'player' | 'dedicated' | 'guest'

/** 同期グループ内の接続端末。読み取り専用で公開する (Decision 7) */
export type Peer = {
  id: string
  groupId: string
  /** transport のサーバ基準時刻。host 導出の全端末合意に使うため端末時計は使わない */
  connected: number
  /**
   * 端末の役割 (排他)。省略時 'player'
   * - player: 通常端末。dedicated 不在時、最新接続の player が host になる
   * - dedicated: ゲームに常駐するプロセス (lambda 等) を強制的に host にし、
   *   安定進行・無人進行を担う。存在時は最新接続の dedicated が host になる
   *   (移植元の agent 相当。dedicated server 文化からの命名)
   * - guest: host 選定から除外される参加者。request 発行は制限しない
   */
  role?: PeerRole
  /** 端末の識別ラベル (移植元で agent が持っていた process id 相当)。host 導出には使わない */
  label?: string
}

/** Result.message の型契約 (ADR-0008)。拡張は consumer が generics で行う */
export type ResultMessage = { text: string }

/**
 * reducer (唯一の判定器) が書き、host が読む成否判定結果
 * 拒否された request は state に痕跡を残せないため、result が失敗 feedback の
 * 唯一のチャネル。通知は message (UI 表示、表示は consumer 責務) と
 * log (console 出力、synqux が出力) の 2 系統 (ADR-0008)
 */
export type Result<
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
> = {
  action: TAction
  type: 'error' | 'success'
  /** UI 表示想定データ。undefined なら画面通知なし。error かつ message なしは
      「log 専用の拒否」として dispatch 自体が省略される */
  message?: TMessage
  /** 通知先 peer id。standalone 時は [] で無条件表示 */
  targets: Peer['id'][]
  /** console 出力。synqux が type に応じて console.log / error へ targets 準拠で出力 */
  log?: string
}

/**
 * consumer の synced state への型契約 (Decision 7)
 * 移植元 GameState と違い revisions は含まない — 順序状態は synqux が
 * snapshot 封筒側で管理する (Decision 11)
 */
export type SynquxSynced<
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
> = {
  result: Result<TAction, TMessage> | null
}

/** 端末ローカルの seq gap 検知・自動回復状態 */
export type SynquxHealth = {
  phase: 'ok' | 'stalled' | 'recovering' | 'unrecoverable'
  expectedSeq: number | null
  maxSeenSeq: number | null
  gapSince: number | null
}

export type SynquxPhase = 'idle' | 'subscribing' | 'live'

/**
 * synqux が action に載せる meta の契約
 * synced reducer が読んでよいのは requestedBy / dispatched のみ (Decision 8)
 */
export type SynquxActionMeta = {
  /** request 経路を通った action に付与。actionRequest middleware の素通し判定を兼ねる */
  requestedBy?: Peer['id']
  /** transport サーバ基準の登録時刻 */
  dispatched?: number
  /** 端末内での action 一意性。内部 entities 破棄・result 通知の重複判定に使う */
  hash?: string
  /** locals reducer にのみ付与される直前実行結果 (createSynquxRootReducer)。synced には渡らない */
  root?: unknown
}

// ============================================================
// createSynqux (セットアップ層、Decision 3)
// ============================================================

export type CreateSynquxConfig<
  TRoot extends { synqux: SynquxState },
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
> = {
  transport: SynquxTransport
  /** 何を request 化するか。consumer の synced domain action の判定述語 */
  isSyncedAction: (action: Action) => action is TAction
  /** host が試し実行する判定器。通常 createSynquxRootReducer の返り値を渡す */
  rootReducer: Reducer<TRoot>
  /** 試し実行結果から result を読む位置。通常 createSynquxRootReducer の返り値を渡す */
  selectSynced: (root: TRoot) => TSynced
  /** false で standalone (同期なし・host 常時 true)。既定 true。runtime 切替は actions.setEnabled */
  enabled?: boolean
  /** seq gap が継続したと判定するヒステリシス ms。既定 30,000。correctness には使わない */
  stallAfterMs?: number
  /** readonly 端末などで request 送信自体を抑止する hook (移植元 scenes.readonly 相当)。既定 () => true */
  canRequest?: (root: TRoot) => boolean
  /**
   * host だけが評価する自動 dispatch rule 表 (ADR-0015)。非ユーザー起点 dispatch
   * (状態 watcher / タイマー / retry) の統一 API。標準 middleware 経路で request 化
   * されるため canRequest に従う。setEnabled(false) 中も評価を止めない (tutorial 中の
   * 制御は consumer が when の述語で行う)
   */
  automations?: SynquxAutomation<TSynced, TAction>[]
  /**
   * 適用済み synced action に反応する live 配信専用 rule 表 (ADR-0017)。
   * host-only / everyone の発火主体、restore replay の除外、effect 失敗の隔離を
   * engine が担う。effect は best-effort のため冪等にし、dispatch しないこと
   */
  listeners?: SynquxListener<TSynced, TAction>[]
  /**
   * host 生存監視 (ADR-0016)。host は heartbeatIntervalMs (既定 30,000) ごとに
   * presence の lastSeenAt をサーバ時刻で更新し、他端末は staleThresholdMs
   * (既定 180,000) を超えて沈黙した host を guest へ降格して migration を促す。
   * false で無効化。既定値は TASK-260812 の実測に基づき、staleThresholdMs は
   * heartbeatIntervalMs の 2 倍未満を生成時に拒否する (誤降格防止)
   */
  hostLiveness?: SynquxHostLiveness | false
  /**
   * standalone (enabled=false で生成した instance) の synced state 永続化先。
   * browser では省略時に localStorageSnapshotStore() を使い、false で無効化する。
   * SnapshotStore 注入で差し替え可能。runtime の setEnabled(false) では保存しない
   */
  localSnapshots?: SnapshotStore | false
  /** 購読 phase の実遷移通知。同値遷移では呼ばない */
  onPhaseChanged?: (phase: SynquxPhase) => void
  /** subscribe の rollback 後に失敗を通知。callback の throw は握りつぶす */
  onSubscribeFailed?: (error: unknown) => void
  /** unrecoverable へ遷移した瞬間の通知。unsubscribe まで一度だけ */
  onUnrecoverable?: () => void
}

/** host 生存監視の設定 (ADR-0016)。既定 30,000 / 180,000 */
export type SynquxHostLiveness = {
  /** host が lastSeenAt を touch する間隔 ms */
  heartbeatIntervalMs?: number
  /** これを超えて heartbeat の無い host を降格する ms */
  staleThresholdMs?: number
}

/**
 * 自動 dispatch rule (ADR-0015)。host である端末だけが評価・発行する。
 * engine は exactly-once を保証しない (dual-host 窓で二重発行があり得る) ため、
 * action は ADR-0007 の idempotent / rejects-repeat 契約を満たすこと
 */
export type SynquxAutomation<TSynced, TAction extends Action> = {
  /** rule の識別子。重複は createSynqux が throw。retryMs は正の有限数のみ許容 */
  id: string
  /**
   * 「今この action が必要か」。synced とサーバ時刻 (standalone は端末時計) のみ
   * 読める — locals 遮断は host のローカル state が群の判定へ混入する事故の型レベル排除。
   * 契約: action が適用されたら false に戻ること (自己終了)。true の間 retryMs おきに再発行
   */
  when: (synced: TSynced, ctx: { now: number }) => boolean
  action: (synced: TSynced) => TAction
  /** 再発行間隔 ms。既定 1000 */
  retryMs?: number
}

/**
 * 適用済み synced action に反応する live 配信専用 listener (ADR-0017)。
 * restore replay では発火せず、throw / rejection は engine が握りつぶす。
 * exactly-once は保証しないため effect は冪等にし、effect から dispatch しないこと
 */
export type SynquxListener<TSynced, TAction extends Action> = {
  /** rule の識別子。重複は createSynqux が throw */
  id: string
  /** 適用された synced action に対する発火トリガー */
  match: (action: TAction) => boolean
  /** host 端末だけで発火するか、適用した全端末で発火するか */
  mode: 'host-only' | 'everyone'
  /** dispatch を持たない副作用本体。ctx は適用後の synced state のみ */
  effect: (action: TAction, ctx: { synced: TSynced }) => void | Promise<void>
}

export type SynquxSubscribeOptions<TRoot> = {
  store: { dispatch: Dispatch; getState: () => TRoot }
  groupId: string
  role?: Peer['role']
  label?: Peer['label']
  /** 初期化の中断。低レベル API では省略時に無期限待機 */
  signal?: AbortSignal
}

export type Synqux<TRoot, TSynced, TAction> = {
  /**
   * store 構築時に prepend する middleware 群 (順序保証のため配列で提供)
   * [meta setter (hash/dispatched), actionRequest, requestListener, responseListener]
   */
  middlewares: Middleware[]

  /**
   * 予約 key `state.synqux` に mount する内部 slice (primitive 方式用)
   * createSynquxRootReducer 利用時は自動で組み込まれるので触らない
   */
  reducer: Reducer<SynquxState>

  /**
   * presence 登録 → snapshot restore → requests 購読を開始する
   * standalone (enabled=false) 時は transport に触れず localSnapshots から restore する
   * 返り値で購読破棄 + presence 解除。二重購読はインスタンス内部でガード
   */
  subscribe: (options: SynquxSubscribeOptions<TRoot>) => Promise<() => Promise<void>>

  /** 自端末の role を presence 上で in-place 更新する。未 subscribe は throw、standalone は no-op */
  setRole(role: PeerRole): Promise<void>

  /**
   * dispatch し、自端末でその action (hash) の裁定結果の処理が完了した時点で
   * Result を resolve する (ADR-0015、BACKLOG P1 の格上げ)。success / error (拒否) とも
   * resolve で返し、reject は signal abort / unsubscribe のみ。契約は「自端末適用まで」—
   * 全端末への適用完了は分散システム上保証できない。timeout は提供せず consumer が
   * AbortSignal.timeout() 等で選ぶ (ADR-0012 と同じ政策)。未 subscribe は throw、
   * 非 synced action / canRequest false (request 化されず解決不能) は即 reject。
   * standalone / setEnabled(false) 中は local 即時適用の result で即 resolve
   */
  dispatchAndWait(action: TAction, options?: { signal?: AbortSignal }): Promise<Result<TAction>>

  actions: {
    /** tutorial 等で runtime に同期を on/off する (移植元 _prepareTutorial 相当) */
    setEnabled: ActionCreator<boolean>
  }
}

export function createSynqux<TRoot, TSynced, TAction>(
  config: CreateSynquxConfig<TRoot, TSynced, TAction>,
): Synqux<TRoot, TSynced, TAction>

// ============================================================
// createSynquxRootReducer (Decision 8)
// ============================================================

/**
 * 実行順: synqux 内部 slice → synced (meta.root なし) → locals (宣言順、meta.root 付き)
 * locals は「適用後の synced state」と「自分より前の locals」を meta.root で読める
 * (移植元 store.ts の直列 rootReducer と同一セマンティクス)
 *
 * 返り値を createSynqux config へ spread するだけで配線が終わる:
 *   createSynqux({ transport, ...createSynquxRootReducer({ isSyncedAction, ... }) })
 *
 * consumer 側の注意: RTK serializableCheck に ignoredActionPaths: ['meta.root'] が必要
 */
export function createSynquxRootReducer<
  TSyncedKey extends string,
  TAction extends Action,
  TSynced extends SynquxSynced,
  TLocals extends Record<string, unknown>,
>(config: {
  /** synced reducer の前段で default success を stamp する対象 action */
  isSyncedAction: (action: Action) => action is TAction
  /**
   * 仕様: 同期対象 slice はちょうど 1 つ (それ以外は throw)。複数ドメインを
   * 同期したい consumer は 1 つの合成 reducer に畳み、result を top-level へ
   * 写す (実例: demo/main.ts の demoReducer)。判断メモ 4 を参照
   */
  synced: Record<TSyncedKey, Reducer<TSynced>>
  /** 宣言順に直列実行される端末ローカル slice 群 */
  locals: { [K in keyof TLocals]: Reducer<TLocals[K]> }
}): {
  rootReducer: Reducer<{ synqux: SynquxState } & Record<TSyncedKey, TSynced> & TLocals>
  selectSynced: (root: Record<TSyncedKey, TSynced>) => TSynced
  /** config に渡した型ガードと同一参照。createSynqux への spread 用 */
  isSyncedAction: (action: Action) => action is TAction
}

/** primitive 方式 (helper が合わない consumer の脱出口) 用に内部 slice reducer も単体 export */
export const synquxReducer: Reducer<SynquxState>

// ============================================================
// primitive 方式の正式契約 (2026-07-20 正式化、TASK-260720-primitive-contract)
// ============================================================

/**
 * snapshot restore の合図として core が dispatch する action。
 *
 * primitive 方式 (手書き rootReducer) の契約:
 * 1. `synquxReducer` を予約 key `state.synqux` に mount する (位置は固定)
 * 2. rootReducer で本 action を match し、synced subtree を `payload.synced` で
 *    全量差し替える (createSynquxRootReducer 利用時は自動で処理される)
 * 3. synced domain action では synced reducer の前段で `stateWithDefaultResult` を
 *    必ず呼び、今回の action 自身の default success を stamp する (ADR-0013)
 * 4. 【危険・禁止】consumer が自分で dispatch しないこと — request 経路を通らない
 *    state 差し替えは自端末にしか起きず、他端末と静かに desync する。
 *    dispatch する主体は core (subscribe 時の restore / 回復時の再 restore) のみ。
 *    consumer が触れてよいのは match (+ 自前 rootReducer のテストでの再現) まで
 */
export const synquxRestored: PayloadActionCreator<{ synced: unknown }>

/**
 * 受信済み・適用未完了 request の内部表現 (`SynquxState.requests.entities` の値)。
 * `SynquxState` を公開する以上、構成型として公開が必要になるもの。
 * consumer が読み書きする想定はない (request 語彙はゲーム開発者層に出さない)
 */
export type PendingRequest

// ============================================================
// reducer ヘルパー (ゲーム開発者層、Decision 7)
// ============================================================

/** synced reducer の実行前に action 自身の default success result を immutable に載せる */
export function stateWithDefaultResult<TSynced, TAction, TMessage extends ResultMessage = ResultMessage>(
  state: TSynced,
  action: TAction,
): TSynced

/**
 * validation 失敗時に draft へ error result を積んで返す。immer 前提 (Decision 9)
 * message 省略時は action.type を log とした「log 専用の拒否」になる (ADR-0008)
 */
export function stateWithError<TSynced, TAction, TMessage extends ResultMessage = ResultMessage>(
  state: TSynced,
  action: TAction,
  option?: { message?: TMessage; log?: string },
): TSynced

export function stateWithResult<TSynced, TAction, TMessage extends ResultMessage = ResultMessage>(state: TSynced, result: ...): TSynced

/** callback 内の変更を一括適用し、error 時は domain 変更を巻き戻して error result だけを残す */
export function stateWithTransaction<TSynced, TAction, TMessage extends ResultMessage = ResultMessage>(
  state: TSynced,
  mutate: (draft: TSynced) => void,
): TSynced

export function generateResult<TAction, TMessage extends ResultMessage = ResultMessage>(props: ...): Result<TAction, TMessage>

// ============================================================
// locals 用成功判定 matcher (ゲーム開発者層、Decision 8 / ADR-0013)
// ============================================================

/**
 * locals reducer 専用。createSynquxRootReducer の返り値をそのまま渡す。
 * meta.root が付かない synced reducer 内では常に false になり、そこで端末ローカル
 * 情報を読む用途には使えない (決定性を壊すため、その用途自体を禁止する)。
 */
export function createSyncedActionMatchers<
  TAction extends Action,
  TSynced extends SynquxSynced,
  TRoot extends { synqux: SynquxState },
>(config: {
  isSyncedAction: (action: Action) => action is TAction
  selectSynced: (root: TRoot) => TSynced
}): {
  /** result が action と同じ hash の success なら true。非 synced action は常に false */
  isSucceededAction: (action: Action) => action is TAction
  /** standalone なら成功時 true。同期中は requestedBy === selfId も要求する */
  isMySucceededAction: (action: Action) => action is TAction
}

/** prefix を consumer に露出せず、listener / middleware から内部 action を除外する */
export function isSynquxAction(action: Action): boolean

/** Result.targets の [] = 全員、それ以外 = peer id 宛て、という意味論を一元化する */
export function isResultForPeer(
  result: Pick<Result, 'targets'> | null | undefined,
  peerId: Peer['id'] | null,
): boolean

// ============================================================
// 読み取り selector (ゲーム開発者層、Decision 7)
// state.synqux が予約 key のため instance 不要の静的関数として提供できる
// ============================================================

export function selectIsHost(root: { synqux: SynquxState }): boolean  // standalone (enabled=false) 時は常に true
export function selectPeers(root: { synqux: SynquxState }): Peer[]
export function selectSelfId(root: { synqux: SynquxState }): Peer['id'] | null
export function selectSelf(root: { synqux: SynquxState }): Peer | null
export function selectSelfRole(root: { synqux: SynquxState }): PeerRole | null  // role 省略は player
export function selectSyncPhase(root: { synqux: SynquxState }): SynquxPhase  // replay と live の区別
export function selectIsLive(root: { synqux: SynquxState }): boolean
export function selectSyncHealth(root: { synqux: SynquxState }): SynquxHealth
export function selectIsSyncStalled(root: { synqux: SynquxState }): boolean
export function selectIsSyncUnrecoverable(root: { synqux: SynquxState }): boolean

// NOTE: selectLatestResult は提供しない (レビューで廃止決定)
// result は consumer 自身の synced state の所有物であり SynquxSynced 契約で型も見えるため
// `(s) => s.game.result` と直接読めばよい。「情報は隠さない」方針とも整合する
// react では useLatestResult を提供する (Provider が synced の位置を解決できるため迂回が不要)
// isResultForPeer / useMyLatestResult は直読み原則を変えず、「自分宛てか」の意味論だけを提供する
```

### `state.synqux` 内部 state (書き込み禁止・語彙は非公開)

```ts
/** 型自体は export するが、中身への直接アクセスは selector 経由のみサポート */
export type SynquxState = {
  /** subscribe の初期 restore 中か、ライブ配信へ移ったか。自動回復中は live のまま */
  phase: 'idle' | 'subscribing' | 'live'
  enabled: boolean
  health: SynquxHealth
  connections: {
    selfId: Peer['id'] | null
    entities: Record<Peer['id'], Peer>
  }
  requests: {
    /** 未適用 request の置き場。適用完了 (hash 一致の synced action 通過) で破棄 */
    entities: Record<string, RequestEnvelope>
  }
}
```

- 移植元との差分: `requests.enabled` → `synqux.enabled` へ昇格 (requests/connections を synqux 予約 key 配下に統合)。`connections.isNotFoundGame` / `connections.agent` は consumer 固有のため core から除外 (agent 相当は subscribe の `role: 'dedicated'` + `label` オプションへ)
- prev チェーン / revisions / 処理中ガードは redux state にすら置かず、インスタンス内部の順序判定モジュール (Decision 10) に持つ。ゲーム開発者から語彙ごと見えない

### `synqux/react` (ゲーム開発者層)

```ts
/** setup 層が store の Provider と並べて配線する。ゲーム開発者は hooks だけ覚える */
export function SynquxProvider(props: { sync: Synqux<any, any, any>; children: ReactNode }): JSX.Element

export function useIsHost(): boolean
export function usePeers(): Peer[]
export function useSelfId(): Peer['id'] | null
export function useSelf(): Peer | null
export function useSelfRole(): PeerRole | null
export function useSyncPhase(): SynquxPhase
export function useIsLive(): boolean
export function useSyncHealth(): SynquxHealth
export function useIsSyncStalled(): boolean
export function useIsSyncUnrecoverable(): boolean
export function useLatestResult<TAction, TMessage extends ResultMessage = ResultMessage>(): Result<TAction, TMessage> | null  // synced の位置は Provider 経由で解決
export function useMyLatestResult<TAction, TMessage extends ResultMessage = ResultMessage>(): Result<TAction, TMessage> | null
/** react consumer の購読開始の canonical な入口。groupId 未確定時は開始しない */
export function useSynquxSubscription<TRoot extends { synqux: SynquxState }>(
  synqux: Pick<Synqux<TRoot>, 'subscribe'>,
  options: Omit<SynquxSubscribeOptions<TRoot>, 'store' | 'groupId'> & {
    groupId?: string
  },
): SynquxPhase
```

`store` は `useStore()` から取得する。`state.synqux.phase !== 'idle'` を排他に使うため、
StrictMode や同一 store の多重 mount でも subscribe は二重発火しない。signal 省略時は
30 秒 timeout を補う。失敗遷移は `createSynqux` の `onSubscribeFailed` で設定する。

- peerDependencies: `react` / `react-redux` (optional peer、`synqux/react` を使うときのみ)

### `synqux/testing` (Decision 4)

```ts
/**
 * 決定的 in-memory 同期バックエンド。1 つの hub を複数の仮想端末 (transport) が共有する
 * fault injection は明示操作で行う (時間依存にしない)
 */
export function createMemoryHub(): {
  /** 仮想端末 1 台ぶんの transport を生成する。simulation では端末数ぶん作る */
  createTransport(): SynquxTransport

  /** 障害注入: 配送制御を test 側が握る。to 省略時は全端末が対象 */
  faults: {
    duplicate(target: { requestId; to?; event?: 'added' | 'changed' }): void  // 次の該当配送を 2 回にする (①′の再現に使う)
    delay(target: { requestId; to?; event? }): { release(): void }           // 配送保留 → 任意時点で解放 (順序入れ替え・遅延)
    drop(target: { requestId; to?; event? }): void                           // 次の該当配送を破棄
    holdAck(requestId): { release(): void }  // respondRequest の ack 解決だけ保留 (local echo は先に届く。①の再現に使う)
    disconnect(peerId): void                 // 端末側の disconnect() を経ない切断 (presence cleanup → onRemoved 発火)
  }

  /** テストの assert 用の覗き窓 (requests / snapshots / peers の生データ) */
  inspect: { ... }
}

/** result を除く domain state について、action の二重適用が冪等か検証する */
export function verifyActionIdempotency<TSynced, TAction>(config: {
  reducer: Reducer<TSynced>
  state: TSynced   // 前提 state (arrange 済みのもの)
  action: TAction
}): { idempotent: boolean; single: TSynced; double: TSynced }

/**
 * CI 組込み用の repeat contract 検査。mode 省略時は 'idempotent'
 * idempotent: set 型 / rejects-repeat: execute-once 型 / repeatable: 明示的な検査除外
 */
export function assertActionIdempotency<TSynced, TAction>(config: {
  reducer: Reducer<TSynced>
  state: TSynced
  action: TAction
  mode?: 'idempotent' | 'rejects-repeat' | 'repeatable'
}): void
```

`idempotent` は top-level の `result` を `null` に正規化した domain state の一致を指す。`rejects-repeat` は初回が error でないこと、2 回目で domain state が変わらないこと、2 回目が error になることを検査する。`repeatable` は無限実行型をレビュー済みとして table に残す no-op であり、同じ意図の別 request による実害評価は consumer の責任とする。

NOTE: 専用の `createSimulation` ハーネスは**公開しない** (実装時決定)。複数端末 simulation は「`createMemoryHub()` + consumer 自身の store 構築 + fake timers」の組合せで成立し、専用ラッパーは consumer の store 設定を再発明させるだけだった。書き方の実例は本 repo の `src/core/create-synqux.test.ts` / `src/core/host-migration.test.ts` を参照。

## A2: Transport interface

```ts
/**
 * 同期インフラの抽象 (Decision 2 / 11)
 *
 * 【契約 — adapter 実装者向け】
 * 1. pushRequest の id 採番は「group 内で一意かつ不変」であること。順序性は要求しない —
 *    適用順は host 採番の seq だけが担う (ADR-0002)。firebase push id のような
 *    挿入順辞書順単調 id は要件を満たす一例 (after オプション対応の前提)
 * 2. respondRequest は永続化 ack で resolve すること (楽観 resolve 禁止)
 * 3. 配送は at-least-once。重複・遅延・順序入れ替えは core 側が吸収するので
 *    adapter で頑張って直列化しなくてよい (素朴に流す)
 * 4. 【retention 契約】pruneRequests は「数値 seq < beforeSeq」のみ requests から
 *    取り除く (物理削除または logs への退避)。seq なし (未裁定) は取り除かない。snapshot 地点との整合は core が
 *    prune 線を適用窓の外に揃えることで保証する (ADR-0005)
 * 5. connect した peer の切断時、onRemoved が全端末で発火すること (onDisconnect 相当の
 *    presence cleanup を adapter が保証する)。切断から復帰した adapter は presence を
 *    自動復元し、connected は初回値を維持して host 序列を変えないこと (ADR-0006)
 */
/**
 * 不透明文字列の snapshot KV (Decision 11)。封筒構築・直列化は core の責務
 * transport の snapshot API と standalone の localSnapshots が同一契約を共有する
 */
export type SnapshotStore = {
  saveSnapshot(key: string, payload: string): Promise<void> | void
  loadSnapshot(key: string): Promise<string | null> | string | null
}

/** localStorage 実装の SnapshotStore (standalone 用の既定実装。ブラウザ環境のみ) */
export function localStorageSnapshotStore(): SnapshotStore

export type SynquxTransport = SnapshotStore & {
  /** presence 登録。selfId は transport が採番する。signal の abort は presence を残さず reject (契約 8, ADR-0012) */
  connect(options: { groupId: string; role?: Peer['role']; label?: Peer['label']; signal?: AbortSignal }): Promise<{ selfId: string }>
  disconnect(): Promise<void>
  /** id / connected を維持して presence を更新し、全 peer 購読へ onChanged を配送する (契約 9, ADR-0014) */
  updateSelf(patch: { role?: PeerRole }): Promise<void>
  /** 自 peer の lastSeenAt をサーバ時刻で touch する (契約 10, ADR-0016) */
  heartbeat(): Promise<void>
  /** 対象 peer の role を 'guest' へ書き換える。対象不在は no-op (契約 11, ADR-0016) */
  demotePeer(id: Peer['id']): Promise<void>

  /** サーバ基準時刻 (firebase: .info/serverTimeOffset 補正)。meta.dispatched / requested 用 */
  serverNow(): Promise<number>

  subscribePeers(handlers: {
    onAdded(peer: Peer): void
    onChanged(peer: Peer): void
    onRemoved(peer: Peer): void
    onError?(error: unknown): void  // 購読の回復不能な打ち切りの通知 (契約 8, ADR-0012)。渡されたら発火は adapter の義務
  }): Unsubscribe

  pushRequest(envelope: Omit<RequestEnvelope, 'id'>): Promise<{ id: string }>

  /** host の裁定を request へ焼き込む。(epoch, seq) が適用順の正になる (ADR-0002) */
  respondRequest(
    id: string,
    patch: { epoch: number; seq: number; responsedBy: Peer['id']; responsed: number; result: string | null },
  ): Promise<void>

  /** 数値 seq < beforeSeq だけを requests から取り除く。未実装でも correctness は不変 */
  pruneRequests?(beforeSeq: number): Promise<void>

  subscribeRequests(
    options: { after?: string },  // NOTE: core は v2 (seq 順序) では使わない。prune 済み transport 向けに残置 (ADR-0002 Decision 5)
    handlers: {
      onAdded(envelope: RequestEnvelope): void
      onChanged(envelope: RequestEnvelope): void
      onError?(error: unknown): void  // 購読の回復不能な打ち切りの通知 (契約 8, ADR-0012)
    },
  ): Unsubscribe
}

// NOTE: transport インスタンスは connect で指定した 1 グループに束縛される
// (groupId を毎回渡さない)。詳細シグネチャの正は src/core/types.ts
```

### firebase セマンティクスでの机上検証 (adapter 実装可能性の確認)

| interface | firebase RTDB での実装 | 移植元の対応物 |
| --- | --- | --- |
| `connect` / presence | 匿名 auth + `.info/connected` 常駐監視 + `onDisconnect().remove()`。切断後の復帰では同じ id / 初回 `connected` で自動再登録 | `subscribe-connections.ts` / `register-connection.ts` |
| `updateSelf` | 自 presence ref への `update()`。session に更新値を保持し、切断復帰時も同じ role で再登録 | `toggleGuestConnection` 相当 |
| `heartbeat` | 自 presence ref へ `update({ lastSeenAt: serverTimestamp() })`。再登録時も serverTimestamp で焼き直す | なし (ADR-0016 で新設) |
| `demotePeer` | 対象 presence ref の存在確認後に `update({ role: 'guest' })` (update は消えた path を再生成するため。競合で生まれる {role} だけの孤児は guest role のため host 候補にならず不活性) | なし (ADR-0016 で新設) |
| `serverNow` | `.info/serverTimeOffset` 補正 | `currentServerTimestamp()` |
| `pushRequest` | `push()` (push id = 挿入順辞書順単調・端末時計依存) | `create-request.ts` |
| `respondRequest` | `update()` (ack で resolve — local echo が先に発火する点が既知の問題①の再現条件) | `response-to-request.ts` |
| `pruneRequests` | `orderByChild('seq').endBefore(beforeSeq)` で取得し、seq なしをコード側で除外。既定は requests から物理削除、`archivePrunedRequests` 有効時は root-level multi-path `update()` で `logs/` へ原子的に退避 | なし |
| `subscribeRequests` | `onChildAdded` / `onChildChanged` + `orderByKey().startAfter(after)` | `subscribe-requests.ts` / `game-requests-query.ts` |
| `saveSnapshot` | `set(ref, payload)` (payload は文字列なので undefined 落ち・空配列消失が起きない) | `update-game-state.ts` |

移植元で `subscribe-requests.ts` (firebase 層) に置かれていた at-least-once 対応 (added 重複破棄・裁定済み added の changed 振り分け) は、**core の受信ルーティングへ移した** (どの transport でも起きうる普遍的な問題のため)。prev チェーン由来の対応 (prevKey 補完等) は seq 化 (ADR-0002) で不要になり消滅

## A3: 封筒 wire format

```ts
export const SYNQUX_SCHEMA_VERSION = 3  // v2 = host 採番 seq (ADR-0002)、v3 = result 構造化 + responsed (ADR-0008)

/**
 * transport を流れる request 封筒
 * payload / result を core が JSON 文字列化してから push する —
 * 「RTDB が undefined を落とす・空配列を消す」形状保存問題を core で一度だけ解く
 * (移植元 create-request.ts の payload stringify 踏襲、Decision 11 と同じ原理)
 */
export type RequestEnvelope = {
  v: number                 // SYNQUX_SCHEMA_VERSION。不一致は「検出して明示的に拒否」(Decision 10)
  id: string                // transport 採番 (group 内で一意・不変。順序は seq が担う)
  groupId: string
  action: {
    type: string
    payload?: string        // JSON 文字列。core が push 時に直列化 / 受信時に parse
    meta?: SynquxActionMeta // root は含まない (generateResult で除去、移植元踏襲)
  }
  requested: number         // serverNow() 基準
  requestedBy: Peer['id']
  responsedBy?: Peer['id']  // host の裁定済みマーク。これの有無が added/changed の実質の区別
  responsed?: number        // serverNow() 基準の裁定時刻 (ADR-0008)。調査用で correctness には使わない
  epoch?: number            // host 世代番号 (fencing、ADR-0002)。同一 seq 衝突の tiebreak
  seq?: number              // host 採番の適用順連番 (response 時に焼き込み)。順序の正
  result?: string           // Result の JSON 文字列
}

/** snapshot 封筒 (core が構築・直列化し、transport には不透明文字列で渡る) */
type SnapshotEnvelope<TSynced> = {
  v: number                     // SYNQUX_SCHEMA_VERSION
  synced: TSynced
  ordering: {
    epoch: number
    appliedSeq: number
    applied: { [seq: number]: string }  // 直近 200 件の seq → request id 窓 (ADR-0002 Decision 4)
  }
}
```

- canonical JSON 化: key を辞書順 sort した決定的 stringify + undefined プロパティ除去。どの transport でも snapshot が同一バイト列になり、export 解析手順 (SPEC の Trouble Shooting) が infra 非依存になる
- 永続化 policy は「受理 request ごと」(移植元踏襲)。core 内の 1 箇所に隔離し将来の throttle に備える (Decision 11)

## subpath exports 一覧

| subpath | 主な export | 対象 |
| --- | --- | --- |
| `synqux` | `createSynqux` / `createSynquxRootReducer` / `synquxReducer` / `synquxRestored` / reducer helpers / `createSyncedActionMatchers` / `isSynquxAction` / `isResultForPeer` / peer・phase・health selectors / `localStorageSnapshotStore` / 契約型 | セットアップ層 + reducer ヘルパー |
| `synqux/react` | `SynquxProvider` / `useSynquxSubscription` / peer・phase・health hooks / `useLatestResult` / `useMyLatestResult` | ゲーム開発者層 |
| `synqux/testing` | `createMemoryHub` / `verifyActionIdempotency` / `assertActionIdempotency` | consumer CI / 本 repo の simulation test |
| `synqux/firebase` | `firebaseTransport(db, options?: { archivePrunedRequests?: boolean })` | Phase 2 で実装 |

隠蔽の確認 (Decision 7): ゲーム開発者層 (`synqux/react` + reducer ヘルパー + selector) に request / prev / revisions の語彙は一切出ない。`RequestEnvelope` / `SynquxTransport` は adapter 実装者 (= 我々) 向けで、セットアップ層のドキュメントに隔離する。

## 移植元から意図的に落とすもの・consumer に残すもの

| 項目 | 扱い |
| --- | --- |
| `LAST_RESET` (ゲームデータリセット → 全端末 alert + reload) | v1 core に**含めない**。UI 都合 (alert / reload) と密結合のため。テンプレ置換 (Phase 2) で必要性が確定したら transport のオプションイベントとして追加検討 |
| `reproduce` (requests JSON replay 復旧ツール) | Phase 1 スコープ外 (合意済み) |
| `connections.isNotFoundGame` / `getAgentIdFromQuery` | consumer 責務 (エラー画面遷移・query 読み取りはアプリ都合) |
| result の toast 表示 (`result-notifier`) | consumer 責務。`useLatestResult` + `Result.message` (拡張は TMessage generics) で材料は提供 (ADR-0008) |
| `loadGameState` / `saveGameState` (standalone の localStorage 永続化) | **取り込む** (レビュー決定)。`localSnapshots?: SnapshotStore | false` として一般化し、封筒・直列化・policy 点を transport の snapshot と共有する。browser の省略時は `localStorageSnapshotStore()`、`false` で無効化する。restore 時の result 除去 (移植元 `clearResultFromGameState`) も踏襲 |
| `@yano3nora/ts-utils` (`sleepTimer` / `waitUntilOrFail`) | **dependencies に含める** (レビュー決定: 作者が同一のため内製化は二重管理になる)。public npm + ライセンス整合が publish (Phase 2) の前提条件 |
| `debugRevisions` (console.log デバッグ action) | 落とす。simulation test で代替 |

## 確定にあたっての判断メモ (2026-07-05 レビュー反映済み)

1. **selector を静的関数にできた**: `state.synqux` が予約 key のため instance なしで `selectIsHost` 等を提供できる。ゲーム開発者が instance に触れない Decision 7 の層分けがそのまま成立する
2. **`selectLatestResult` は廃止** (レビュー決定): result は consumer 自身の synced state の所有物で直読みできるため、setup 層 re-export の迂回ごと削除。react の `useLatestResult` のみ提供
3. **createSynquxRootReducer の返り値を config へ spread する形**で、ADR が山場と呼んだ「rootReducer × selectSynced × isSyncedAction × consumer State 型」の接続点を 1 箇所に畳んだ。primitive 方式は `synquxReducer` + `synquxRestored` の match + `stateWithDefaultResult` + 手書き rootReducer + 手動 `selectSynced` で成立する (契約の正式化は 2026-07-20、result stamp の追加は ADR-0013。上記「primitive 方式の正式契約」と公開 surface 回帰テスト `src/index.test.ts` を参照)
4. **synced slice は 1 つに限定 — 仕様として確定 (2026-07-18)**。当初は「v1 暫定・複数対応は必要になってから」だったが、host の成否判定 (result の読み取り位置) と snapshot の単位が単一 subtree に固定されることが同期機構の単純さの源泉であり、複数エントリ対応は判定・復元の分割という複雑さだけを持ち込むため採らない。複数ドメインは consumer が合成 reducer で 1 slice に畳み、直近に実行した対象 reducer の result を top-level へ写す (実例: demo/main.ts の demoReducer)
5. **`agent` / `guest` → `role: 'player' | 'dedicated' | 'observer'` へ改名** (レビュー決定): 排他 enum にすることで「agent かつ guest」という不正状態を型で排除。dedicated は「常駐プロセスを強制 host にして安定進行・無人進行を担う」ユースケース由来 (dedicated server 文化)。process id は `label` へ分離
   - その後 `observer` → `guest` へ再改名した (TASK-260811 / ADR-0014)。observer は readonly を暗示する一方、role の実際の作用は host 適格性だけであり、request 発行を制限しないため
6. **`canRequest` hook を追加** (移植元の readonly 端末対応の一般化)。これがないとテンプレ置換 (Phase 2) が成立しないため
7. **standalone の local 永続化を責務に含める** (レビュー決定): `localSnapshots?: SnapshotStore | false` として snapshot 機構と統合。browser では既定で localStorage へ保存し、`false` で無効化する。保存は「適用 synced action ごと」で host の snapshot 永続化と同じ policy 点を通る。runtime の `setEnabled(false)` では保存しない (移植元の tutorial 除外の一般化)
