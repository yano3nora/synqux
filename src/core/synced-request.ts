import {
  type Action,
  type ActionCreatorWithPreparedPayload,
  type ActionReducerMapBuilder,
  current,
  type Draft,
  isDraft,
} from '@reduxjs/toolkit'
import type {
  CreateSyncedAction,
  PayloadArgs,
  SyncedAction,
  SyncedActionHash,
  SyncedActionMeta,
  SyncedCaseHandlers,
  SyncedValidate,
} from './action.js'
import type { SynquxAutomation, SynquxListener } from './create-synqux.js'
import type { SynquxSynced } from './types.js'

/** 台帳の 1 件。requested の適用で書き、resolved / aborted の適用で消す */
export type InflightRequest<P = unknown> = {
  /** requested の hash。resolved / aborted の照合に使う */
  id: SyncedActionHash
  /** requested の dispatched (サーバ基準 ms)。timeout の起点 */
  requestedAt: number
  /** 依頼した端末の peer id。standalone では null */
  requestedBy: string | null
  payload: P
}

/** request の key ごとに処理中の 1 件か null。履歴は持たない */
export type InflightState = Record<string, InflightRequest | null>

/** createSyncedRequest を使う synced state の型契約。`inflight: {}` で初期化する */
export type WithInflight = SynquxSynced<any, any> & { inflight: InflightState }

export type SyncedRequestResolved<O> = { id: SyncedActionHash; output: O }

export type SyncedRequestAborted = {
  id: SyncedActionHash
  reason: 'timeout' | 'failed'
  /** failed の原因 (perform が throw した値の message) */
  detail?: string
}

export type SyncedRequestDefinition<TSynced extends WithInflight, P, O> = {
  /** 台帳の key と action type の接頭辞。1 instance 内で一意であること */
  key: string
  request?: {
    /** 利用側の拒否条件。処理中の拒否は primitive が先に行う */
    validate?: SyncedValidate<TSynced, P>
    /** 台帳に書いた後に呼ぶ */
    mutate?: (state: Draft<TSynced>, action: SyncedAction<P>) => void
  }
  resolve: {
    /** 台帳を消す前に呼ぶ。inflight は requested 時の payload を持つ */
    mutate: (
      state: Draft<TSynced>,
      action: SyncedAction<SyncedRequestResolved<O>>,
      inflight: InflightRequest<P>,
    ) => void
  }
  abort?: {
    /** 台帳を消す前に呼ぶ */
    mutate?: (
      state: Draft<TSynced>,
      action: SyncedAction<SyncedRequestAborted>,
      inflight: InflightRequest<P>,
    ) => void
  }
  /** requestedAt からこの時間を過ぎたら host が aborted (timeout) を出す */
  timeoutMs: number
  /** host だけが実行する外部 I/O。throw すると aborted (failed) になる */
  perform: (payload: P, ctx: { synced: TSynced }) => Promise<O>
}

type SyncedRequestCreator<TSynced, P> = ActionCreatorWithPreparedPayload<
  PayloadArgs<P>,
  P,
  string,
  never,
  SyncedActionMeta<any>
> &
  SyncedCaseHandlers<TSynced, P>

/** engine が timeout と perform を配線するための内部口。index からは export しない */
export const SYNCED_REQUEST_RULES = Symbol('synqux.syncedRequestRules')

export type SyncedRequestRules<TSynced> = {
  automation: SynquxAutomation<TSynced, Action>
  /**
   * getDispatch は perform の開始時に 1 回だけ呼ぶ。戻りの dispatch は
   * 開始時の session にだけ流し、session が変われば捨てる
   */
  listener: (
    getDispatch: () => ((action: Action) => void) | null,
  ) => SynquxListener<TSynced, Action>
}

export type SyncedRequest<TSynced = any, P = any, O = any> = {
  key: string
  requested: SyncedRequestCreator<TSynced, P>
  resolved: SyncedRequestCreator<TSynced, SyncedRequestResolved<O>>
  aborted: SyncedRequestCreator<TSynced, SyncedRequestAborted>
  /** 3 action の addCase。synced slice の extraReducers に渡す */
  reducer: (builder: ActionReducerMapBuilder<TSynced>) => void
  [SYNCED_REQUEST_RULES]: SyncedRequestRules<TSynced>
}

/** synced state が inflight を持たないときに引数の型として出る */
type InflightStateRequired = {
  'synced state must have `inflight: InflightState`': never
}

/**
 * host が外部 I/O をして結果を synced action にする request (ADR-0032)。
 * 定義の createSyncedAction で 3 action を生成し、`createSynqux({ requests })` で
 * engine に timeout と perform を配線させる
 */
export type CreateSyncedRequest<TSynced> = <P, O>(
  definition: TSynced extends WithInflight
    ? SyncedRequestDefinition<TSynced, P, O>
    : InflightStateRequired,
) => SyncedRequest<TSynced, P, O>

const inflightOf = <P>(
  state: unknown,
  key: string,
): InflightRequest<P> | null =>
  ((state as WithInflight).inflight[key] ?? null) as InflightRequest<P> | null

/** 定義の createSyncedAction (registry 登録つき) を受けて request を組む */
export const buildSyncedRequest = <TSynced extends WithInflight, P, O>(
  createSyncedAction: CreateSyncedAction<any, TSynced>,
  definition: SyncedRequestDefinition<TSynced, P, O>,
): SyncedRequest<TSynced, P, O> => {
  const { key, timeoutMs } = definition

  const validateInflight = (state: TSynced, id: SyncedActionHash) => {
    const inflight = inflightOf(state, key)

    return !inflight
      ? `${key}: no inflight request`
      : inflight.id !== id
        ? `${key}: id mismatch (${inflight.id} != ${id})`
        : null
  }

  /** mutate へは draft の proxy ではなく値で渡す (台帳を消した後も読める) */
  const snapshotInflight = (state: Draft<TSynced>): InflightRequest<P> => {
    const inflight = inflightOf<P>(state, key)!

    return isDraft(inflight)
      ? (current(inflight as object) as InflightRequest<P>)
      : inflight
  }

  const requested = createSyncedAction<P>(`${key}/requested`, {
    validate: (state, payload, meta) =>
      inflightOf(state, key)
        ? `${key}: in flight`
        : (definition.request?.validate?.(state, payload, meta) ?? null),
    mutate: (state, action) => {
      ;(state as WithInflight).inflight[key] = {
        id: action.meta.hash,
        requestedAt: action.meta.dispatched,
        requestedBy: action.meta.requestedBy ?? null,
        payload: action.payload,
      }
      definition.request?.mutate?.(state, action)
    },
  })

  const resolved = createSyncedAction<SyncedRequestResolved<O>>(
    `${key}/resolved`,
    {
      validate: (state, payload) => validateInflight(state, payload.id),
      mutate: (state, action) => {
        definition.resolve.mutate(state, action, snapshotInflight(state))
        ;(state as WithInflight).inflight[key] = null
      },
    },
  )

  const aborted = createSyncedAction<SyncedRequestAborted>(`${key}/aborted`, {
    validate: (state, payload) => validateInflight(state, payload.id),
    mutate: (state, action) => {
      definition.abort?.mutate?.(state, action, snapshotInflight(state))
      ;(state as WithInflight).inflight[key] = null
    },
  })

  // timeout は誰が host でも同じ判定式なので、host 交代をまたいでも壊れない。
  // 新しい host は perform を引き継がず、時間切れを待って aborted を出す
  const automation: SynquxAutomation<TSynced, Action> = {
    id: `synqux/request/${key}/timeout`,
    when: (synced, { now }) => {
      const inflight = inflightOf(synced, key)

      return inflight !== null && now >= inflight.requestedAt + timeoutMs
    },
    action: (synced) =>
      aborted({ id: inflightOf(synced, key)!.id, reason: 'timeout' }),
  }

  // restore replay では発火しないので、snapshot から復元した台帳は timeout に任せる。
  // dual-host 窓の二重発火と timeout 後に届いた結果は、resolved の id 検査が落とす
  const listener: SyncedRequestRules<TSynced>['listener'] = (getDispatch) => ({
    id: `synqux/request/${key}/perform`,
    mode: 'host-only',
    match: (action) => requested.match(action),
    effect: async (action, { synced }) => {
      const inflight = inflightOf<P>(synced, key)
      if (
        !requested.match(action) ||
        !inflight ||
        inflight.id !== action.meta.hash
      ) {
        return
      }

      const dispatch = getDispatch()
      if (!dispatch) {
        return
      }

      let output: O
      try {
        output = await definition.perform(action.payload, { synced })
      } catch (error) {
        console.error(`[synqux] SyncedRequest "${key}" perform failed`, error)
        dispatch(
          aborted({
            id: inflight.id,
            reason: 'failed',
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
        return
      }
      dispatch(resolved({ id: inflight.id, output }))
    },
  })

  return {
    key,
    requested,
    resolved,
    aborted,
    reducer: (builder) => {
      builder.addCase(requested, requested.reducer)
      builder.addCase(resolved, resolved.reducer)
      builder.addCase(aborted, aborted.reducer)
    },
    [SYNCED_REQUEST_RULES]: { automation, listener },
  }
}
