import {
  endBefore,
  get,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  orderByChild,
  orderByKey,
  push,
  query,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  startAfter,
  update,
  type Database,
  type Query,
} from 'firebase/database'
import type {
  Peer,
  PeerRole,
  RequestEnvelope,
  SnapshotFence,
  SynquxTransport,
} from '../core/types.js'

type StoredSnapshot = { fence: SnapshotFence; payload: string }

const isStoredSnapshot = (value: unknown): value is StoredSnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<StoredSnapshot>
  return (
    typeof candidate.payload === 'string' &&
    typeof candidate.fence?.epoch === 'number' &&
    typeof candidate.fence.appliedSeq === 'number'
  )
}

const acceptsFence = (stored: SnapshotFence, next: SnapshotFence): boolean =>
  next.epoch > stored.epoch ||
  (next.epoch === stored.epoch && next.appliedSeq >= stored.appliedSeq)

/**
 * RTDB の key に使えない文字 (パス区切り `/` を含む)。groupId はそのまま
 * `connections/{groupId}` 等の path 断片になるため、通せば別 path への書き込みや
 * 実行時エラーになる。書き込み前の入口で明示的に拒否する
 */
// oxlint-disable-next-line no-control-regex -- RTDB key の禁止対象に制御文字を含める意図的な指定
const INVALID_GROUP_ID_CHARS = /[.#$/[\]\u0000-\u001f\u007f]/

/**
 * Firebase Realtime Database の transport adapter (ADR-0001 Decision 2)
 *
 * データ配置は移植元テンプレートと同一:
 * - `connections/{groupId}/{peerId}` — presence (onDisconnect で自動削除)
 * - `requests/{groupId}/{requestId}` — request 封筒 (push id 採番 = 挿入順辞書順)
 * - `logs/{groupId}/{requestId}` — prune 済み request の調査ログ (opt-in)
 * - `games/{groupId}` — fence と canonical JSON snapshot payload
 *
 * 前提: firebase auth (匿名認証等) は consumer が transport 生成前に済ませること。
 * at-least-once の吸収 (重複・遅延・振り分け) は core の責務のため、この adapter は
 * 観測したイベントを素朴に流すだけでよい (SynquxTransport 契約 3)
 */
export const firebaseTransport = (
  db: Database,
  options?: { archivePrunedRequests?: boolean },
): SynquxTransport => {
  // 接続セッション。connect() 成功後に確定し、disconnect() で破棄する
  let session: {
    groupId: string
    selfId: string
    role: Peer['role'] | null
    label: Peer['label'] | null
    connectedAt: number | null
    sawDisconnect: boolean
    reregistering: Promise<void> | null
    unsubscribeConnected?: () => void
    disposed: boolean
  } | null = null

  // .info/serverTimeOffset の補正値。インスタンス内に cache する (module 変数禁止)
  let serverTimeOffset: number | null = null

  const requireSession = () => {
    if (!session) {
      throw new Error('Firebase transport is not connected')
    }
    return session
  }

  const connectionsPath = (groupId: string) => `connections/${groupId}`
  const requestsPath = (groupId: string) => `requests/${groupId}`
  const logsPath = (groupId: string) => `logs/${groupId}`
  const snapshotPath = (key: string) => `games/${key}`

  /**
   * firebase は undefined を含む値の書き込みで throw するため、書き込み直前に
   * JSON 往復で undefined キーを除去する (payload / result の直列化は core 側で
   * 済んでいるので、ここで消えるのは meta 等に紛れた undefined のみ)
   */
  const sanitize = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  const requestsQuery = (groupId: string, after?: string): Query =>
    after
      ? query(ref(db, requestsPath(groupId)), orderByKey(), startAfter(after))
      : query(ref(db, requestsPath(groupId)), orderByKey())

  /** snap.val() に snap.key を焼き込んで封筒を完成させる */
  const toEnvelope = (val: unknown, key: string | null): RequestEnvelope => ({
    ...(val as Omit<RequestEnvelope, 'id'>),
    id: key ?? '',
  })

  return {
    async connect({ groupId, role, label, signal }) {
      if (session) {
        throw new Error('Firebase transport is already connected')
      }

      if (groupId.length === 0 || INVALID_GROUP_ID_CHARS.test(groupId)) {
        throw new Error(
          `Invalid groupId "${groupId}": must be a non-empty RTDB key without ".", "#", "$", "/", "[", "]" or control characters`,
        )
      }

      signal?.throwIfAborted()

      // presence 検知の前提となる db 接続の確立を待つ
      // https://firebase.google.com/docs/database/web/offline-capabilities
      // .info/connected は websocket 確立前に false を即時発火してから true を
      // 発火する 2 段階挙動のため、onlyOnce では最初の false でリスナーが外れて
      // 永遠に接続待ちになる。true が来るまで張り続け、await 復帰後に解除する
      // (コールバックが同期発火しても unsub 未代入参照にならない順序)。
      // offline 起動の無期限待機は signal の abort でのみ打ち切れる (契約 8)
      let unsubConnected: (() => void) | undefined
      let removeAbortListener: (() => void) | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          if (signal) {
            const onAbort = (): void => reject(signal.reason)
            signal.addEventListener('abort', onAbort, { once: true })
            removeAbortListener = () =>
              signal.removeEventListener('abort', onAbort)
          }
          unsubConnected = onValue(ref(db, '.info/connected'), (snap) => {
            if (snap.val() === true) {
              resolve()
            }
          })
        })
      } finally {
        unsubConnected?.()
        removeAbortListener?.()
      }

      const selfRef = push(ref(db, connectionsPath(groupId)))
      const selfId = selfRef.key!

      // 切断時 (プロセス死・ネットワーク断含む) の自動削除を登録してから書き込む
      // (SynquxTransport 契約 5: presence cleanup の保証)
      await onDisconnect(selfRef).remove()

      if (signal?.aborted) {
        // presence 未登録なので onDisconnect の予約だけ取り消して中断する
        await onDisconnect(selfRef).cancel()
        throw signal.reason
      }

      await set(
        selfRef,
        sanitize({
          id: selfId,
          groupId,
          connected: serverTimestamp() as unknown as number, // サーバ採番 (契約: 端末時計を使わない)
          role: role ?? null, // firebase は undefined 不可のため null で「キーなし」にする
          label: label ?? null,
        }),
      )

      let connectedAt: number | null = null
      try {
        const registered = (await get(selfRef)).val() as {
          connected?: unknown
        } | null
        if (typeof registered?.connected === 'number') {
          connectedAt = registered.connected
        }
      } catch {
        // 読み戻し不能でも初回登録自体は成功済み。再登録時だけ serverTimestamp へ戻す
      }

      if (signal?.aborted) {
        // presence 登録済みの中断は登録を取り消す (abort で presence を残さない契約)
        await remove(selfRef)
        await onDisconnect(selfRef).cancel()
        throw signal.reason
      }

      const currentSession = {
        groupId,
        selfId,
        role: role ?? null,
        label: label ?? null,
        connectedAt,
        sawDisconnect: false,
        reregistering: null as Promise<void> | null,
        unsubscribeConnected: undefined as (() => void) | undefined,
        disposed: false,
      }
      session = currentSession

      currentSession.unsubscribeConnected = onValue(
        ref(db, '.info/connected'),
        (snap) => {
          if (currentSession.disposed || session !== currentSession) {
            return
          }

          if (snap.val() === false) {
            currentSession.sawDisconnect = true
            return
          }

          if (
            snap.val() !== true ||
            !currentSession.sawDisconnect ||
            currentSession.reregistering
          ) {
            return
          }

          // await 前に処理中ガードを立て、重複する true 配送で二重登録しない
          const attempt = (async () => {
            // presence を先に書くと、その直後の切断で孤児レコードが残るため、
            // 初回登録と同じく onDisconnect の再登録を set より先に完了させる。
            await onDisconnect(selfRef).remove()
            if (currentSession.disposed || session !== currentSession) {
              return
            }

            await set(
              selfRef,
              sanitize({
                id: selfId,
                groupId,
                // 再接続は新規参加ではない。初回値を維持し、不安定な端末による
                // host 強奪・host churn を防ぐ。読み戻し不能時だけサーバ採番へ戻す。
                connected:
                  currentSession.connectedAt ??
                  (serverTimestamp() as unknown as number),
                role: currentSession.role,
                label: currentSession.label,
                // 再登録の瞬間は生存確実なのでサーバ時刻で焼き直す (ADR-0016)。
                // set は object 全置換のため、省略すると demote 前の古い値が
                // 消えるだけだが、明示した方が stale 判定の起点が新しくなる
                lastSeenAt: serverTimestamp() as unknown as number,
              }),
            )
            currentSession.sawDisconnect = false
          })()

          const reregistering = attempt
            .catch((error: unknown) => {
              console.error('Firebase presence re-registration failed', error)
            })
            .finally(() => {
              currentSession.reregistering = null
            })
          currentSession.reregistering = reregistering
        },
      )

      return { selfId }
    },

    async disconnect() {
      const currentSession = requireSession()
      const { groupId, selfId } = currentSession
      const selfRef = ref(db, `${connectionsPath(groupId)}/${selfId}`)

      // watcher を最初に止め、進行中の再登録にも破棄を同期的に通知する。
      currentSession.unsubscribeConnected?.()
      currentSession.disposed = true
      session = null
      await currentSession.reregistering

      await remove(selfRef)
      await onDisconnect(selfRef).cancel()
    },

    async updateSelf(patch) {
      const currentSession = requireSession()
      const selfRef = ref(
        db,
        `${connectionsPath(currentSession.groupId)}/${currentSession.selfId}`,
      )
      const previousRole = currentSession.role
      const nextRole = patch.role ?? null

      // 再接続処理が並行しても更新後の role で再登録するため、await より先に
      // session を更新する。書き込み失敗時は後続更新を壊さない場合だけ戻す。
      currentSession.role = nextRole
      try {
        await update(selfRef, { role: nextRole })
      } catch (error) {
        if (currentSession.role === nextRole) {
          currentSession.role = previousRole
        }
        throw error
      }
    },

    async heartbeat() {
      const currentSession = requireSession()
      const selfRef = ref(
        db,
        `${connectionsPath(currentSession.groupId)}/${currentSession.selfId}`,
      )

      // サーバ採番 (契約 10: 端末時計を使わない)。他の presence 属性は触らない
      await update(selfRef, {
        lastSeenAt: serverTimestamp() as unknown as number,
      })
    },

    async demotePeer(id) {
      const currentSession = requireSession()

      // RTDB の update は消えた path に {role} だけの孤児 object を再生成して
      // しまうため、存在確認してから書く (契約 11 の no-op 要件)。確認と書き込みの
      // 間の切断 (onDisconnect 削除) と競合すると孤児が残り得るが、孤児は
      // role: 'guest' のみで host 候補になり得ず (deriveHostId は dedicated /
      // player だけを pool にする)、correctness には影響しない。物理的な掃除は
      // group 終了時の data lifecycle (consumer 責務) に含まれる
      const peerRef = ref(
        db,
        `${connectionsPath(currentSession.groupId)}/${id}`,
      )
      const existing = await get(peerRef)
      if (!existing.exists()) {
        return
      }

      await update(peerRef, { role: 'guest' satisfies PeerRole })
    },

    async serverNow() {
      if (serverTimeOffset !== null) {
        return Date.now() + serverTimeOffset
      }

      // connect() と同じ理由で onlyOnce + poll を避ける (こちらは初回発火で
      // 必ず数値が入るため実害はないが、待ち方を揃えておく)
      let unsubOffset: (() => void) | undefined
      await new Promise<void>((resolve) => {
        unsubOffset = onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
          serverTimeOffset = Number(snap.val()) || 0
          resolve()
        })
      })
      unsubOffset?.()

      // resolve 時点で必ず代入済みだが、callback 内代入は TS が narrow できない
      return Date.now() + (serverTimeOffset ?? 0)
    },

    subscribePeers(handlers) {
      const { groupId } = requireSession()
      const connectionsRef = ref(db, connectionsPath(groupId))

      // cancel callback (第 3 引数) は permission denied 等で購読が回復不能に
      // 打ち切られた合図。SDK 側でリスナーは解除済みなので、onError で core へ
      // 委ねる (契約 8)。リスナーごとに発火し得るが、重複排除は core が行う
      const onCancel = (error: Error): void => handlers.onError?.(error)

      // 購読開始時、既存 peer は firebase の仕様どおり onChildAdded で一括配送される
      const unsubs = [
        onChildAdded(
          connectionsRef,
          (snap) => {
            handlers.onAdded(snap.val() as Peer)
          },
          onCancel,
        ),
        onChildChanged(
          connectionsRef,
          (snap) => {
            handlers.onChanged(snap.val() as Peer)
          },
          onCancel,
        ),
        onChildRemoved(
          connectionsRef,
          (snap) => {
            handlers.onRemoved(snap.val() as Peer)
          },
          onCancel,
        ),
      ]

      return () => unsubs.forEach((unsub) => unsub())
    },

    async pushRequest(envelope) {
      const { groupId } = requireSession()

      // push は id 採番と書き込みが atomic (挿入順で辞書順単調、契約 1)
      const pushed = await push(
        ref(db, requestsPath(groupId)),
        sanitize(envelope),
      )

      return { id: pushed.key! }
    },

    async respondRequest(id, patch) {
      const { groupId } = requireSession()

      // update の null 値はキー削除として働く (result: null)
      // resolve はサーバ ack (契約 2)。local echo の onChildChanged が先に届く
      await update(ref(db, `${requestsPath(groupId)}/${id}`), {
        epoch: patch.epoch,
        seq: patch.seq,
        responsedBy: patch.responsedBy,
        responsed: patch.responsed,
        result: patch.result,
      })
    },

    async pruneRequests(beforeSeq) {
      const { groupId } = requireSession()
      const requestsRef = ref(db, requestsPath(groupId))
      const target = query(
        requestsRef,
        orderByChild('seq'),
        endBefore(beforeSeq),
      )
      const snapshot = await get(target)
      const deletions: Record<string, null> = {}
      const archives: Record<string, unknown> = {}

      snapshot.forEach((child) => {
        const envelope = child.val() as Partial<RequestEnvelope> | null

        // RTDB は orderByChild の対象キーが無い child を数値より前に並べる。
        // query 結果だけを信用すると未裁定 request まで消すため、必ず再検査する。
        if (
          child.key !== null &&
          typeof envelope?.seq === 'number' &&
          envelope.seq < beforeSeq
        ) {
          deletions[child.key] = null
          archives[child.key] = envelope
        }
      })

      if (Object.keys(deletions).length > 0) {
        if (options?.archivePrunedRequests) {
          const moves: Record<string, unknown> = {}

          for (const [id, envelope] of Object.entries(archives)) {
            moves[`${requestsPath(groupId)}/${id}`] = null
            moves[`${logsPath(groupId)}/${id}`] = envelope
          }

          // requests から消え、logs にも無い中間状態を作らないよう、
          // root-level multi-path update 1 回で削除と調査ログへの退避を原子的に行う。
          await update(ref(db), moves)
        } else {
          await update(requestsRef, deletions)
        }
      }
    },

    subscribeRequests({ after }, handlers) {
      const { groupId } = requireSession()
      const target = requestsQuery(groupId, after)

      // subscribePeers と同じ理由で cancel を onError へ引き渡す (契約 8)
      const onCancel = (error: Error): void => handlers.onError?.(error)

      // 契約 3 強化 (added-before-changed、ADR-0021): SDK の性質に頼らず、
      // added 未配送の child の changed は buffer して added 配送後に flush する。
      // attach 済み listener と下の get() backlog 配送が競合しても、core へは
      // 「同一 child は added が先」の順序で届く
      let active = true
      const seenAdded = new Set<string>()
      const pendingChanged = new Map<string, RequestEnvelope[]>()

      const deliverAdded = (envelope: RequestEnvelope): void => {
        if (!active) {
          return
        }

        seenAdded.add(envelope.id)
        handlers.onAdded(envelope)

        const buffered = pendingChanged.get(envelope.id)
        if (buffered !== undefined) {
          pendingChanged.delete(envelope.id)
          for (const changed of buffered) {
            handlers.onChanged(changed)
          }
        }
      }

      const unsubs = [
        onChildAdded(
          target,
          (snap) => {
            deliverAdded(toEnvelope(snap.val(), snap.key))
          },
          onCancel,
        ),
        onChildChanged(
          target,
          (snap) => {
            if (!active) {
              return
            }

            const envelope = toEnvelope(snap.val(), snap.key)
            if (!seenAdded.has(envelope.id)) {
              const buffered = pendingChanged.get(envelope.id) ?? []
              buffered.push(envelope)
              pendingChanged.set(envelope.id, buffered)
              return
            }

            handlers.onChanged(envelope)
          },
          onCancel,
        ),
      ]

      // 初回一括配送の完了通知 (契約 12、ADR-0021): attach 済みと同一 query を
      // get() し、取得分を onAdded として配送してから onReady を呼ぶ。attach との
      // 二重配送は core の added dedup が吸収し、get() は裁定済みの最新値を含む
      // ため attach と get の間の changed 取り逃しは起きない。unsubscribe 後は
      // get 結果・onReady とも配送しない (cancellation guard)
      void get(target)
        .then((snapshot) => {
          if (!active) {
            return
          }

          snapshot.forEach((child) => {
            if (child.key !== null && !seenAdded.has(child.key)) {
              deliverAdded(toEnvelope(child.val(), child.key))
            }
          })

          if (active) {
            handlers.onReady?.()
          }
        })
        .catch((error: unknown) => {
          // 一括取得の失敗は契約 8 と同じ扱いで onError へ (onReady は呼ばない)
          if (active) {
            handlers.onError?.(error)
          }
        })

      return () => {
        active = false
        unsubs.forEach((unsub) => unsub())
      }
    },

    async saveSnapshot(key, payload, fence) {
      requireSession()
      // payload は core が直列化済みの不透明文字列。adapter は parse せず、
      // fence だけを transaction 内で原子的に比較する (ADR-0011)。
      // applyLocally: false は fence 購読 (契約 13) へ楽観 local echo を流さない
      // ための指定 — 購読イベントを server 確定値のみに限定する (ADR-0021)
      const result = await runTransaction(
        ref(db, snapshotPath(key)),
        (current: unknown) => {
          if (
            isStoredSnapshot(current) &&
            !acceptsFence(current.fence, fence)
          ) {
            return undefined
          }
          return { fence, payload }
        },
        { applyLocally: false },
      )
      return result.committed
    },

    async loadSnapshot(key) {
      requireSession()
      const snap = await get(ref(db, snapshotPath(key)))
      const stored: unknown = snap.exists() ? snap.val() : null
      return isStoredSnapshot(stored) ? stored.payload : null
    },

    subscribeSnapshotFence(key, handler) {
      requireSession()

      // snapshot node のうち fence child だけを購読する (payload は重いため
      // 購読しない。fence は数十 byte)。saveSnapshot が applyLocally: false の
      // ため、届く値は server 確定値のみ (契約 13、ADR-0021)
      return onValue(
        ref(db, `${snapshotPath(key)}/fence`),
        (snap) => {
          const value = snap.val() as Partial<SnapshotFence> | null
          if (
            typeof value?.epoch === 'number' &&
            typeof value.appliedSeq === 'number'
          ) {
            handler({ epoch: value.epoch, appliedSeq: value.appliedSeq })
          }
        },
        (error) => {
          // fence 購読の喪失は sync 自体を止めない (persisted rule が timeout
          // drop に縮退するだけ) ため、onError 契約には載せず診断ログに留める
          console.error(error)
        },
      )
    },
  }
}
