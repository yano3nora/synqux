import { configureStore } from '@reduxjs/toolkit'
import { initializeApp } from 'firebase/app'
import { connectDatabaseEmulator, getDatabase } from 'firebase/database'
import {
  createSynqux,
  createSynquxRootReducer,
  selectIsHost,
  selectPeers,
  selectSelfId,
  type PeerRole,
} from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import { counterReducer, isCounterAction } from './counter'

/**
 * synqux demo: firebase emulator 上で counter を端末間同期する
 *
 * 使い方は demo/README.md 参照。複数タブ (URL の ?role= で役割を変えられる) で
 * 開いて、+/- の反映・host 表示・タブを閉じたときの host migration を確認する
 */

// ---- firebase (emulator 固定。本物のプロジェクトには接続しない) ----
const app = initializeApp({
  projectId: 'synqux-demo',
  // SDK の初期化に URL 形式が必要なだけで、実接続は下の emulator へ向く
  databaseURL: 'https://synqux-demo-default-rtdb.firebaseio.com',
})
const db = getDatabase(app)
connectDatabaseEmulator(db, '127.0.0.1', 9000)

// ---- store 構築 (README の Getting Started と同じ形) ----
const params = new URLSearchParams(window.location.search)
const groupId = params.get('group') ?? 'demo-room'
const role = (params.get('role') ?? undefined) as PeerRole | undefined

const sync = createSynqux({
  transport: firebaseTransport(db),
  isSyncedAction: isCounterAction,
  ...createSynquxRootReducer({
    synced: { counter: counterReducer },
    locals: {},
  }),
})

const store = configureStore({
  reducer: sync.rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: { ignoredActionPaths: ['meta.root'] },
    }).prepend(...sync.middlewares),
})

// ---- UI (依存を増やさないため plain DOM。react を使う場合は synqux/react 参照) ----
const el = (id: string): HTMLElement => document.getElementById(id)!

el('group').textContent = groupId
el('role').textContent = role ?? 'player'

const render = (): void => {
  const state = store.getState()

  el('count').textContent = String(state.counter.count)
  el('self').textContent = selectSelfId(state) ?? '(接続中...)'
  el('host').textContent = selectIsHost(state) ? 'HOST 👑' : 'client'
  el('peers').innerHTML = selectPeers(state)
    .map(
      (peer) =>
        `<li>${peer.id}${peer.role ? ` <em>(${peer.role})</em>` : ''}</li>`,
    )
    .join('')

  // 判定結果は synced state を直読みする (SPEC-public-api の作法)
  const result = state.counter.result
  el('result').textContent =
    result && !result.console ? `${result.type}: ${result.message}` : ''
}

store.subscribe(render)
render()

el('add1').onclick = () => store.dispatch({ type: 'counter/add', payload: 1 })
el('add10').onclick = () => store.dispatch({ type: 'counter/add', payload: 10 })
el('sub1').onclick = () => store.dispatch({ type: 'counter/add', payload: -1 })
el('reset').onclick = () => store.dispatch({ type: 'counter/set', payload: 0 })

// ---- 同期開始 (presence 登録 → snapshot restore → requests 購読) ----
void sync
  .subscribe({ store, groupId, role })
  .then(() => {
    el('status').textContent = 'connected'
  })
  .catch((e: unknown) => {
    console.error(e)
    el('status').textContent =
      'emulator に接続できません。demo/README.md の手順で起動してください'
  })
