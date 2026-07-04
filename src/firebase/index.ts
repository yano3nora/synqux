import {
  get,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onDisconnect,
  onValue,
  orderByKey,
  push,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  startAfter,
  update,
  type Database,
  type Query,
} from 'firebase/database'
import { sleepTimer } from '@yano3nora/ts-utils'
import type { Peer, RequestEnvelope, SynquxTransport } from '../core/types.js'

/**
 * Firebase Realtime Database の transport adapter (ADR-0001 Decision 2)
 *
 * データ配置は移植元テンプレートと同一:
 * - `connections/{groupId}/{peerId}` — presence (onDisconnect で自動削除)
 * - `requests/{groupId}/{requestId}` — request 封筒 (push id 採番 = 挿入順辞書順)
 * - `games/{groupId}` — snapshot (canonical JSON 文字列)
 *
 * 前提: firebase auth (匿名認証等) は consumer が transport 生成前に済ませること。
 * at-least-once の吸収 (重複・遅延・振り分け) は core の責務のため、この adapter は
 * 観測したイベントを素朴に流すだけでよい (SynquxTransport 契約 3)
 */
export const firebaseTransport = (db: Database): SynquxTransport => {
  // 接続セッション。connect() 成功後に確定し、disconnect() で破棄する
  let session: {
    groupId: string
    selfId: string
  } | null = null

  // .info/serverTimeOffset の補正値。インスタンス内に cache する (module 変数禁止)
  let serverTimeOffset: number | null = null

  const requireSession = (): { groupId: string; selfId: string } => {
    if (!session) {
      throw new Error('Firebase transport is not connected')
    }
    return session
  }

  const connectionsPath = (groupId: string) => `connections/${groupId}`
  const requestsPath = (groupId: string) => `requests/${groupId}`
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
    async connect({ groupId, role, label }) {
      if (session) {
        throw new Error('Firebase transport is already connected')
      }

      // presence 検知の前提となる db 接続の確立を待つ
      // https://firebase.google.com/docs/database/web/offline-capabilities
      let connected: boolean | null = null
      onValue(
        ref(db, '.info/connected'),
        (snap) => {
          connected = snap.val() === true
        },
        { onlyOnce: true },
      )
      while (connected !== true) {
        await sleepTimer(100)
      }

      const selfRef = push(ref(db, connectionsPath(groupId)))
      const selfId = selfRef.key!

      // 切断時 (プロセス死・ネットワーク断含む) の自動削除を登録してから書き込む
      // (SynquxTransport 契約 5: presence cleanup の保証)
      await onDisconnect(selfRef).remove()
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

      session = { groupId, selfId }
      return { selfId }
    },

    async disconnect() {
      const { groupId, selfId } = requireSession()
      const selfRef = ref(db, `${connectionsPath(groupId)}/${selfId}`)

      await remove(selfRef)
      await onDisconnect(selfRef).cancel()
      session = null
    },

    async serverNow() {
      if (serverTimeOffset !== null) {
        return Date.now() + serverTimeOffset
      }

      onValue(
        ref(db, '.info/serverTimeOffset'),
        (snap) => {
          serverTimeOffset = Number(snap.val()) || 0
        },
        { onlyOnce: true },
      )

      while (serverTimeOffset === null) {
        await sleepTimer(100)
      }

      return Date.now() + serverTimeOffset
    },

    subscribePeers(handlers) {
      const { groupId } = requireSession()
      const connectionsRef = ref(db, connectionsPath(groupId))

      // 購読開始時、既存 peer は firebase の仕様どおり onChildAdded で一括配送される
      const unsubs = [
        onChildAdded(connectionsRef, (snap) => {
          handlers.onAdded(snap.val() as Peer)
        }),
        onChildChanged(connectionsRef, (snap) => {
          handlers.onChanged(snap.val() as Peer)
        }),
        onChildRemoved(connectionsRef, (snap) => {
          handlers.onRemoved(snap.val() as Peer)
        }),
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

      // update の null 値はキー削除として働く (result: null / prev: null)。
      // 受信側 (core) は prev ?? null で吸収するため削除でよい
      // resolve はサーバ ack (契約 2)。local echo の onChildChanged が先に届く
      await update(ref(db, `${requestsPath(groupId)}/${id}`), {
        prev: patch.prev,
        responsedBy: patch.responsedBy,
        result: patch.result,
      })
    },

    subscribeRequests({ after }, handlers) {
      const { groupId } = requireSession()
      const target = requestsQuery(groupId, after)

      const unsubs = [
        // 購読開始時の既存分も onChildAdded で id 順に一括配送される。
        // prevChildKey は「クエリ結果集合内での直前 key、先頭は null」で
        // startAfter 使用時に実際の直前 request があっても null になる —
        // SynquxTransport 契約 (subscribeRequests) はこの firebase 挙動が原型
        onChildAdded(target, (snap, prevChildKey) => {
          handlers.onAdded(
            toEnvelope(snap.val(), snap.key),
            prevChildKey ?? null,
          )
        }),
        onChildChanged(target, (snap) => {
          handlers.onChanged(toEnvelope(snap.val(), snap.key))
        }),
      ]

      return () => unsubs.forEach((unsub) => unsub())
    },

    async saveSnapshot(key, payload) {
      requireSession()
      // payload は core が直列化済みの不透明文字列 (Decision 11)。
      // 文字列 1 本で set するため RTDB の形状保存問題 (undefined 落ち等) が起きない
      await set(ref(db, snapshotPath(key)), payload)
    },

    async loadSnapshot(key) {
      requireSession()
      const snap = await get(ref(db, snapshotPath(key)))
      return snap.exists() ? (snap.val() as string) : null
    },
  }
}
