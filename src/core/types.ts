import type { Action } from '@reduxjs/toolkit'

/**
 * 永続化する封筒 (request / snapshot) の形式バージョン
 *
 * 将来の wire format 変更時に新旧混在を「検出して明示的に拒否」するためのフィールド
 * (ADR-0001 Decision 10)。互換性のない変更を入れるときは必ず increment すること
 */
export const SYNQUX_SCHEMA_VERSION = 3

export type Unsubscribe = () => void

/**
 * 端末の役割 (排他)。省略時 'player' として扱う
 *
 * - player: 通常端末。dedicated 不在時、最新接続の player が host になる
 * - dedicated: ゲームに常駐するプロセス (lambda 等) を強制的に host にし、
 *   安定進行・無人進行を担う (移植元の agent 相当)
 * - guest: host 選定から除外される参加者 (移植元の guest)。request 発行は
 *   制限しない — readonly が必要なら consumer が UI 層で dispatch を抑止する
 */
export type PeerRole = 'player' | 'dedicated' | 'guest'

/** 同期グループ内の接続端末。consumer へは読み取り専用で公開する */
export type Peer = {
  id: string
  groupId: string

  /**
   * 接続時刻。host 導出 (最新接続の dedicated、いなければ最新接続の player) の
   * 全端末合意に使うため、端末時計ではなく transport のサーバ基準時刻であること
   */
  connected: number

  role?: PeerRole

  /** 端末の識別ラベル (dedicated の process id 等)。host 導出には使わない */
  label?: string

  /**
   * host 生存確認の最終 heartbeat 時刻 (サーバ基準時刻)。host の間だけ
   * 定期更新される。未記録 (一度も host になっていない) の stale 判定は
   * connected を起点にする (TASK-260812 / ADR-0016)
   */
  lastSeenAt?: number
}

/**
 * Result.message の型契約 (ADR-0008)
 *
 * text 以外のフィールド (表示時間・severity 等) は consumer が generics で拡張する。
 * JSON 直列化して封筒で運ぶため、値は JSON-serializable であること
 */
export type ResultMessage = { text: string }

/**
 * reducer (唯一の判定器) が書き、host が読む成否判定結果
 *
 * consumer の synced reducer は validation 失敗時に state を変えず result へ
 * error を積む。host は rootReducer を試し実行してこの type で受理・拒否を判定する
 *
 * 拒否された request は state に痕跡を残せない (reducer は error 時 state 不変)
 * ため、result が失敗 feedback を UI へ届ける唯一のチャネルになる (ADR-0008)。
 * 通知チャネルは 2 系統: message (UI 表示、表示自体は consumer 責務) と
 * log (console 出力、synqux が出力する)
 */
export type Result<
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
> = {
  /** 対応する action。meta.hash で「既に通知した result か」を判定できる */
  action: TAction

  type: 'error' | 'success'

  /**
   * UI 表示想定データ。undefined なら画面通知なし。
   * error かつ message なしの result は「log 専用の拒否」として action の
   * dispatch 自体が省略される (連打・遅延で弾かれた操作のノイズ抑制)
   */
  message?: TMessage

  /** 通知先 peer id。standalone 時は [] で無条件表示 */
  targets: Peer['id'][]

  /**
   * console 出力メッセージ。synqux が type に応じて console.log / console.error
   * へ出力する (targets 準拠)。デバッグ・運用ログ用途で UI には出さない
   */
  log?: string
}

/**
 * consumer の synced state への型契約 (ADR-0001 Decision 7)
 *
 * 移植元 GameState と異なり revisions は含まない — 処理済み順序は synqux が
 * snapshot 封筒側 (SnapshotEnvelope.ordering) で管理する (Decision 11)
 */
export type SynquxSynced<
  TAction extends Action = Action,
  TMessage extends ResultMessage = ResultMessage,
> = {
  result: Result<TAction, TMessage> | null
}

/**
 * synqux が action に載せる meta の契約
 *
 * synced reducer が読んでよいのは requestedBy / dispatched のみ (Decision 8)。
 * root は locals reducer 専用で、synced reducer には渡らない — host の試し実行と
 * 各端末での適用が同一結果になる (決定性) ことを構成上保証するため
 */
export type SynquxActionMeta = {
  /** request 経路を通った action に付与。request 化済み action の素通し判定を兼ねる */
  requestedBy?: Peer['id']

  /** transport サーバ基準の登録時刻 */
  dispatched?: number

  /** 端末内での action 一意性 (適用完了の検知・result 通知の重複判定に使う) */
  hash?: string

  /** 直前 reducer 通過後の root state (createSynquxRootReducer が locals にのみ付与) */
  root?: unknown
}

/**
 * transport を流れる request 封筒
 *
 * payload / result は core が JSON 文字列化してから push する — 「ストレージが
 * undefined を落とす・空配列を消す」形状保存問題を core で一度だけ解くため
 * (Decision 11 と同じ原理。移植元 create-request.ts の payload stringify 踏襲)
 */
export type RequestEnvelope = {
  /** SYNQUX_SCHEMA_VERSION。不一致は検出して明示的に拒否する */
  v: number

  /** transport 採番。group 内で一意・不変であること (順序は seq が担う、transport 契約 1) */
  id: string

  groupId: string

  action: {
    type: string

    /** JSON 文字列。core が push 時に直列化 / 受信時に parse する */
    payload?: string

    /** root は含まない (直列化前に core が除去する) */
    meta?: SynquxActionMeta
  }

  /** serverNow() 基準の依頼時刻 */
  requested: number

  requestedBy: Peer['id']

  /** host の裁定済みマーク。この有無が「判定待ち / 適用待ち」の実質の区別 */
  responsedBy?: Peer['id']

  /**
   * serverNow() 基準の裁定時刻 (ADR-0008)。requested との差で「依頼から裁定
   * までの遅延」を export だけで調査できる。correctness には使わない
   */
  responsed?: number

  /**
   * host の世代番号 (fencing、ADR-0002)。dual-host 窓で同一 seq が衝突したとき
   * (epoch 降順, responsedBy 辞書順降順) の決定的 tiebreak で勝者を決める
   */
  epoch?: number

  /**
   * host 採番の適用順連番 (response 時に焼き込む、ADR-0002)
   * transport のイベント順序も request id (端末時計) も信頼せず、全端末が
   * 「appliedSeq + 1 の seq を適用する」規則で適用順を線形化する
   */
  seq?: number

  /** Result の JSON 文字列 (core が直列化) */
  result?: string
}

/**
 * core が構築・直列化する snapshot 封筒 (Decision 11)
 *
 * transport / SnapshotStore には canonical JSON 文字列として渡るため、
 * この型が現れるのは core 内部と export 解析 (Trouble Shooting) のみ
 */
export type SnapshotEnvelope<TSynced> = {
  /** SYNQUX_SCHEMA_VERSION。不一致は検出して明示的に拒否する */
  v: number

  synced: TSynced

  /**
   * 順序判定モジュールの永続状態 (ADR-0002)
   * 適用順の ground truth は封筒に焼かれた seq 自体が担うため、ここは
   * カウンタ + 直近適用窓のみ (v1 の revisions 配列の無限成長を解消)
   */
  ordering: {
    epoch: number
    appliedSeq: number
    /** 直近 N 件の { seq: requestId }。restore 後の正史/敗者の判別に使う */
    applied: Record<number, RequestEnvelope['id']>
  }
}

/**
 * 不透明文字列の snapshot KV (Decision 11)
 *
 * 封筒構築と canonical JSON 直列化は core の責務で、store 実装は payload を
 * parse せず fence と並べて保存する。transport の snapshot API と standalone
 * mode の localSnapshots が本契約を共有する
 */
export type SnapshotFence = { epoch: number; appliedSeq: number }

export type SnapshotStore = {
  /**
   * payload を不透明なまま fence と共に保存する条件付き書き込み。
   * 比較と保存は CAS / transaction で原子的に行い、保存済み fence より
   * 辞書順で低い書き込みは正常系として棄却し false を返す。同値は受理する。
   * fence を別引数にするのは adapter に payload を parse させないため。
   */
  saveSnapshot(
    key: string,
    payload: string,
    fence: SnapshotFence,
  ): Promise<boolean> | boolean
  loadSnapshot(key: string): Promise<string | null> | string | null
}

/**
 * 同期インフラの抽象 (ADR-0001 Decision 2 / 11)
 *
 * 【adapter 実装者への契約】
 * 1. pushRequest の id 採番は「group 内で一意かつ不変」であること。順序性は要求
 *    しない — 適用順は host 採番の seq だけが担う (ADR-0002)。firebase push id の
 *    ような挿入順辞書順単調 id は要件を満たす一例 (after オプション対応の前提)
 * 2. respondRequest は永続化 ack で resolve すること (楽観 resolve 禁止)。
 *    なお変更イベント (onChanged) が ack より先に届くこと (local echo) は許容される
 * 3. 配送は at-least-once でよい。重複・遅延・順序入れ替えは core が吸収するので
 *    adapter 側で直列化を頑張らなくてよい (観測したまま素朴に流す)
 * 4. 【retention】最新 snapshot 地点より新しい requests を保持しなければならない。
 *    requests を prune する transport (TTL 等) はこの線より過去のみ削除できる
 * 5. connect した peer の切断時 (プロセス死・ネットワーク断を含む)、全端末で
 *    onRemoved が発火すること (onDisconnect 相当の presence cleanup を保証する)
 * 6. connect / serverNow 以外のメソッドは connect 完了後にのみ呼ばれる。
 *    transport インスタンスは connect で指定された 1 グループに束縛される
 * 7. saveSnapshot は保存済み fence と原子的に比較し、(epoch, appliedSeq) が
 *    辞書順で低い書き込みを false で棄却する。同値は冪等な再書き込みとして受理する
 * 8. 【失敗通知 (ADR-0012)】購読が回復不能に打ち切られたら (permission denied 等)、
 *    当該 handlers の onError を必ず発火すること (optional なのは caller 都合であり、
 *    渡された onError の発火は adapter の義務。core は常に渡す)。発火後、その購読への
 *    配送は保証されない。一時的な切断は adapter / SDK の自動再接続で吸収し、
 *    onError にしないこと。
 *    connect は options.signal の abort で速やかに reject し、登録済み presence を
 *    残さないこと (省略時は接続確立まで無期限に待ってよい)
 * 9. 【updateSelf】自 peer の presence を in-place 更新すること。id / connected は
 *    不変であること。更新は全端末の subscribePeers へ onChanged として配送し、
 *    切断復帰時の presence 再登録 (契約 5 / ADR-0006) は更新後の値で行うこと
 * 10.【heartbeat】自 peer の lastSeenAt をサーバ基準時刻で更新し、onChanged として
 *    全端末へ配送すること。他の presence 属性は変更しない
 * 11.【demotePeer】対象 peer の role を 'guest' へ書き換え、onChanged として全端末へ
 *    配送すること。自 peer 以外へ書き込む唯一のメソッドであり、非敵対クライアント
 *    前提 (ADR-0009) の範囲で stale host の降格 (ADR-0016) にのみ使う。
 *    対象 peer が既に存在しない場合は throw せず no-op で resolve すること
 *    (複数 observer の同時 demote / 切断との競合を冪等に収束させる)
 */
export type SynquxTransport = SnapshotStore & {
  /** presence 登録。selfId は transport が採番する */
  connect(options: {
    groupId: string
    role?: PeerRole
    label?: Peer['label']
    /** 接続確立待ちの中断 (契約 8)。offline 起動の無期限待機を consumer 判断で打ち切る */
    signal?: AbortSignal
  }): Promise<{ selfId: Peer['id'] }>

  /** presence 解除。完了後は同じ transport instance で再 connect できること */
  disconnect(): Promise<void>

  /** 自 peer の presence 属性を in-place 更新する (契約 9) */
  updateSelf(patch: { role?: PeerRole }): Promise<void>

  /** 自 peer の lastSeenAt をサーバ基準時刻で touch する (契約 10、ADR-0016) */
  heartbeat(): Promise<void>

  /** 対象 peer の role を 'guest' へ書き換える (契約 11、ADR-0016) */
  demotePeer(id: Peer['id']): Promise<void>

  /** サーバ基準時刻 (firebase: .info/serverTimeOffset 補正相当) */
  serverNow(): Promise<number>

  /**
   * 接続端末プールの購読。購読開始時に既存 peer ぶんの onAdded が発火すること
   */
  subscribePeers(handlers: {
    onAdded(peer: Peer): void
    onChanged(peer: Peer): void
    onRemoved(peer: Peer): void
    /** 購読の回復不能な打ち切り (permission denied 等) の通知 (契約 8) */
    onError?(error: unknown): void
  }): Unsubscribe

  /** request の追記 push。封筒の直列化 (payload / result) は core 側で済んでいる */
  pushRequest(
    envelope: Omit<RequestEnvelope, 'id'>,
  ): Promise<{ id: RequestEnvelope['id'] }>

  /** host の裁定を request へ焼き込む。(epoch, seq) が適用順の正になる (ADR-0002) */
  respondRequest(
    id: RequestEnvelope['id'],
    patch: {
      epoch: number
      seq: number
      responsedBy: Peer['id']
      /** serverNow() 基準の裁定時刻 (ADR-0008)。そのまま封筒へ焼く */
      responsed: number
      result: RequestEnvelope['result'] | null
    },
  ): Promise<void>

  /**
   * 適用窓より古い requests の削除 (retention、ADR-0005)。optional —
   * 未実装の transport では prune されないだけで correctness に影響しない。
   * 契約: 「数値 seq を持ち seq < beforeSeq の envelope」だけを削除する。
   * seq なし (未裁定) は削除しない。削除イベントの配送は不要
   */
  pruneRequests?(beforeSeq: number): Promise<void>

  /**
   * requests の変更購読
   *
   * - after 指定時は「id が after より後の requests」のみを対象とする
   *   (orderByKey().startAfter 相当)。挿入順で辞書順単調な id を持つ transport
   *   (firebase push id 相当) でのみ意味を持つ。NOTE: core は v2 (seq 順序) では
   *   使わない — id 順は端末時計依存で「id は古いが seq は新しい」request を
   *   取り逃がすため、全量購読して seq で破棄する (ADR-0002 Decision 5)。
   *   オプション自体は将来の prune 済み transport 向けに残す
   * - 購読開始時、対象の既存 requests は onAdded で一括配送されること。配送順は
   *   問わない — core が seq で線形化し、responsedBy 付きで added に届くケースの
   *   振り分けも core が行う
   */
  subscribeRequests(
    options: { after?: RequestEnvelope['id'] },
    handlers: {
      onAdded(envelope: RequestEnvelope): void
      onChanged(envelope: RequestEnvelope): void
      /** 購読の回復不能な打ち切り (permission denied 等) の通知 (契約 8) */
      onError?(error: unknown): void
    },
  ): Unsubscribe
}
