import {
  createAction,
  createSlice,
  type PayloadAction,
  type UnknownAction,
} from '@reduxjs/toolkit'
import type {
  Peer,
  RequestEnvelope,
  Result,
  SynquxActionMeta,
} from './types.js'

/**
 * 受信済み・適用未完了 request の内部表現
 * transport の RequestEnvelope から payload / result を parse 済みの形
 * (parse は core の受信ルーティングで一度だけ行う)
 */
export type PendingRequest = {
  id: RequestEnvelope['id']
  requested: number
  requestedBy: Peer['id']
  responsedBy?: Peer['id']
  /** serverNow() 基準の裁定時刻 (ADR-0008)。responsedBy とセットで付く */
  responsed?: number
  /** host の裁定印 (ADR-0002)。responsedBy とセットで付く */
  epoch?: number
  seq?: number
  action: {
    type: string
    payload?: unknown
    meta?: SynquxActionMeta
  }
  result?: Result
}

export type SynquxHealth = {
  /** stalled → recovering を 1 巡し、失敗時だけ unrecoverable になる */
  phase: 'ok' | 'stalled' | 'recovering' | 'unrecoverable'
  /** ok 以外の phase で数値が入る診断値 */
  expectedSeq: number | null
  maxSeenSeq: number | null
  /** gap 開始の端末ローカル時刻 (Date.now) */
  gapSince: number | null
}

/**
 * 予約 key `state.synqux` 配下の内部 state (ADR-0001 Decision 7)
 *
 * consumer は直接読み書きしない。読み取りは selector (selectIsHost 等) 経由のみ
 * サポートする。prev チェーン / revisions は redux state にすら置かず、
 * インスタンス内部の順序判定モジュール (ordering.ts) が持つ
 */
export type SynquxState = {
  /**
   * false 時 middleware 動作を抑止し standalone 完結させる
   * 初期値 true は「subscribe() までの間、request 送信条件 (selfId あり) が
   * 揃わず素通しになる」移植元と同じ挙動に倒すための値。instance 設定
   * (enabled: false) は subscribe() 時の sessionStarted で反映される
   */
  enabled: boolean

  health: SynquxHealth

  connections: {
    selfId: Peer['id'] | null
    entities: Record<Peer['id'], Peer>
  }

  requests: {
    /** 適用完了 (同 hash の synced action 通過) で破棄する */
    entities: Record<PendingRequest['id'], PendingRequest>
  }
}

export const synquxInitialState: SynquxState = {
  enabled: true,
  health: {
    phase: 'ok',
    expectedSeq: null,
    maxSeenSeq: null,
    gapSince: null,
  },
  connections: {
    selfId: null,
    entities: {},
  },
  requests: {
    entities: {},
  },
}

/**
 * request 経路を通った action の判定
 * requestedBy は request 化時に core が必ず付与するため、これの有無が
 * 「host 裁定済みで全端末へ配られた action」のマーカーになる
 */
const isRequestedAction = (
  action: UnknownAction,
): action is UnknownAction & { meta: SynquxActionMeta } => {
  if (!('meta' in action) || typeof action.meta !== 'object' || !action.meta) {
    return false
  }

  const meta = action.meta as SynquxActionMeta
  return typeof meta.requestedBy === 'string' && typeof meta.hash === 'string'
}

const synquxSlice = createSlice({
  name: 'synqux',
  initialState: synquxInitialState,
  reducers: {
    /** subscribe() 完了時に instance 設定と自端末 id を state へ反映する */
    sessionStarted: (
      state,
      action: PayloadAction<{ selfId: Peer['id'] | null; enabled: boolean }>,
    ) => {
      state.enabled = action.payload.enabled
      state.connections.selfId = action.payload.selfId
    },

    /** unsubscribe 時に全内部 state を破棄する (移植元 disconnectConnections 相当) */
    sessionEnded: () => synquxInitialState,

    /** tutorial 等で runtime に同期を on/off する (移植元 _prepareTutorial 相当) */
    setEnabled: (state, action: PayloadAction<boolean>) => {
      state.enabled = action.payload
    },

    healthChanged: (state, action: PayloadAction<SynquxHealth>) => {
      state.health = action.payload
    },

    peerUpserted: (state, action: PayloadAction<Peer>) => {
      state.connections.entities[action.payload.id] = action.payload
    },

    peerRemoved: (state, action: PayloadAction<Peer['id']>) => {
      delete state.connections.entities[action.payload]
    },

    /** 判定待ち request の受信 (requestListener がこれを匹配して host 処理を fork する) */
    requestAdded: (
      state,
      action: PayloadAction<{ request: PendingRequest }>,
    ) => {
      const { request } = action.payload
      state.requests.entities[request.id] = request
    },

    /**
     * host 裁定済み request の受信 (responseListener がこれを匹配して適用を fork する)
     * 再裁定 (dual-host 敗者への新しい seq、ADR-0002) も同じ経路で entity を
     * 上書きする — fork は entity を毎 loop 読み直して最新の裁定印に追従する
     */
    requestChanged: (
      state,
      action: PayloadAction<{ request: PendingRequest }>,
    ) => {
      const { request } = action.payload
      state.requests.entities[request.id] = request
    },
  },
  extraReducers: (builder) => {
    /**
     * 適用が完了した request を entities から破棄する
     * responseListener は「entities から消えたこと」を適用完了の合図として
     * 待機するため (移植元 middlewares.ts の waitUntilOrFail)、この破棄は
     * 順序保証の進行条件でもある
     */
    builder.addMatcher(isRequestedAction, (state, action) => {
      const applied = Object.values(state.requests.entities).find(
        (pending) => pending.action.meta?.hash === action.meta.hash,
      )

      if (applied) {
        delete state.requests.entities[applied.id]
      }
    })
  },
})

/**
 * snapshot restore の合図。synced state の全量差し替えは synqux 内部 slice では
 * 行えない (consumer の state のため) ので、createSynquxRootReducer がこれを
 * 匹配して synced subtree を置き換える。primitive 方式の consumer は自前の
 * rootReducer でこの action を処理すること (SPEC-0002「primitive 方式の正式契約」)
 *
 * 【危険・禁止】consumer が自分で dispatch しないこと。request 経路を通らない
 * state 差し替えは自端末にしか起きず、他端末と静かに desync する。dispatch する
 * 主体は core のみで、consumer が触れてよいのは match までとする
 */
export const synquxRestored = createAction<{ synced: unknown }>(
  'synqux/restored',
)

export const synquxActions = synquxSlice.actions

/**
 * `state.synqux` に mount する内部 slice reducer
 * createSynquxRootReducer 利用時は自動で組み込まれる。primitive 方式の
 * consumer はこれを自前の rootReducer で予約 key `synqux` に配置する
 */
export const synquxReducer = synquxSlice.reducer
