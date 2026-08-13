import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createWaker } from './create-synqux.js'
import { selectIsHost } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameState,
} from './test-fixtures.js'
import type { SnapshotStore } from './types.js'

/**
 * createSynqux の end-to-end 検証 (primitive 方式の rootReducer を手書き)
 * request 化 → host 判定 → 全端末適用 → snapshot → restore の背骨を
 * memory hub + fake timers の決定的 simulation で確認する
 */

const GROUP_ID = 'group-a'

describe('createSynqux (end-to-end)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('synced action が request 化され、host の裁定順で全端末に 1 回ずつ適用される', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    // 最新接続の player = b が host
    expect(selectIsHost(a.store.getState())).toBe(false)
    expect(selectIsHost(b.store.getState())).toBe(true)

    a.store.dispatch({ type: 'game/increment', payload: 1 })

    // 楽観更新しない: request 化された action はローカル適用されない
    expect(a.store.getState().game.count).toBe(0)

    await settle()

    expect(a.store.getState().game.count).toBe(1)
    expect(b.store.getState().game.count).toBe(1)
    expect(a.store.getState().game.log).toEqual(['increment:1'])
    expect(b.store.getState().game.log).toEqual(['increment:1'])

    // 裁定は host (b) が行い、(epoch, seq) が焼き込まれている
    const requests = hub.inspect.requests(GROUP_ID)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.responsedBy).toBeDefined()
    expect(requests[0]?.epoch).toBe(1)
    expect(requests[0]?.seq).toBe(1)

    // 受理 request ごとに snapshot が永続化される (ordering はカウンタ + 直近窓)
    const snapshot = parseSnapshotPayload(hub.inspect.snapshot(GROUP_ID)!)
    expect((snapshot.synced as GameState).count).toBe(1)
    expect(snapshot.ordering.appliedSeq).toBe(1)
    expect(snapshot.ordering.applied[1]).toBe(requests[0]?.id)
  })

  it('複数端末の同時 dispatch でも全端末の適用順が host 基準で一致する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch({ type: 'game/increment', payload: 1 })
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    a.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(60)

    const logA = a.store.getState().game.log
    const logB = b.store.getState().game.log
    expect(a.store.getState().game.count).toBe(111)
    expect(b.store.getState().game.count).toBe(111)
    expect(logA).toHaveLength(3)
    expect(logA).toEqual(logB) // 適用順序の全端末一致 (不変条件 3)
  })

  it('log 専用の validation エラー (message なし) の request は dispatch されず console へ流れる', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch({ type: 'game/forbidden' })
    await settle()

    // 全端末で state は不変のまま、拒否は revisions に記録され進行は継続する
    expect(a.store.getState().game.count).toBe(0)
    expect(a.store.getState().game.log).toEqual([])
    expect(b.store.getState().game.log).toEqual([])

    // log は targets 準拠: 依頼元 (a) の 1 回だけで、b では出力されない
    expect(
      consoleError.mock.calls.filter((call) => call[0] === 'forbidden'),
    ).toHaveLength(1)

    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    expect(a.store.getState().game.count).toBe(1)
    expect(b.store.getState().game.count).toBe(1)

    consoleError.mockRestore()
  })

  it('message ありの result は dispatch され、log は各端末で synqux が console へ出力する', async () => {
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch({ type: 'game/announce' })
    await settle()

    // message ありなので dispatch され、全端末に result (UI 表示データ) が届く
    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])
    expect(a.store.getState().game.result?.message?.text).toBe('announced')

    // log は targets 準拠 (空 = 無条件) で各端末の適用時に 1 回ずつ出力される
    const announceLogs = consoleLog.mock.calls.filter(
      (call) => call[0] === 'announce applied',
    )
    expect(announceLogs).toHaveLength(2)

    consoleLog.mockRestore()
  })

  it('changed の重複配送でも適用・log 出力は二重にならない (at-least-once 吸収)', async () => {
    const consoleLog = vi
      .spyOn(console, 'log')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    // 最初の request (id は hub の採番順で決定的) の changed を全端末へ 2 回届ける
    hub.faults.duplicate({ requestId: '000000000001', event: 'changed' })
    a.store.dispatch({ type: 'game/announce' })
    await settle()

    expect(a.store.getState().game.log).toEqual(['announce'])
    expect(b.store.getState().game.log).toEqual(['announce'])
    expect(
      consoleLog.mock.calls.filter((call) => call[0] === 'announce applied'),
    ).toHaveLength(2)

    consoleLog.mockRestore()
  })

  it('途中参加端末は snapshot から restore し、以降の requests だけで追いつく', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()

    // 2 request 処理済みの状態で c が途中参加する
    const c = createHubClient(hub)
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle()

    expect(c.store.getState().game.count).toBe(11)
    expect(c.store.getState().game.log).toEqual(['increment:1', 'increment:10'])

    // 最新接続の player となった c が host を引き継ぎ、以降も同期が継続する
    expect(selectIsHost(c.store.getState())).toBe(true)
    a.store.dispatch({ type: 'game/increment', payload: 100 })
    await settle(60)

    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(111)
    }
  })

  it('standalone (enabled=false) は即時ローカル適用し、localSnapshots で復元できる', async () => {
    const saved = new Map<string, string>()
    const localSnapshots: SnapshotStore = {
      saveSnapshot: (key, payload) => {
        saved.set(key, payload)
        return true
      },
      loadSnapshot: (key) => saved.get(key) ?? null,
    }

    const hub = createMemoryHub()
    const first = createHubClient(hub, { enabled: false, localSnapshots })
    await first.sync.subscribe({ store: first.store, groupId: 'solo' })

    // standalone は常に host 扱いで、request 化せず即時に適用される
    expect(selectIsHost(first.store.getState())).toBe(true)
    first.store.dispatch({ type: 'game/increment', payload: 1 })
    first.store.dispatch({ type: 'game/increment', payload: 10 })
    expect(first.store.getState().game.count).toBe(11)
    expect(saved.has('solo')).toBe(true)

    // リロード相当: 新しい store + instance が localSnapshots から復元する
    const second = createHubClient(hub, { enabled: false, localSnapshots })
    await second.sync.subscribe({ store: second.store, groupId: 'solo' })
    expect(second.store.getState().game.count).toBe(11)
    expect(second.store.getState().game.result).toBeNull()
  })

  it('購読 phase は実遷移ごとに一度だけ通知し、unsubscribe で idle を通知する', async () => {
    const onPhaseChanged = vi.fn()
    const client = createHubClient(createMemoryHub(), { onPhaseChanged })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: 'phase-callback',
    })
    expect(onPhaseChanged.mock.calls).toEqual([['subscribing'], ['live']])

    await unsubscribe()
    expect(onPhaseChanged.mock.calls).toEqual([
      ['subscribing'],
      ['live'],
      ['idle'],
    ])
  })

  it('subscribe 失敗は rollback 後に元 error 付きで onSubscribeFailed へ一度通知する', async () => {
    const failure = new Error('offline')
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    transport.connect = async () => {
      throw failure
    }
    const onSubscribeFailed = vi.fn()
    const client = createClient(transport, { onSubscribeFailed })

    await expect(
      client.sync.subscribe({ store: client.store, groupId: 'failed' }),
    ).rejects.toBe(failure)
    expect(client.store.getState().synqux.phase).toBe('idle')
    expect(onSubscribeFailed).toHaveBeenCalledOnce()
    expect(onSubscribeFailed).toHaveBeenCalledWith(failure)
  })

  it('subscribe 成功時は onSubscribeFailed を呼ばない', async () => {
    const onSubscribeFailed = vi.fn()
    const client = createHubClient(createMemoryHub(), { onSubscribeFailed })

    await client.sync.subscribe({
      store: client.store,
      groupId: 'subscribe-success',
    })

    expect(onSubscribeFailed).not.toHaveBeenCalled()
  })

  it('onSubscribeFailed が throw しても subscribe は元 error で reject する', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const failure = new Error('offline')
    const callbackFailure = new Error('callback failed')
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    transport.connect = async () => {
      throw failure
    }
    const onSubscribeFailed = vi.fn(() => {
      throw callbackFailure
    })
    const client = createClient(transport, { onSubscribeFailed })

    await expect(
      client.sync.subscribe({ store: client.store, groupId: 'callback-throw' }),
    ).rejects.toBe(failure)
    expect(onSubscribeFailed).toHaveBeenCalledOnce()
    expect(consoleError).toHaveBeenCalledWith(callbackFailure)
    consoleError.mockRestore()
  })

  it('onSubscribeFailed 未設定の subscribe 失敗は沈黙端末の警告を出す', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const failure = new Error('offline')
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    transport.connect = async () => {
      throw failure
    }
    const client = createClient(transport)

    await expect(
      client.sync.subscribe({ store: client.store, groupId: 'unconfigured' }),
    ).rejects.toBe(failure)
    expect(consoleError).toHaveBeenCalledWith(
      '[synqux] subscribe failed and no onSubscribeFailed is configured. The device may be left silently unconnected.',
      failure,
    )
    consoleError.mockRestore()
  })

  it('setRole は未 subscribe なら拒否し、standalone session では no-op になる', async () => {
    const hub = createMemoryHub()
    const synced = createHubClient(hub)

    await expect(synced.sync.setRole('guest')).rejects.toThrow(
      'synqux is not subscribed. Call subscribe() before setRole().',
    )

    const standalone = createHubClient(hub, { enabled: false })
    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'solo-role',
      role: 'guest',
    })

    await expect(standalone.sync.setRole('player')).resolves.toBeUndefined()
    expect(hub.inspect.peers('solo-role')).toEqual([])
  })

  it('setRole は state 上の正規化済み role と同値なら no-op、異なれば更新する', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const updateSelf = vi.spyOn(transport, 'updateSelf')
    const client = createClient(transport)
    await client.sync.subscribe({
      store: client.store,
      groupId: 'role-idempotent',
    })
    await settle()

    // role 未指定 peer は player として扱うため、既定値への更新は不要。
    await client.sync.setRole('player')
    expect(updateSelf).not.toHaveBeenCalled()

    await client.sync.setRole('guest')
    expect(updateSelf).toHaveBeenCalledTimes(1)
    await settle()
    await client.sync.setRole('guest')
    expect(updateSelf).toHaveBeenCalledTimes(1)
  })

  it('setRole は自 peer が state に未反映なら比較せず transport を更新する', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    transport.subscribePeers = () => () => undefined
    const updateSelf = vi.spyOn(transport, 'updateSelf')
    const client = createClient(transport)
    await client.sync.subscribe({
      store: client.store,
      groupId: 'role-before-echo',
    })

    expect(client.store.getState().synqux.connections.entities).toEqual({})
    await client.sync.setRole('player')
    expect(updateSelf).toHaveBeenCalledWith({ role: 'player' })
  })
})

describe('createWaker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('notify は待機中の全 waiter を起こし、解放する', async () => {
    const waker = createWaker()
    const first = waker.wait(1000)
    const second = waker.wait(1000)
    expect(waker.waiterCount()).toBe(2)

    waker.notify()
    await Promise.all([first, second])
    expect(waker.waiterCount()).toBe(0)
  })

  it('timeout 済み waiter は次の notify を待たずに解放される (host 不在時の無限成長防止)', async () => {
    const waker = createWaker()

    // host 不在の fallback loop 相当: notify が一度も来ないまま
    // timeout → 再 wait を繰り返しても waiter が積み上がらないこと
    for (let i = 0; i < 100; i++) {
      const waiting = waker.wait(1000)
      await vi.advanceTimersByTimeAsync(1000)
      await waiting
    }

    expect(waker.waiterCount()).toBe(0)
  })
})
