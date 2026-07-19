import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * firebase adapter の unit test (firebase SDK を全 mock、emulator 依存なし)
 *
 * 検証対象は「SDK をどう呼ぶか」= パス構成・sanitize・prevKey 正規化・
 * onDisconnect の登録順・ack セマンティクス。イベント配送を含む同期挙動の検証は
 * memory hub の simulation test が担う (実機検証はテンプレ置換とセットで行う)
 */

const h = vi.hoisted(() => {
  const refMock = vi.fn((_db: unknown, path?: string) => ({ path }))
  const pushKeys: string[] = []
  const connectedSubscriptions: {
    callback: (snap: { val: () => unknown }) => void
    unsubscribe: ReturnType<typeof vi.fn>
  }[] = []

  return {
    refMock,
    pushKeys,
    connectedSubscriptions,
    pushMock: vi.fn((target: { path?: string }, value?: unknown) => {
      const key = pushKeys.shift() ?? 'generated-key'
      return Object.assign(
        Promise.resolve({ key, path: `${target.path}/${key}`, value }),
        { key, path: `${target.path}/${key}` },
      )
    }),
    setMock: vi.fn(async (_target: unknown, _value: unknown) => undefined),
    updateMock: vi.fn(async (_target: unknown, _patch: unknown) => undefined),
    removeMock: vi.fn(async (_target: unknown) => undefined),
    getMock: vi.fn(
      async (
        _target: unknown,
      ): Promise<{ exists: () => boolean; val: () => unknown }> => ({
        exists: () => false,
        val: () => null,
      }),
    ),
    onValueMock: vi.fn(
      (
        target: { path?: string },
        callback: (snap: { val: () => unknown }) => void,
      ) => {
        // .info/connected と serverTimeOffset は即時に値を返す接続済み想定
        if (target.path === '.info/connected') {
          const unsubscribe = vi.fn()
          connectedSubscriptions.push({ callback, unsubscribe })
          callback({ val: () => true })
          return unsubscribe
        }
        if (target.path === '.info/serverTimeOffset') {
          callback({ val: () => 500 })
        }
        return () => undefined
      },
    ),
    onChildAddedMock: vi.fn(
      (_target: unknown, _callback: unknown) => () => undefined,
    ),
    onChildChangedMock: vi.fn(
      (_target: unknown, _callback: unknown) => () => undefined,
    ),
    onChildRemovedMock: vi.fn(
      (_target: unknown, _callback: unknown) => () => undefined,
    ),
    onDisconnectMock: vi.fn(() => ({
      remove: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    })),
    queryMock: vi.fn((target: unknown, ...constraints: unknown[]) => ({
      target,
      constraints,
    })),
    orderByKeyMock: vi.fn(() => 'orderByKey'),
    orderByChildMock: vi.fn((path: string) => `orderByChild:${path}`),
    startAfterMock: vi.fn((value: string) => `startAfter:${value}`),
    endBeforeMock: vi.fn((value: number) => `endBefore:${value.toString()}`),
    serverTimestampMock: vi.fn(() => ({ '.sv': 'timestamp' })),
  }
})

vi.mock('firebase/database', () => ({
  ref: h.refMock,
  push: h.pushMock,
  set: h.setMock,
  update: h.updateMock,
  remove: h.removeMock,
  get: h.getMock,
  onValue: h.onValueMock,
  onChildAdded: h.onChildAddedMock,
  onChildChanged: h.onChildChangedMock,
  onChildRemoved: h.onChildRemovedMock,
  onDisconnect: h.onDisconnectMock,
  query: h.queryMock,
  orderByKey: h.orderByKeyMock,
  orderByChild: h.orderByChildMock,
  startAfter: h.startAfterMock,
  endBefore: h.endBeforeMock,
  serverTimestamp: h.serverTimestampMock,
}))

import { SYNQUX_SCHEMA_VERSION, type RequestEnvelope } from '../core/types.js'
import { firebaseTransport } from './index.js'

const DB = { app: 'stub' } as never
const GROUP_ID = 'game-1'

const connect = async (options?: { archivePrunedRequests?: boolean }) => {
  const transport = firebaseTransport(DB, options)
  const { selfId } = await transport.connect({
    groupId: GROUP_ID,
    role: 'player',
  })
  return { transport, selfId }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.pushKeys.length = 0
  h.connectedSubscriptions.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('firebaseTransport', () => {
  it('connect: onDisconnect の削除登録を set より先に行い、push key を selfId として返す', async () => {
    h.pushKeys.push('conn-abc')
    const { selfId } = await connect()

    expect(selfId).toBe('conn-abc')

    // presence cleanup (契約 5) が書き込みより先に仕込まれている
    const disconnectOrder = h.onDisconnectMock.mock.invocationCallOrder[0]!
    const setOrder = h.setMock.mock.invocationCallOrder[0]!
    expect(disconnectOrder).toBeLessThan(setOrder)

    // 書き込み内容: サーバ採番 timestamp、undefined は null 化
    const [, value] = h.setMock.mock.calls[0] as unknown as [
      unknown,
      { id: string; groupId: string; role: string; label: null },
    ]
    expect(value.id).toBe('conn-abc')
    expect(value.groupId).toBe(GROUP_ID)
    expect(value.role).toBe('player')
    expect(value.label).toBeNull()
  })

  it('connect: 切断後の復帰で onDisconnect を先に再登録し、初回 connected 値のまま presence を復元する', async () => {
    h.pushKeys.push('conn-1')
    h.getMock.mockResolvedValueOnce({
      exists: () => true,
      val: () => ({ connected: 123_456 }),
    })
    await connect()

    const watcher = h.connectedSubscriptions.at(-1)!
    watcher.callback({ val: () => false })
    watcher.callback({ val: () => true })

    await vi.waitFor(() => expect(h.setMock).toHaveBeenCalledTimes(2))

    const disconnectOrder = h.onDisconnectMock.mock.invocationCallOrder[1]!
    const setOrder = h.setMock.mock.invocationCallOrder[1]!
    expect(disconnectOrder).toBeLessThan(setOrder)
    expect(h.setMock.mock.calls[1]?.[1]).toEqual({
      id: 'conn-1',
      groupId: GROUP_ID,
      connected: 123_456,
      role: 'player',
      label: null,
    })
    expect(h.serverTimestampMock).toHaveBeenCalledTimes(1)
  })

  it('connect: watcher の初回 true では presence を二重登録しない', async () => {
    h.pushKeys.push('conn-1')

    await connect()

    expect(h.setMock).toHaveBeenCalledTimes(1)
    expect(h.onDisconnectMock).toHaveBeenCalledTimes(1)
  })

  it('disconnect: watcher を先に解除し、その後の切断・復帰では再登録しない', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()
    const watcher = h.connectedSubscriptions.at(-1)!

    await transport.disconnect()
    watcher.callback({ val: () => false })
    watcher.callback({ val: () => true })
    await Promise.resolve()

    expect(watcher.unsubscribe).toHaveBeenCalledTimes(1)
    expect(watcher.unsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
      h.removeMock.mock.invocationCallOrder[0]!,
    )
    expect(h.setMock).toHaveBeenCalledTimes(1)
  })

  it('connect: presence 再登録失敗を報告し、次の再接続サイクルで再試行する', async () => {
    h.pushKeys.push('conn-1')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await connect()
    const watcher = h.connectedSubscriptions.at(-1)!
    h.setMock.mockRejectedValueOnce(new Error('reregistration failed'))

    watcher.callback({ val: () => false })
    watcher.callback({ val: () => true })

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1))
    expect(h.setMock).toHaveBeenCalledTimes(2)

    watcher.callback({ val: () => false })
    watcher.callback({ val: () => true })

    await vi.waitFor(() => expect(h.setMock).toHaveBeenCalledTimes(3))
    expect(consoleError).toHaveBeenCalledWith(
      'Firebase presence re-registration failed',
      expect.any(Error),
    )
  })

  it('connect 前のメソッド呼び出しは throw する', async () => {
    const transport = firebaseTransport(DB)

    await expect(
      transport.pushRequest({} as Omit<RequestEnvelope, 'id'>),
    ).rejects.toThrow('not connected')
    expect(() =>
      transport.subscribeRequests(
        {},
        { onAdded: () => undefined, onChanged: () => undefined },
      ),
    ).toThrow('not connected')
    await expect(transport.loadSnapshot('k')).rejects.toThrow('not connected')
  })

  it('serverNow: .info/serverTimeOffset の補正値を加算して返す', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)

    const transport = firebaseTransport(DB)
    await expect(transport.serverNow()).resolves.toBe(1_000_500)
    // 2 回目は cache から (onValue は 1 回だけ)
    await expect(transport.serverNow()).resolves.toBe(1_000_500)
    expect(
      h.onValueMock.mock.calls.filter(
        ([target]) =>
          (target as { path?: string }).path === '.info/serverTimeOffset',
      ),
    ).toHaveLength(1)

    vi.useRealTimers()
  })

  it('pushRequest: requests/{groupId} へ undefined キーを除去して push する', async () => {
    h.pushKeys.push('conn-1', 'req-1')
    const { transport } = await connect()

    const { id } = await transport.pushRequest({
      v: SYNQUX_SCHEMA_VERSION,
      groupId: GROUP_ID,
      requested: 1,
      requestedBy: 'conn-1',
      action: {
        type: 'game/test',
        payload: '{"a":1}',
        meta: { requestedBy: 'conn-1', hash: 'h', root: undefined },
      },
    })

    expect(id).toBe('req-1')
    const [target, value] = h.pushMock.mock.calls[1] as unknown as [
      { path: string },
      { action: { meta: object } },
    ]
    expect(target.path).toBe(`requests/${GROUP_ID}`)
    // undefined を含むと firebase が throw するため書き込み前に除去されている
    expect('root' in value.action.meta).toBe(false)
  })

  it('respondRequest: requests/{groupId}/{id} へ (epoch, seq) patch を update する (null はキー削除として渡す)', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()

    await transport.respondRequest('req-9', {
      epoch: 1,
      seq: 5,
      responsedBy: 'conn-1',
      responsed: 1,
      result: null,
    })

    const [target, patch] = h.updateMock.mock.calls[0] as unknown as [
      { path: string },
      Record<string, unknown>,
    ]
    expect(target.path).toBe(`requests/${GROUP_ID}/req-9`)
    expect(patch).toEqual({
      epoch: 1,
      seq: 5,
      responsedBy: 'conn-1',
      responsed: 1,
      result: null,
    })
  })

  it('subscribeRequests: after 指定時のみ startAfter クエリを構成する', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()
    const handlers = { onAdded: vi.fn(), onChanged: vi.fn() }

    transport.subscribeRequests({}, handlers)
    expect(h.queryMock.mock.calls[0]?.slice(1)).toEqual(['orderByKey'])

    transport.subscribeRequests({ after: 'req-5' }, handlers)
    expect(h.queryMock.mock.calls[1]?.slice(1)).toEqual([
      'orderByKey',
      'startAfter:req-5',
    ])
    expect(h.startAfterMock).toHaveBeenCalledWith('req-5')
  })

  it('subscribeRequests: snap.key を id に焼き込んで届ける', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()
    const handlers = { onAdded: vi.fn(), onChanged: vi.fn() }

    transport.subscribeRequests({}, handlers)

    // firebase の onChildAdded callback を直接呼んで受信を模擬する
    const addedCallback = h.onChildAddedMock.mock
      .calls[0]?.[1] as unknown as (snap: {
      key: string
      val: () => unknown
    }) => void
    addedCallback({ key: 'req-1', val: () => ({ v: 2, groupId: GROUP_ID }) })

    expect(handlers.onAdded).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'req-1' }),
    )
  })

  it('pruneRequests: archive off (既定) で seq なしを除外し、閾値未満だけを削除する', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()
    h.getMock.mockResolvedValueOnce({
      exists: () => true,
      val: () => null,
      forEach: (
        callback: (snap: { key: string; val: () => unknown }) => void,
      ) => {
        callback({ key: 'pending', val: () => ({ requestedBy: 'peer' }) })
        callback({ key: 'old', val: () => ({ seq: 4 }) })
        callback({ key: 'boundary', val: () => ({ seq: 5 }) })
        return false
      },
    } as never)

    await transport.pruneRequests!(5)

    expect(h.queryMock.mock.calls.at(-1)?.slice(1)).toEqual([
      'orderByChild:seq',
      'endBefore:5',
    ])
    expect(h.updateMock).toHaveBeenCalledTimes(1)
    expect(h.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: `requests/${GROUP_ID}` }),
      { old: null },
    )
  })

  it('pruneRequests: archive on で requests から logs へ root-level update 1 回で退避する', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect({ archivePrunedRequests: true })
    const oldEnvelope = { seq: 4, action: { type: 'game/old' } }
    h.getMock.mockResolvedValueOnce({
      exists: () => true,
      val: () => null,
      forEach: (
        callback: (snap: { key: string; val: () => unknown }) => void,
      ) => {
        callback({ key: 'pending', val: () => ({ requestedBy: 'peer' }) })
        callback({ key: 'old', val: () => oldEnvelope })
        callback({ key: 'boundary', val: () => ({ seq: 5 }) })
        return false
      },
    } as never)

    await transport.pruneRequests!(5)

    expect(h.updateMock).toHaveBeenCalledTimes(1)
    expect(h.updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: undefined }),
      {
        [`requests/${GROUP_ID}/old`]: null,
        [`logs/${GROUP_ID}/old`]: oldEnvelope,
      },
    )
  })

  it('pruneRequests: 対象が無いときは update を呼ばない', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect({ archivePrunedRequests: true })
    h.getMock.mockResolvedValueOnce({
      exists: () => true,
      val: () => null,
      forEach: (
        callback: (snap: { key: string; val: () => unknown }) => void,
      ) => {
        callback({ key: 'pending', val: () => ({ requestedBy: 'peer' }) })
        callback({ key: 'boundary', val: () => ({ seq: 5 }) })
        return false
      },
    } as never)

    await transport.pruneRequests!(5)

    expect(h.updateMock).not.toHaveBeenCalled()
  })

  it('saveSnapshot / loadSnapshot: games/{key} に不透明文字列をそのまま読み書きする', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()

    await transport.saveSnapshot(GROUP_ID, '{"v":1}')
    const [target, payload] = h.setMock.mock.calls[1] as unknown as [
      { path: string },
      string,
    ]
    expect(target.path).toBe(`games/${GROUP_ID}`)
    expect(payload).toBe('{"v":1}')

    h.getMock.mockResolvedValueOnce({
      exists: () => true,
      val: () => '{"v":1}',
    })
    await expect(transport.loadSnapshot(GROUP_ID)).resolves.toBe('{"v":1}')
    await expect(transport.loadSnapshot(GROUP_ID)).resolves.toBeNull()
  })

  it('disconnect: presence record を削除して onDisconnect を解除する', async () => {
    h.pushKeys.push('conn-1')
    const { transport } = await connect()

    await transport.disconnect()

    expect(h.removeMock).toHaveBeenCalledTimes(1)
    expect(h.removeMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: `connections/${GROUP_ID}/conn-1` }),
    )

    // 切断後の再利用は不可
    await expect(transport.loadSnapshot('k')).rejects.toThrow('not connected')
  })
})
