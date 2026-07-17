import {
  createListenerMiddleware,
  isAction,
  type Action,
  type Dispatch,
  type Middleware,
  type Reducer,
  type UnknownAction,
} from '@reduxjs/toolkit'
import { waitUntilOrFail } from '@yano3nora/ts-utils'
import { createOrdering, type OrderingState } from './ordering.js'
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
  type SynquxHealth,
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
} from './types.js'

/**
 * 待機 fork の安全網タイムアウト (ms)
 *
 * fork の待機はイベント駆動 (waker) が主で、状態変化 (peer 増減・request 受信・
 * 適用完了) の notify で即時に再評価される。このタイムアウトは「notify の
 * 取りこぼし」に備えた保険であり、平常時のレイテンシには現れない
 */
const WAKE_FALLBACK_MS = 1000

/** gap の継続時間を評価する heartbeat 間隔。correctness には使わない */
const HEALTH_CHECK_INTERVAL_MS = 1000

const OK_HEALTH: SynquxHealth = {
  phase: 'ok',
  expectedSeq: null,
  maxSeenSeq: null,
  gapSince: null,
}

/**
 * イベント駆動待機のシグナル (ADR-0002 / イベント駆動化)
 * notify で全 waiter を起こす。timeout は安全網 (起きて再評価して損はない)
 */
const createWaker = () => {
  let waiters: (() => void)[] = []

  return {
    notify(): void {
      const pending = waiters
      waiters = []
      for (const resolve of pending) {
        resolve()
      }
    },

    wait(timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs)

        function done(): void {
          clearTimeout(timer)
          resolve() // 二重呼び出し (notify 後の timeout 等) は no-op
        }

        waiters.push(done)
      })
    },
  }
}

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

  /**
   * stall 判定のヒステリシス ms。「観測済み最大 seq が appliedSeq を超えたまま
   * appliedSeq がこの時間進まない」で stalled になる。一時遅配を誤検知しない
   * 値にすること。端末ローカル時刻は通知用であり correctness には使わない
   */
  stallAfterMs?: number

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
   * `(s) => s.game.result` のように直接読むこと (SPEC-0002-public-api.md)
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
  const stallAfterMs = config.stallAfterMs ?? 30_000

  // 処理済みリスト等の同期状態はすべてインスタンス内部に持つ (Decision 3)
  const ordering = createOrdering()

  // 待機 fork をイベントで起こすシグナル。notify 点は「state 変化 = 再評価に
  // 値する事象」に限る: peer 増減 / request 受信 / 適用完了
  const waker = createWaker()

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
    orderingState: OrderingState,
  ): Promise<void> => {
    if (!session) {
      return
    }

    await transport.saveSnapshot(
      session.groupId,
      buildSnapshotPayload({ synced, ordering: orderingState }),
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
          ordering: ordering.state(),
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
    epoch: envelope.epoch,
    seq: envelope.seq,
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
   * request ごとの host 裁定 fork (ADR-0002)
   *
   * 全端末が request ごとに fork を持ち、「自分が host か」を監視し続ける。
   * fork は request が**適用されるまで**生存し (v1 の「応答済みまで」から延長)、
   * 自分が host のとき以下を裁定する:
   * - 未裁定の request → 通常の裁定 (試し実行 → seq 採番 → respond)
   * - seq スロットを別 request に取られた確定敗者 (dual-host 窓の産物) → 再裁定
   *
   * NOTE 前 host の「responded 済み・未適用」の in-flight 裁定は再採番しない
   * (誰かが適用済みかもしれず、再採番は適用列の分岐を作る)。直列ゲートで
   * その適用を待ってから次の裁定に進む
   */
  const hostForkActive = new Set<RequestEnvelope['id']>()

  const spawnHostFork = (
    listener: {
      getState: () => unknown
      fork: (fn: () => Promise<void>) => unknown
    },
    id: RequestEnvelope['id'],
  ): void => {
    if (hostForkActive.has(id)) {
      return
    }
    hostForkActive.add(id)

    listener.fork(async () => {
      try {
        while (true) {
          if (ordering.isApplied(id)) {
            break
          }

          const current = listener.getState() as TRoot
          const entity = current.synqux.requests.entities[id]
          const responsedBy = current.synqux.connections.selfId

          // entity 消滅 = 適用直後 (hash matcher が破棄済み)。接続切れも同様に離脱
          if (!entity || !responsedBy) {
            break
          }

          // host 昇格するまでは判定を行わない
          if (!selectIsHost(current)) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          const responded = entity.seq !== undefined

          if (responded) {
            // 窓より古い過去 → 適用済み扱いで破棄 (responseListener 側も破棄する)
            if (ordering.isBeyondWindow(entity.seq!)) {
              break
            }

            // 確定敗者 (スロットを別 request が消費) だけが再裁定の対象。
            // それ以外の responded は正当な in-flight であり、適用を待つのみ
            const isLoser =
              ordering.isStale(entity.seq!) && !ordering.isApplied(id)

            if (!isLoser) {
              await waker.wait(WAKE_FALLBACK_MS)
              continue
            }
          }

          // 直列裁定ゲート: 自分の発行済み or 他 host の in-flight (未適用の
          // responded) が残る間は、試し実行の土台 state が古いため裁定しない
          const hasInflight = Object.values(
            current.synqux.requests.entities,
          ).some(
            (pending) =>
              pending.seq !== undefined && pending.seq > ordering.appliedSeq(),
          )
          if (hasInflight || ordering.hasPendingIssue()) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          const epoch = ordering.beginHosting()
          const seq = ordering.issueSeq()

          try {
            // reducer が唯一の判定器: rootReducer の試し実行で成否を判定する
            const next = config.rootReducer(current, entity.action as TAction)
            const result = config.selectSynced(next).result

            // snapshot へ載せる順序状態を ack await の「前」に評価固定する
            // (v1 の既知の問題①と同じ構図の再発防止)
            const orderingState = ordering.stateWith(seq, id)

            // 決定性検出網: 試し実行結果を控える。error & console は dispatch
            // されず実適用が発生しないため対象外
            if (
              devDeterminismCheck &&
              !(result?.type === 'error' && result.console)
            ) {
              expectedSyncedByRequest.set(
                id,
                canonicalStringify(config.selectSynced(next)),
              )
            }

            await transport.respondRequest(id, {
              epoch,
              seq,
              responsedBy,
              result: result ? serializeResult(result) : null,
            })

            await persistSnapshot(config.selectSynced(next), orderingState)
          } catch (e) {
            // reducer 内で throw された時用 (transport 失敗もここに落ちる)
            console.error(e)

            try {
              await transport.respondRequest(id, {
                epoch,
                seq, // 同一 seq を使う。二重発行になっても tiebreak が収束させる
                responsedBy,
                result: serializeResult({
                  action: entity.action as TAction,
                  type: 'error',
                  targets: [entity.requestedBy],
                  message: e instanceof Error ? e.message : String(e),
                  console: true,
                }),
              })
            } catch (respondError) {
              // respond 自体が失敗: 発行を取り消して host の永久停止を防ぐ
              console.error(respondError)
              ordering.retractIssue()
            }
          }

          break
        }
      } finally {
        hostForkActive.delete(id)
      }
    })
  }

  const requestListener = createListenerMiddleware()
  requestListener.startListening({
    actionCreator: synquxActions.requestAdded,
    effect: (action, listener) => {
      spawnHostFork(listener, action.payload.request.id)
      waker.notify() // 新規 request: 直列裁定ゲートの再評価を促す
    },
  })
  // 裁定済みで届いた request (restore / 再配送) にも敗者救済の watch が要るため、
  // changed 側からも host fork を立てる (active set で二重起動はしない)
  requestListener.startListening({
    actionCreator: synquxActions.requestChanged,
    effect: (action, listener) => {
      spawnHostFork(listener, action.payload.request.id)
      waker.notify() // 裁定の到着/更新: seq 待ちと勝者判定の再評価を促す
    },
  })
  // peer 増減で host が変わり得るため、昇格待機中の fork を起こす
  // (migration 回復の主経路。1000ms ポーリングは安全網に格下げ)
  requestListener.startListening({
    actionCreator: synquxActions.peerUpserted,
    effect: () => waker.notify(),
  })
  requestListener.startListening({
    actionCreator: synquxActions.peerRemoved,
    effect: () => waker.notify(),
  })

  /**
   * host 裁定済み request を適用する fork (ADR-0002)
   * ここで初めて request.action が全端末に dispatch される
   *
   * 適用規則は「appliedSeq + 1 の seq を持つ envelope を適用」。同一 seq に
   * 複数 request が衝突している場合 (dual-host 窓) は (epoch 降順,
   * responsedBy 辞書順降順) の決定的 tiebreak で勝者を選び、敗者は host の
   * 再裁定 (requestChanged で entity が新しい seq に上書きされる) を待つ
   */
  const responseListener = createListenerMiddleware()
  responseListener.startListening({
    actionCreator: synquxActions.requestChanged,
    effect: (action, listener) => {
      const { id } = action.payload.request

      listener.fork(async () => {
        while (true) {
          // 処理済み (または他 fork が処理中) なら自端末で反映済みのため破棄。
          // isProcessing は同一 changed の同時二重配送による二重 dispatch を防ぐ
          // 処理中ガード (v1 の既知の問題①′対策を継続)
          if (ordering.isApplied(id) || ordering.isProcessing(id)) {
            break
          }

          // 裁定印は再裁定で変わり得るため、fork の起動時 payload ではなく
          // 最新の entity を毎 loop 読み直す
          const current = listener.getState() as TRoot
          const entity = current.synqux.requests.entities[id]

          if (!entity || entity.seq === undefined) {
            // entity 消滅 = 他 fork が適用完了。裁定印なしは routing 上来ない
            break
          }

          const seq = entity.seq

          // 窓より古い過去は正史/敗者の区別記録がなく、適用済み扱いで破棄する
          // (restore 時の全量購読で届く歴史的 envelope はここで落ちる)
          if (ordering.isBeyondWindow(seq)) {
            break
          }

          if (ordering.isStale(seq)) {
            // 正史なら isApplied で break 済み → ここに来るのは dual-host 窓の
            // 敗者。host の再裁定 (新しい seq) を待つ
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // 先行する seq が未適用のあいだ待機する (順序の線形化)
          if (ordering.shouldWait(seq)) {
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // seq == appliedSeq + 1: 同一 seq の衝突があれば決定的 tiebreak
          const rivals = Object.values(current.synqux.requests.entities).filter(
            (pending) => pending.seq === seq,
          )
          const winner = rivals.reduce((best, candidate) => {
            const bestKey: [number, string] = [
              best.epoch ?? 0,
              best.responsedBy ?? '',
            ]
            const candidateKey: [number, string] = [
              candidate.epoch ?? 0,
              candidate.responsedBy ?? '',
            ]
            return candidateKey[0] > bestKey[0] ||
              (candidateKey[0] === bestKey[0] && candidateKey[1] > bestKey[1])
              ? candidate
              : best
          })

          if (winner.id !== id) {
            // 自分は敗者候補: 勝者の適用 → 自分の再裁定を待つ
            await waker.wait(WAKE_FALLBACK_MS)
            continue
          }

          // error & console な result は負荷軽減のため dispatch せず直接出力
          if (entity.result?.type === 'error' && entity.result.console) {
            console.error(entity.result.message)
            ordering.markApplied(seq, id)
            waker.notify() // 適用完了: 次の seq を待つ fork を起こす
            break
          }

          // dispatch 直前 (await を挟まず同期的) にガードを立てる。
          // seq 待機 loop 内で立てると fork が死んだとき誰も処理できなくなる
          ordering.beginProcessing(id)

          try {
            listener.dispatch(entity.action as TAction)

            // dispatch は同期で、成功した時点で適用は確定している。markApplied を
            // ここ (dispatch 直後・await なし) で行い、「entity は消えたが
            // appliedSeq が進んでいない」観測窓を作らない — この窓があると
            // 他 fork が rival 消失を「自分が勝者」と誤認し得る。
            // NOTE dispatch **前**への前倒しは不可 (失敗時に seq が永久欠番になる)
            ordering.markApplied(seq, id)
            waker.notify() // 適用完了: 次の seq を待つ fork を起こす

            // 内部 entities からの破棄 (同 hash の action 通過) を確認してから
            // fork を終える。通常は dispatch 内で同期完了しており即座に通る
            await waitUntilOrFail(
              () =>
                !(listener.getState() as TRoot).synqux.requests.entities[id],
              { intervalMillis: WAKE_FALLBACK_MS },
            )

            // 決定性検出網: 実適用後の synced を host の試し実行結果と照合する
            verifyDeterminism(
              id,
              config.selectSynced(listener.getState() as TRoot),
            )
          } finally {
            // markApplied 済みなら不要。失敗時も解放し、再配送での retry 余地を残す
            ordering.endProcessing(id)
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
        ordering.seed(envelope.ordering)
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

    // 復帰端末は snapshot (synced + 順序状態) を復元してから requests を購読する。
    // 途中参加・リロード・host migration をまたいでも状態と順序保証が継続する
    const payload = await transport.loadSnapshot(groupId)

    if (payload) {
      const envelope = parseSnapshotPayload(payload)
      ordering.seed(envelope.ordering)
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

    // NOTE after (id 辞書順フィルタ) は使わない: id 順は端末時計依存で
    // 「id は古いが seq は新しい」request を取り逃がすため、全量購読して
    // 適用済み分は seq / 直近窓で破棄する (ADR-0002 Decision 5)。再取得コストは
    // transport の retention 契約 (snapshot 地点より古い requests の prune) で抑える
    const unsubscribeRequests = transport.subscribeRequests(
      {},
      {
        onAdded: (envelope) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          // 同一 request の added 重複配送 (遅延ののち重複) を破棄する
          if (!ordering.acceptAdded(envelope.id)) {
            return
          }

          const request = parseEnvelope(envelope)
          ordering.observe({ epoch: request.epoch, seq: request.seq })

          // restore タイミング次第で裁定済み request が added で届く。
          // 裁定済みのものは changed 相当として適用側の待機 loop に回す
          if (request.responsedBy) {
            store.dispatch(synquxActions.requestChanged({ request }))
            return
          }

          store.dispatch(synquxActions.requestAdded({ request }))
        },

        onChanged: (envelope) => {
          if (rejectUnknownSchema(envelope)) {
            return
          }

          const request = parseEnvelope(envelope)

          // host により裁定されたものだけ受け取る
          if (!request.responsedBy) {
            return
          }

          ordering.observe({ epoch: request.epoch, seq: request.seq })
          store.dispatch(synquxActions.requestChanged({ request }))
        },
      },
    )

    let gapStartedAt: number | null = null
    let lastAppliedSeq = ordering.appliedSeq()

    const healthEquals = (left: SynquxHealth, right: SynquxHealth): boolean =>
      left.phase === right.phase &&
      left.expectedSeq === right.expectedSeq &&
      left.maxSeenSeq === right.maxSeenSeq &&
      left.gapSince === right.gapSince

    const updateHealth = (health: SynquxHealth): void => {
      if (!healthEquals(store.getState().synqux.health, health)) {
        store.dispatch(synquxActions.healthChanged(health))
      }
    }

    /**
     * envelope の在否ではなく ordering の進行だけを見る。dual-host の敗者を先に
     * 適用した stall では、再裁定 envelope が entities に残ったままになるため。
     * Date.now はヒステリシスと診断表示にしか使わず、適用順の correctness は
     * 引き続き host 採番 seq だけで決まるため端末時計で十分。
     */
    const healthTimer = setInterval(() => {
      const applied = ordering.appliedSeq()

      if (!store.getState().synqux.enabled) {
        gapStartedAt = null
        lastAppliedSeq = applied
        updateHealth(OK_HEALTH)
        return
      }

      const maxSeen = ordering.maxSeenSeq()
      const now = Date.now()

      if (applied > lastAppliedSeq || maxSeen <= applied) {
        gapStartedAt = null
      }
      lastAppliedSeq = applied

      if (maxSeen > applied && gapStartedAt === null) {
        gapStartedAt = now
      }

      if (gapStartedAt !== null && now - gapStartedAt >= stallAfterMs) {
        updateHealth({
          phase: 'stalled',
          expectedSeq: applied + 1,
          maxSeenSeq: maxSeen,
          gapSince: gapStartedAt,
        })
        return
      }

      updateHealth(OK_HEALTH)
    }, HEALTH_CHECK_INTERVAL_MS)

    session = { groupId }

    return async () => {
      clearInterval(healthTimer)
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
