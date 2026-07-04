import {
  createListenerMiddleware,
  isAction,
  type Action,
  type Dispatch,
  type Middleware,
  type Reducer,
  type UnknownAction,
} from '@reduxjs/toolkit'
import { sleepTimer, waitUntilOrFail } from '@yano3nora/ts-utils'
import { createOrdering } from './ordering.js'
import { selectIsHost } from './selectors.js'
import {
  buildSnapshotPayload,
  canonicalStringify,
  parseSnapshotPayload,
} from './snapshot.js'
import {
  synquxActions,
  synquxReducer,
  synquxRestored,
  type PendingRequest,
  type SynquxState,
} from './slice.js'
import {
  SYNQUX_SCHEMA_VERSION,
  type Peer,
  type RequestEnvelope,
  type Result,
  type SnapshotStore,
  type SynquxActionMeta,
  type SynquxSynced,
  type SynquxTransport,
  type Unsubscribe,
} from './types.js'

// 同期レート、小さくすれば高負荷・高速となる (移植元踏襲)
const REQUEST_LOOP_MS = 100
// host 機昇格はそこまで素早く見なくていい (移植元踏襲)
const HOST_PROMOTION_LOOP_MS = 1000

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

  /**
   * false で standalone (同期なし・host 常時 true) として動作する
   * runtime の on/off (tutorial 等) は actions.setEnabled で行う
   */
  enabled?: boolean

  /** readonly 端末などで request 送信自体を抑止する hook。既定は常に許可 */
  canRequest?: (root: TRoot) => boolean

  /** standalone 時の synced state 永続化先。省略時は永続化しない */
  localSnapshots?: SnapshotStore

  /**
   * 決定性検出網 (ADR-0001 Decision 8): host の試し実行結果と実適用後の synced を
   * 比較し、純粋性契約でも防げない非決定 reducer (Date.now / Math.random 等) を
   * dev モードで検出する。既定は NODE_ENV !== 'production'
   */
  devDeterminismCheck?: boolean
}

export type SynquxSubscribeOptions<TRoot> = {
  store: {
    dispatch: Dispatch
    getState: () => TRoot
  }
  groupId: string
  role?: Peer['role']
  label?: Peer['label']
}

export type Synqux<TRoot extends { synqux: SynquxState }> = {
  /**
   * store 構築時に prepend する middleware 群
   * `getDefaultMiddleware().prepend(...sync.middlewares)` の形で、
   * 配列順 (meta 付与 → host 判定 fork → 適用 fork → request 化) を崩さないこと
   */
  middlewares: Middleware[]

  /** 予約 key `state.synqux` に mount する内部 slice (primitive 方式用) */
  reducer: Reducer<SynquxState>

  /**
   * store 構築用の rootReducer (config で渡したものの echo)
   * createSynquxRootReducer の spread 方式だと consumer の手元に rootReducer が
   * 残らないため、configureStore への配線材料を instance 1 個に纏める
   */
  rootReducer: Reducer<TRoot>

  /**
   * presence 登録 → snapshot restore → requests 購読を開始する
   * standalone (enabled=false) 時は transport に触れず localSnapshots から
   * restore だけ行う。返り値で購読破棄 + presence 解除
   */
  subscribe: (
    options: SynquxSubscribeOptions<TRoot>,
  ) => Promise<() => Promise<void>>

  actions: {
    /** tutorial 等で runtime に同期を on/off する */
    setEnabled: typeof synquxActions.setEnabled
  }

  /**
   * synqux/react の useLatestResult が synced の位置を解決するための内部 field。
   * ゲーム開発者はこれを直接使わず、result は自分の synced state から
   * `(s) => s.game.result` のように直接読むこと (SPEC-public-api.md)
   */
  selectSynced: (root: TRoot) => SynquxSynced
}

export const createSynqux = <
  TRoot extends { synqux: SynquxState },
  TSynced extends SynquxSynced<TAction>,
  TAction extends Action,
>(
  config: CreateSynquxConfig<TRoot, TSynced, TAction>,
): Synqux<TRoot> => {
  const { transport } = config
  const instanceEnabled = config.enabled ?? true
  const canRequest = config.canRequest ?? (() => true)

  // 処理済みリスト等の同期状態はすべてインスタンス内部に持つ (Decision 3)
  const ordering = createOrdering()

  const devDeterminismCheck =
    config.devDeterminismCheck ??
    (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production')

  /**
   * 決定性検出網: host が試し実行した synced (canonical JSON) を request id で
   * 控えておき、実適用後の synced と比較する。差分 = reducer が非決定
   * (Date.now / Math.random 等を読んでいる) 疑い。自端末が host のときのみ働く
   * best-effort な検出であり、同期の正しさ自体はこの検査に依存しない
   */
  const expectedSyncedByRequest = new Map<RequestEnvelope['id'], string>()

  const verifyDeterminism = (
    id: RequestEnvelope['id'],
    actual: TSynced,
  ): void => {
    const expected = expectedSyncedByRequest.get(id)

    if (expected === undefined) {
      return
    }

    expectedSyncedByRequest.delete(id)

    if (expected !== canonicalStringify(actual)) {
      console.error(
        `[synqux] Determinism check failed for request ${id}: ` +
          'the state applied locally differs from the host trial run. ' +
          'A synced reducer is probably non-deterministic (Date.now / Math.random / external reads).',
      )
    }
  }

  // subscribe 後に確定する購読セッション。二重購読ガードを兼ねる
  let session: { groupId: string } | null = null

  let hashSequence = 0
  const generateHash = (): string =>
    `${Date.now().toString(36)}-${(hashSequence++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`

  /**
   * 「いつ永続化するか」の policy 点 (Decision 11)
   * v1 は移植元踏襲で「受理 request ごと」(host) /「適用 action ごと」(standalone)。
   * throttle 等の変更はこの 2 関数だけを差し替える
   */
  const persistSnapshot = async (
    synced: TSynced,
    revisions: RequestEnvelope['id'][],
  ): Promise<void> => {
    if (!session) {
      return
    }

    await transport.saveSnapshot(
      session.groupId,
      buildSnapshotPayload({ synced, ordering: { revisions } }),
    )
  }

  const persistLocalSnapshot = (root: TRoot): void => {
    if (!session || !config.localSnapshots) {
      return
    }

    // 移植元 saveGameState 踏襲で失敗は握りつぶす (standalone 永続化は best effort)
    void Promise.resolve(
      config.localSnapshots.saveSnapshot(
        session.groupId,
        buildSnapshotPayload({
          synced: config.selectSynced(root),
          ordering: { revisions: ordering.revisions() },
        }),
      ),
    ).catch((e: unknown) => console.error(e))
  }

  // ---------------------------------------------------------------
  // 封筒の直列化・復元 (形状保存問題を core で一度だけ解く)
  // ---------------------------------------------------------------

  const serializeResult = (result: Result): string =>
    JSON.stringify({
      ...result,
      action: {
        ...result.action,
        // 永続化不要 & 重たい root を除去 (undefined は stringify で消える)
        meta: {
          ...((result.action as UnknownAction).meta as SynquxActionMeta),
          root: undefined,
        },
      },
    })

  const parseEnvelope = (envelope: RequestEnvelope): PendingRequest => ({
    id: envelope.id,
    requested: envelope.requested,
    requestedBy: envelope.requestedBy,
    responsedBy: envelope.responsedBy,
    prev: envelope.prev,
    action: {
      type: envelope.action.type,
      payload:
        envelope.action.payload === undefined
          ? undefined
          : JSON.parse(envelope.action.payload),
      meta: envelope.action.meta,
    },
    result:
      envelope.result === undefined
        ? undefined
        : (JSON.parse(envelope.result) as Result),
  })

  // ---------------------------------------------------------------
  // middlewares
  // ---------------------------------------------------------------

  /**
   * synced action へ hash / dispatched を付与する (移植元 actionMetaSetter 相当)
   * hash は「適用完了の検知」(内部 entities 破棄) と「result 通知の重複判定」の鍵
   */
  const metaSetterMiddleware: Middleware = () => (next) => (action) => {
    if (!isAction(action) || !config.isSyncedAction(action)) {
      return next(action)
    }

    const meta = (action as UnknownAction).meta as SynquxActionMeta | undefined

    if (meta?.hash) {
      return next(action)
    }

    return next({
      ...action,
      meta: {
        ...meta,
        hash: generateHash(),
        // 同期時は request 化の時点でサーバ基準時刻に上書きされる
        dispatched: meta?.dispatched ?? Date.now(),
      },
    })
  }

  /**
   * synced action を横取りして request 化する (移植元 actionRequestMiddleware 相当)
   * ローカル適用せず中断する = 楽観更新をしない。画面に出る state は常に
   * 「同期済み state」であり、画面と判定 state の恒常的なズレが構造上起きない
   */
  const actionRequestMiddleware: Middleware =
    (store) => (next) => async (action) => {
      if (!isAction(action)) {
        return next(action)
      }

      const state = store.getState() as TRoot
      const isSynced = config.isSyncedAction(action)
      const meta = (action as UnknownAction).meta as
        | SynquxActionMeta
        | undefined
      const selfId = state.synqux.connections.selfId
      const shouldRequest =
        instanceEnabled && state.synqux.enabled && !!selfId && !!session

      if (shouldRequest && isSynced && !meta?.requestedBy) {
        // readonly 端末などは request 送信自体を行わない (握りつぶす)
        if (!canRequest(state)) {
          return
        }

        const requested = await transport.serverNow()

        await transport.pushRequest({
          v: SYNQUX_SCHEMA_VERSION,
          groupId: session!.groupId,
          requested,
          requestedBy: selfId!,
          action: {
            type: action.type,
            // undefined 落ち対策で payload は JSON 文字列化して運ぶ
            ...((action as UnknownAction).payload === undefined
              ? {}
              : { payload: JSON.stringify((action as UnknownAction).payload) }),
            meta: {
              ...meta,
              requestedBy: selfId!,
              dispatched: requested,
            },
          },
        })

        // response を待たず中断する。どのみち request は全端末が受信 → dispatch する
        return
      }

      const applied = next(action)

      // standalone (instance 設定で無効) のときだけ localSnapshots へ永続化する。
      // runtime の setEnabled(false) (tutorial 等) では保存しない
      if (!instanceEnabled && isSynced) {
        persistLocalSnapshot(store.getState() as TRoot)
      }

      return applied
    }

  /**
   * 判定待ち request を host として捌く fork (移植元 requestListener 相当)
   *
   * 全端末が未応答 request ごとに永続 fork を持ち、「自分が host か」
   * 「先行 request (prev) が処理済みか」を監視し続ける。host 不在・migration 中に
   * 届いた request も、誰かが host に昇格した時点で処理される
   */
  const requestListener = createListenerMiddleware()
  requestListener.startListening({
    actionCreator: synquxActions.requestAdded,
    effect: (action, listener) => {
      const { request, prev } = action.payload

      listener.fork(async () => {
        while (true) {
          // 先行する request が存在するとき、その処理完了まで待機させる
          if (ordering.shouldWaitFor(prev)) {
            await sleepTimer(REQUEST_LOOP_MS)
            continue
          }

          const current = listener.getState() as TRoot
          const responsedBy = current.synqux.connections.selfId

          // ほぼありえないが、型ヒントと接続切れた時用
          if (!responsedBy) {
            break
          }

          // 処理済みなら他 host が処理し全体に伝播済みのため破棄
          if (ordering.isApplied(request.id)) {
            break
          }

          // 遅延 request は順序保証のため意図的に取りこぼす (既知の問題②の機構)
          if (ordering.isDelayed(request.id)) {
            break
          }

          // host 昇格するまでは判定を行わない
          if (!selectIsHost(current)) {
            await sleepTimer(HOST_PROMOTION_LOOP_MS)
            continue
          }

          try {
            // reducer が唯一の判定器: rootReducer の試し実行で成否を判定する
            const next = config.rootReducer(current, request.action as TAction)
            const result = config.selectSynced(next).result

            // 既知の問題①の修正: snapshot へ載せる revisions を ack await の
            // 「前」に評価固定する。ack 遅延中に responseListener 側の
            // markApplied が先行しても、同一 id が隣接ペアで二重記録されない
            const revisions = ordering.revisions().concat(request.id)

            // 決定性検出網: 試し実行結果を控える。error & console は dispatch
            // されず実適用が発生しないため対象外
            if (
              devDeterminismCheck &&
              !(result?.type === 'error' && result.console)
            ) {
              expectedSyncedByRequest.set(
                request.id,
                canonicalStringify(config.selectSynced(next)),
              )
            }

            await transport.respondRequest(request.id, {
              prev: prev ?? null, // host 取得 prev を正として焼き込む
              responsedBy,
              result: result ? serializeResult(result) : null,
            })

            await persistSnapshot(config.selectSynced(next), revisions)
          } catch (e) {
            // reducer 内で throw された時用
            console.error(e)

            await transport.respondRequest(request.id, {
              prev: prev ?? null,
              responsedBy,
              result: serializeResult({
                action: request.action as TAction,
                type: 'error',
                targets: [request.requestedBy],
                message: e instanceof Error ? e.message : String(e),
                console: true,
              }),
            })
          }

          break
        }
      })
    },
  })

  /**
   * host 裁定済み request を適用する fork (移植元 responseListener 相当)
   * ここで初めて request.action が全端末に dispatch される
   */
  const responseListener = createListenerMiddleware()
  responseListener.startListening({
    actionCreator: synquxActions.requestChanged,
    effect: (action, listener) => {
      const { request, prev } = action.payload

      listener.fork(async () => {
        while (true) {
          // 処理済み (または他 fork が処理中) なら自端末で反映済みのため破棄。
          // isProcessing は同一 changed の同時二重配送による二重 dispatch を防ぐ
          // 処理中ガード (既知の問題①′の修正)
          if (
            ordering.isApplied(request.id) ||
            ordering.isProcessing(request.id)
          ) {
            break
          }

          // 先行する未処理の response が存在するとき、その処理完了まで待機させる
          if (ordering.shouldWaitFor(prev)) {
            await sleepTimer(REQUEST_LOOP_MS)
            continue
          }

          // error & console な result は負荷軽減のため dispatch せず直接出力
          if (request.result?.type === 'error' && request.result.console) {
            console.error(request.result.message)
            ordering.markApplied(request.id)
            break
          }

          // dispatch 直前 (await を挟まず同期的) にガードを立てる。
          // prev 待機 loop 内で立てると fork が死んだとき誰も処理できなくなる
          ordering.beginProcessing(request.id)

          try {
            listener.dispatch(request.action as TAction)

            // snapshot の永続化や次の request を捌く fork の開始は state の更新完了後で
            // ないと不整合となる。適用完了 = 内部 entities からの破棄、をもって進行する
            await waitUntilOrFail(
              () =>
                !(listener.getState() as TRoot).synqux.requests.entities[
                  request.id
                ],
              { intervalMillis: REQUEST_LOOP_MS },
            )

            ordering.markApplied(request.id)

            // 決定性検出網: 実適用後の synced を host の試し実行結果と照合する
            verifyDeterminism(
              request.id,
              config.selectSynced(listener.getState() as TRoot),
            )
          } finally {
            // markApplied 済みなら不要。失敗時も解放し、再配送での retry 余地を残す
            ordering.endProcessing(request.id)
          }

          break
        }
      })
    },
  })

  // ---------------------------------------------------------------
  // subscribe (受信ルーティング / restore / presence)
  // ---------------------------------------------------------------

  const subscribe = async ({
    store,
    groupId,
    role,
    label,
  }: SynquxSubscribeOptions<TRoot>): Promise<() => Promise<void>> => {
    if (session) {
      throw new Error('synqux is already subscribed')
    }

    if (store.getState().synqux === undefined) {
      throw new Error(
        'state.synqux is not mounted. Wire sync.reducer (or createSynquxRootReducer) into your root reducer.',
      )
    }

    // ---- standalone: transport に触れず local restore だけ行う ----
    if (!instanceEnabled) {
      session = { groupId }
      store.dispatch(
        synquxActions.sessionStarted({ selfId: null, enabled: false }),
      )

      const payload = await config.localSnapshots?.loadSnapshot(groupId)

      if (payload) {
        const envelope = parseSnapshotPayload(payload)
        ordering.seed(envelope.ordering.revisions)
        store.dispatch(
          synquxRestored({ synced: clearRestoredResult(envelope.synced) }),
        )
      }

      return async () => {
        session = null
        store.dispatch(synquxActions.sessionEnded())
      }
    }

    // ---- synced: presence 登録 → restore → requests 購読 ----
    const { selfId } = await transport.connect({ groupId, role, label })

    const unsubscribePeers = transport.subscribePeers({
      onAdded: (peer) => store.dispatch(synquxActions.peerUpserted(peer)),
      onChanged: (peer) => store.dispatch(synquxActions.peerUpserted(peer)),
      onRemoved: (peer) => store.dispatch(synquxActions.peerRemoved(peer.id)),
    })

    store.dispatch(synquxActions.sessionStarted({ selfId, enabled: true }))

    // 復帰端末は snapshot + revisions を復元し、それ以降の requests だけを
    // 購読して追いつく。途中参加・リロード・host migration をまたいでも
    // 状態と順序保証が継続する
    let restoredRevision: RequestEnvelope['id'] | undefined
    const payload = await transport.loadSnapshot(groupId)

    if (payload) {
      const envelope = parseSnapshotPayload(payload)
      ordering.seed(envelope.ordering.revisions)
      restoredRevision = ordering.lastRevision()
      store.dispatch(
        synquxRestored({ synced: clearRestoredResult(envelope.synced) }),
      )
    }

    const rejectUnknownSchema = (envelope: RequestEnvelope): boolean => {
      if (envelope.v === SYNQUX_SCHEMA_VERSION) {
        return false
      }

      // wire format の新旧混在は黙って無視せず、明示的に拒否して運用側に知らせる
      console.error(
        `[synqux] Rejected request ${envelope.id}: unsupported schema version ${String(envelope.v)}`,
      )
      return true
    }

    const unsubscribeRequests = transport.subscribeRequests(
      { after: restoredRevision },
      {
        onAdded: (envelope, prevKey) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          // 同一 prevKey の added は重複配送 (遅延ののち重複) として破棄する
          if (!ordering.acceptAdded(prevKey)) {
            return
          }

          const request = parseEnvelope(envelope)

          // restore タイミング次第で responsedBy 付き request が added で届く。
          // host 裁定済みのものは changed 相当として適用側の待機 loop に回す
          // (transport の prevKey は信頼せず、host が焼き込んだ prev を正とする)
          if (request.responsedBy) {
            store.dispatch(
              synquxActions.requestChanged({
                request,
                prev: request.prev ?? null,
              }),
            )
            return
          }

          store.dispatch(
            synquxActions.requestAdded({
              request,
              // restore 時 query 先頭の prevKey は null になるため、
              // snapshot の revision を prev として補完し prev 検証を保つ
              prev: !prevKey && restoredRevision ? restoredRevision : prevKey,
            }),
          )
        },

        onChanged: (envelope) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          const request = parseEnvelope(envelope)

          // host により responsedBy が付与されたものだけ受け取る
          if (!request.responsedBy) {
            return
          }

          store.dispatch(
            synquxActions.requestChanged({
              request,
              prev: request.prev ?? null,
            }),
          )
        },
      },
    )

    session = { groupId }

    return async () => {
      unsubscribePeers()
      unsubscribeRequests()
      session = null
      store.dispatch(synquxActions.sessionEnded())
      await transport.disconnect()
    }
  }

  return {
    // 実行順: meta 付与 → (fork 系) → request 化。listener 2 つは actionRequest より
    // 前段に置き、内部 action (requestAdded/Changed) の匹配を request 化と分離する
    middlewares: [
      metaSetterMiddleware,
      requestListener.middleware,
      responseListener.middleware,
      actionRequestMiddleware,
    ],
    reducer: synquxReducer,
    rootReducer: config.rootReducer,
    subscribe,
    actions: {
      setEnabled: synquxActions.setEnabled,
    },
    selectSynced: config.selectSynced,
  }
}

/**
 * restore した synced state の result は復元しない (移植元 loadGameState の
 * clearResultFromGameState 踏襲)。result は transient な通知であり、
 * リロード時に過去の toast を再生してしまうのを防ぐ
 */
const clearRestoredResult = (synced: unknown): unknown => ({
  ...(synced as SynquxSynced),
  result: null,
})
