import { configureStore, type Action, type Reducer } from '@reduxjs/toolkit'
import { initializeApp } from 'firebase/app'
import { connectDatabaseEmulator, getDatabase } from 'firebase/database'
import {
  createSynqux,
  createSynquxRootReducer,
  selectIsHost,
  selectPeers,
  selectSelfId,
  stateWithDefaultResult,
  type PeerRole,
  type SynquxSynced,
} from 'synqux'
import { firebaseTransport } from 'synqux/firebase'
import {
  counterInitialState,
  counterReducer,
  isCounterAction,
  type CounterAction,
  type CounterState,
} from './counter'
import {
  isLedgerAction,
  ledgerInitialState,
  ledgerReducer,
  type LedgerAction,
  type LedgerState,
} from './ledger'
import { createRig } from './rig'

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
const roleParam = params.get('role')
// query は型境界の外なので、旧値や typo を PeerRole へ cast せず既定値へ戻す。
const role: PeerRole | undefined =
  roleParam === 'player' || roleParam === 'dedicated' || roleParam === 'guest'
    ? roleParam
    : undefined
const stormTotal = Number(params.get('storm'))

type DemoAction = CounterAction | LedgerAction
type DemoState = SynquxSynced<DemoAction> & {
  counter: CounterState
  ledger: LedgerState
}

const demoInitialState: DemoState = {
  result: null,
  counter: counterInitialState,
  ledger: ledgerInitialState,
}

/**
 * createSynquxRootReducer v1 の「synced slice は1個」制約に合わせた合成 reducer。
 * 対象 reducer の result を top-level に写し、host の成否判定を一箇所に保つ。
 */
const demoReducer: Reducer<DemoState> = (state = demoInitialState, action) => {
  if (isCounterAction(action)) {
    const counter = counterReducer(
      stateWithDefaultResult(state.counter, action),
      action,
    )
    return { ...state, result: counter.result, counter }
  }

  if (isLedgerAction(action)) {
    const ledger = ledgerReducer(
      stateWithDefaultResult(state.ledger, action),
      action,
    )
    return { ...state, result: ledger.result, ledger }
  }

  return state
}

const isSyncedAction = (action: Action): action is DemoAction =>
  isCounterAction(action) || isLedgerAction(action)

const synqux = createSynqux({
  transport: firebaseTransport(db, { archivePrunedRequests: true }),
  ...createSynquxRootReducer({
    isSyncedAction,
    synced: { demo: demoReducer },
    locals: {},
  }),
})

// TASK-260812 Phase A-2 の計測 rig (`?rig=1` で有効)。middleware は synqux より
// 前段に置き、transport 由来の内部 action 到着をタブ視点で記録する
const rig = createRig(params)

const store = configureStore({
  reducer: synqux.rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: { ignoredActionPaths: ['meta.root'] },
    }).prepend(...(rig ? [rig.middleware] : []), ...synqux.middlewares),
})

// ---- UI (依存を増やさないため plain DOM。react を使う場合は synqux/react 参照) ----
const el = (id: string): HTMLElement => document.getElementById(id)!

let stormRunning = false
let stormSent = 0
let appendSequence = 0
let nextLock = true

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

/**
 * 複数タブから request をばらけさせて送る。再入を防ぎ、1 storm 内の送信数を
 * total に固定することで、画面の sent から各タブの完走も確認できるようにする。
 */
const startStorm = (total: number): void => {
  if (stormRunning || !Number.isInteger(total) || total <= 0) {
    return
  }

  stormRunning = true

  void (async () => {
    try {
      for (let index = 0; index < total; index += 1) {
        await sleep(25 + Math.random() * 125)

        if (Math.random() < 0.1) {
          store.dispatch({
            type: 'ledger/setLocked',
            payload: nextLock,
          })
          nextLock = !nextLock
        } else {
          appendSequence += 1
          store.dispatch({
            type: 'ledger/append',
            payload: {
              by: selectSelfId(store.getState()) ?? 'anon',
              n: appendSequence,
            },
          })
        }

        stormSent += 1
        render()
      }
    } finally {
      stormRunning = false
    }
  })()
}

el('group').textContent = groupId
el('role').textContent = role ?? 'player'

const render = (): void => {
  const state = store.getState()

  el('count').textContent = String(state.demo.counter.count)
  el('ledger-count').textContent = String(state.demo.ledger.count)
  el('ledger-hash').textContent = state.demo.ledger.hash.slice(0, 8)
  el('ledger-locked').textContent = String(state.demo.ledger.locked)
  el('ledger-sent').textContent = String(stormSent)
  el('self').textContent = selectSelfId(state) ?? '(接続中...)'
  el('host').textContent = selectIsHost(state) ? 'HOST 👑' : 'client'
  const peers = selectPeers(state)
  const self = peers.find((peer) => peer.id === selectSelfId(state))
  el('role').textContent = self?.role ?? 'player'
  el('peers').innerHTML = peers
    .map(
      (peer) =>
        `<li>${peer.id}${peer.role ? ` <em>(${peer.role})</em>` : ''}</li>`,
    )
    .join('')

  // 判定結果は synced state を直読みする (SPEC-public-api の作法)。
  // message は UI 表示想定データ (ADR-0008)。log 専用の result はここに出さない
  const result = state.demo.result
  el('result').textContent = result?.message
    ? `${result.type}: ${result.message.text}`
    : ''

  const ledgerResult = state.demo.ledger.result
  el('ledger-result').textContent = ledgerResult?.message
    ? `${ledgerResult.type}: ${ledgerResult.message.text}`
    : ''
}

store.subscribe(render)
render()

el('add1').onclick = () => store.dispatch({ type: 'counter/add', payload: 1 })
el('add10').onclick = () => store.dispatch({ type: 'counter/add', payload: 10 })
el('sub1').onclick = () => store.dispatch({ type: 'counter/add', payload: -1 })
el('reset').onclick = () => store.dispatch({ type: 'counter/set', payload: 0 })
el('storm50').onclick = () => startStorm(50)
el('storm200').onclick = () => startStorm(200)
el('lock-toggle').onclick = () =>
  store.dispatch({
    type: 'ledger/setLocked',
    payload: !store.getState().demo.ledger.locked,
  })

const setRole = async (nextRole: PeerRole): Promise<void> => {
  try {
    await synqux.setRole(nextRole)
  } catch (error) {
    console.error(error)
    el('status').textContent = 'role の変更に失敗しました'
  }
}
el('role-guest').onclick = () => void setRole('guest')
el('role-player').onclick = () => void setRole('player')

// ---- 同期開始 (presence 登録 → snapshot restore → requests 購読) ----
// 非 React consumer は instance を手続きで直接購読し、失敗 UX もここで扱う。
void synqux
  .subscribe({
    store,
    groupId,
    role,
    signal: AbortSignal.timeout(30_000),
  })
  .then(() => {
    el('status').textContent = 'connected'

    // rig の計測開始も probe の request 生成を含むため subscribe 後に置く
    rig?.start({
      db,
      groupId,
      getSelfId: () => selectSelfId(store.getState()),
      getIsHost: () => selectIsHost(store.getState()),
      getPeersDigest: () =>
        selectPeers(store.getState())
          .map((peer) => `${peer.id}:${peer.role ?? 'player'}`)
          .join(','),
      dispatchAndWait: (action, options) =>
        synqux.dispatchAndWait(action as DemoAction, options),
    })

    // URL 指定は subscribe 後に開始し、未接続時の request 生成を避ける。
    if (Number.isInteger(stormTotal) && stormTotal > 0) {
      startStorm(stormTotal)
    }
  })
  .catch((error: unknown) => {
    console.error(error)
    el('status').textContent =
      'emulator に接続できません。demo/README.md の手順で起動してください'
  })
