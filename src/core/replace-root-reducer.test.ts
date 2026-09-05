import type { Reducer } from '@reduxjs/toolkit'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import {
  createHubClient,
  gameInitialState,
  rootReducer,
  settle,
  type GameAction,
  type GameState,
  type RootState,
} from './test-fixtures.js'
import type { RequestEnvelope } from './types.js'

/**
 * replaceRootReducer (TASK-260904): instance と store を生かしたまま判定器を
 * 差し替える口。dev の HMR で reducer module が再評価されたときに、裁定側
 * (host 試し実行) と適用側 (store) が同じ新 reducer を使うことを確認する
 */

const GROUP_ID = 'group-replace-root-reducer'

const resultType = (envelope: RequestEnvelope): string | undefined =>
  envelope.result === undefined
    ? undefined
    : (JSON.parse(envelope.result) as { type?: string }).type

/** 差し替え後の判定器 (1): increment を validation 失敗として拒否する */
const rejectIncrement: Reducer<RootState> = (state, action) => {
  const next = rootReducer(state, action)
  if (action.type !== 'game/increment') {
    return next
  }
  return {
    ...next,
    game: {
      ...(state?.game ?? gameInitialState),
      result: { action: action as GameAction, type: 'error', targets: [] },
    },
  }
}

/** 差し替え後の判定器 (2): increment の payload を 2 倍で適用する (挙動差の観測用) */
const doubleIncrement: Reducer<RootState> = (state, action) =>
  action.type === 'game/increment'
    ? rootReducer(state, {
        ...action,
        payload: ((action as { payload?: number }).payload ?? 1) * 2,
      })
    : rootReducer(state, action)

/** 差し替え後の判定器 (3): 初期 state が異なる (seed teardown の戻り先の観測用) */
const initialSeven: Reducer<RootState> = (state, action) =>
  rootReducer(
    state ?? {
      ...rootReducer(undefined, action),
      game: { ...gameInitialState, count: 7 },
    },
    action,
  )

describe('replaceRootReducer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('host が差し替えた判定器で以後の request を裁定する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    const [host, client] = selectIsHost(a.store.getState()) ? [a, b] : [b, a]
    host.sync.replaceRootReducer(rejectIncrement)

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // 旧判定器なら受理される action が、新判定器の validation で拒否される
    expect(resultType(hub.inspect.requests(GROUP_ID)[0]!)).toBe('error')
    expect(a.store.getState().game.count).toBe(0)
    expect(b.store.getState().game.count).toBe(0)

    // 拒否対象外の action は従来どおり受理・適用される
    client.store.dispatch({ type: 'game/announce' })
    await settle()
    expect(resultType(hub.inspect.requests(GROUP_ID)[1]!)).toBe('success')
    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])
  })

  it('echo を配線した store は replaceReducer なしで新 reducer を適用する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    const echo = a.sync.rootReducer
    a.sync.replaceRootReducer(doubleIncrement)
    b.sync.replaceRootReducer(doubleIncrement)

    // 差し替えは echo の参照を変えない (store.replaceReducer(synqux.rootReducer)
    // を呼んでも同じ関数が入り直るだけ)
    expect(a.sync.rootReducer).toBe(echo)
    expect(echo(undefined, { type: '@@probe' })).toEqual(
      doubleIncrement(undefined, { type: '@@probe' }),
    )

    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    // 適用側 (store) も新 reducer 由来の結果になる = 裁定と適用が同じ reducer
    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(a.store.getState().game.log).toEqual(['increment:2'])
  })

  it('host の試し実行済み・未適用の裁定がある間は差し替えを保留し、適用後に反映する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    const [host, client] = selectIsHost(a.store.getState()) ? [a, b] : [b, a]
    const hostId = host.store.getState().synqux.connections.selfId!

    // host への changed 配送だけ遅らせる: 試し実行 → respond → snapshot 保存まで
    // 進むが host 自身の適用は未完 (fork は生存) の窓を作る
    const delayedApply = hub.faults.delay({
      requestId: '000000000001',
      to: hostId,
      event: 'changed',
    })
    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(client.store.getState().game.count).toBe(1)
    expect(host.store.getState().game.count).toBe(0)

    // 窓の中で差し替えても反映は保留される (echo も旧判定器のまま)
    host.sync.replaceRootReducer(doubleIncrement)
    const probe = host.store.getState()
    expect(
      host.sync.rootReducer(probe, { type: 'game/increment', payload: 1 }).game
        .count,
    ).toBe(1)

    delayedApply.release()
    await settle()

    // 保留中の裁定は試し実行と同じ旧判定器で適用され、snapshot と一致する
    expect(host.store.getState().game.count).toBe(1)
    expect(
      (
        parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
          .synced as GameState
      ).count,
    ).toBe(1)

    // 捌けた時点で反映される
    expect(
      host.sync.rootReducer(probe, { type: 'game/increment', payload: 1 }).game
        .count,
    ).toBe(2)
  })

  it('standalone の seed teardown は差し替え後の reducer の初期 state へ戻す', async () => {
    const client = createHubClient(createMemoryHub())
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
      seedSynced: { result: null, count: 9, log: ['seeded'] },
    })
    expect(client.store.getState().game.count).toBe(9)

    client.sync.replaceRootReducer(initialSeven)
    await client.sync.unsubscribe()

    // seedProbe (reducer の初期 state 取得) も差し替え後の判定器を使う
    expect(client.store.getState().game).toEqual({
      ...gameInitialState,
      count: 7,
    })
  })
})
