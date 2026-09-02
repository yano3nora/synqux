import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import {
  createClient,
  createHubClient,
  settle,
  subscribeSettled,
} from './test-fixtures.js'
import type { SynquxTransport } from './types.js'

const GROUP_ID = 'group-channels'

type Cursor = { x: number; y?: number }

describe('channels (ADR-0028)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('synced: publish が他端末へ配送され、後からの購読にも既存 entry が届く', async () => {
    const hub = createMemoryHub()
    const clientA = createHubClient(hub)
    const clientB = createHubClient(hub)
    const unsubscribeA = await subscribeSettled(clientA, { groupId: GROUP_ID })
    const unsubscribeB = await subscribeSettled(clientB, { groupId: GROUP_ID })

    const cursorsA = clientA.sync.channel<Cursor>('cursors', {
      cleanup: 'disconnect',
      throttleMs: 0,
    })
    const cursorsB = clientB.sync.channel<Cursor>('cursors', {
      cleanup: 'disconnect',
      throttleMs: 0,
    })

    const changed = vi.fn()
    cursorsB.subscribe({ onChanged: changed, onRemoved: vi.fn() })

    const selfIdA = clientA.store.getState().synqux.connections.selfId!
    cursorsA.publish(selfIdA, { x: 1, y: 2 })
    await settle()

    expect(changed).toHaveBeenCalledWith(selfIdA, { x: 1, y: 2 })
    expect(hub.inspect.channel(GROUP_ID, 'cursors')).toEqual({
      [selfIdA]: JSON.stringify({ x: 1, y: 2 }),
    })

    // 後からの購読 (途中参加相当) にも既存 entry が一括配送される (契約 14)
    const late = vi.fn()
    cursorsA.subscribe({ onChanged: late, onRemoved: vi.fn() })
    await settle()
    expect(late).toHaveBeenCalledWith(selfIdA, { x: 1, y: 2 })

    await unsubscribeA()
    await unsubscribeB()
  })

  it('throttle: window 中の中間値を coalesce し、最終値を trailing で必ず配送する', async () => {
    const hub = createMemoryHub()
    const clientA = createHubClient(hub)
    const clientB = createHubClient(hub)
    const unsubscribeA = await subscribeSettled(clientA, { groupId: GROUP_ID })
    const unsubscribeB = await subscribeSettled(clientB, { groupId: GROUP_ID })

    const dragA = clientA.sync.channel<Cursor>('drag', { throttleMs: 100 })
    const dragB = clientB.sync.channel<Cursor>('drag', { throttleMs: 100 })
    const changed = vi.fn()
    dragB.subscribe({ onChanged: changed, onRemoved: vi.fn() })

    dragA.publish('block-1', { x: 0 })
    dragA.publish('block-1', { x: 1 })
    dragA.publish('block-1', { x: 2 })
    await vi.advanceTimersByTimeAsync(10)

    // leading のみ送信済み。中間値 x:1 は coalesce で消える
    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({
      'block-1': JSON.stringify({ x: 0 }),
    })

    await settle()
    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({
      'block-1': JSON.stringify({ x: 2 }),
    })
    expect(changed).toHaveBeenCalledWith('block-1', { x: 0 })
    expect(changed).toHaveBeenCalledWith('block-1', { x: 2 })
    expect(changed).not.toHaveBeenCalledWith('block-1', { x: 1 })

    await unsubscribeA()
    await unsubscribeB()
  })

  it("cleanup 'disconnect': publish 元のプロセス死で値が削除され onRemoved が配送される", async () => {
    const hub = createMemoryHub()
    const clientA = createHubClient(hub)
    const clientB = createHubClient(hub)
    await subscribeSettled(clientA, { groupId: GROUP_ID })
    const unsubscribeB = await subscribeSettled(clientB, { groupId: GROUP_ID })

    const cursorsA = clientA.sync.channel<Cursor>('cursors', {
      cleanup: 'disconnect',
      throttleMs: 0,
    })
    const cursorsB = clientB.sync.channel<Cursor>('cursors', {
      cleanup: 'disconnect',
      throttleMs: 0,
    })
    const removed = vi.fn()
    cursorsB.subscribe({ onChanged: vi.fn(), onRemoved: removed })

    const selfIdA = clientA.store.getState().synqux.connections.selfId!
    cursorsA.publish(selfIdA, { x: 1 })
    await settle()
    expect(hub.inspect.channel(GROUP_ID, 'cursors')).not.toEqual({})

    hub.faults.disconnect(selfIdA)
    await settle()

    expect(removed).toHaveBeenCalledWith(selfIdA)
    expect(hub.inspect.channel(GROUP_ID, 'cursors')).toEqual({})

    await unsubscribeB()
  })

  it('明示 remove が全端末へ onRemoved として配送される', async () => {
    const hub = createMemoryHub()
    const clientA = createHubClient(hub)
    const clientB = createHubClient(hub)
    const unsubscribeA = await subscribeSettled(clientA, { groupId: GROUP_ID })
    const unsubscribeB = await subscribeSettled(clientB, { groupId: GROUP_ID })

    const dragA = clientA.sync.channel<Cursor>('drag', { throttleMs: 0 })
    const dragB = clientB.sync.channel<Cursor>('drag', { throttleMs: 0 })
    const removed = vi.fn()
    dragB.subscribe({ onChanged: vi.fn(), onRemoved: removed })

    dragA.publish('block-1', { x: 1 })
    await settle()
    await dragA.remove('block-1')
    await settle()

    expect(removed).toHaveBeenCalledWith('block-1')
    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({})

    await unsubscribeA()
    await unsubscribeB()
  })

  it('publish 直後の remove で in-flight の set が後着しても値が復活しない (per-key 直列化)', async () => {
    const hub = createMemoryHub()
    const raw = hub.createTransport()

    // publishChannel の永続化を保留できる adapter を模す (firebase の
    // onDisconnect await 中に remove が追い越すケースの一般化)
    let releasePublish: () => void = () => undefined
    const delayed: SynquxTransport = {
      ...raw,
      publishChannel: (channel, key, payload, options) =>
        new Promise<void>((resolve, reject) => {
          releasePublish = () => {
            raw.publishChannel!(channel, key, payload, options).then(
              resolve,
              reject,
            )
          }
        }),
    }
    const client = createClient(delayed, {
      onSubscribeFailed: () => undefined,
    })
    const unsubscribe = await subscribeSettled(client, { groupId: GROUP_ID })

    const drag = client.sync.channel<Cursor>('drag', { throttleMs: 0 })
    drag.publish('block-1', { x: 1 })
    const removing = drag.remove('block-1') // 直列 chain で publish の完了を待つ

    // chain の op 実行 (microtask) を待ってから publish の永続化を解放する
    await vi.advanceTimersByTimeAsync(0)
    releasePublish()
    await settle()
    await removing

    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({})

    await unsubscribe()
  })

  it('in-flight 中の publish は最新値へ coalesce される (RTT > 発行間隔でも queue が伸びない)', async () => {
    const hub = createMemoryHub()
    const raw = hub.createTransport()

    // 永続化を 1 件ずつ手動解放できる低速 transport を模す
    const releases: (() => void)[] = []
    const published: string[] = []
    const gated: SynquxTransport = {
      ...raw,
      publishChannel: (channel, key, payload, options) =>
        new Promise<void>((resolve, reject) => {
          releases.push(() => {
            published.push(payload)
            raw.publishChannel!(channel, key, payload, options).then(
              resolve,
              reject,
            )
          })
        }),
    }
    const client = createClient(gated, { onSubscribeFailed: () => undefined })
    const unsubscribe = await subscribeSettled(client, { groupId: GROUP_ID })

    const drag = client.sync.channel<Cursor>('drag', { throttleMs: 0 })
    drag.publish('block-1', { x: 1 })
    await vi.advanceTimersByTimeAsync(0) // 1 件目の op が実行開始 (in-flight)
    drag.publish('block-1', { x: 2 })
    drag.publish('block-1', { x: 3 }) // x:2 の slot へ coalesce

    releases.shift()!() // x:1 の永続化完了
    await settle()
    releases.shift()!() // 2 件目の op (実行時点の最新 = x:3)
    await settle()

    expect(releases).toHaveLength(0) // op は 2 件しか作られていない
    expect(published).toEqual([
      JSON.stringify({ x: 1 }),
      JSON.stringify({ x: 3 }),
    ])
    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({
      'block-1': JSON.stringify({ x: 3 }),
    })

    await unsubscribe()
  })

  it('remove barrier 後の publish は barrier 前の slot へ coalesce されない (順序逆転防止)', async () => {
    const hub = createMemoryHub()
    const raw = hub.createTransport()

    const releases: (() => void)[] = []
    const gated: SynquxTransport = {
      ...raw,
      publishChannel: (channel, key, payload, options) =>
        new Promise<void>((resolve, reject) => {
          releases.push(() => {
            raw.publishChannel!(channel, key, payload, options).then(
              resolve,
              reject,
            )
          })
        }),
    }
    const client = createClient(gated, { onSubscribeFailed: () => undefined })
    const unsubscribe = await subscribeSettled(client, { groupId: GROUP_ID })

    const drag = client.sync.channel<Cursor>('drag', { throttleMs: 0 })
    drag.publish('block-1', { x: 1 })
    await vi.advanceTimersByTimeAsync(0) // op1 実行開始 (in-flight)
    drag.publish('block-1', { x: 2 }) // op2 (queued slot)
    const removing = drag.remove('block-1') // barrier
    drag.publish('block-1', { x: 3 }) // barrier 後 — slot へ吸われてはいけない

    while (releases.length > 0) {
      releases.shift()!()
      await settle(3)
    }
    await removing

    // 最終順序は publish(x1) → publish(x2) → remove → publish(x3)
    expect(hub.inspect.channel(GROUP_ID, 'drag')).toEqual({
      'block-1': JSON.stringify({ x: 3 }),
    })

    await unsubscribe()
  })

  it('standalone: self-loop 配送・既存 entry の再配送・session 終了での破棄', async () => {
    const client = createHubClient(createMemoryHub())
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })

    const cursors = client.sync.channel<Cursor>('cursors', { throttleMs: 0 })
    const changed = vi.fn()
    cursors.subscribe({ onChanged: changed, onRemoved: vi.fn() })

    cursors.publish('me', { x: 3 })
    await settle(1)
    expect(changed).toHaveBeenCalledWith('me', { x: 3 })

    // 後からの購読にも既存 entry が配送される
    const late = vi.fn()
    cursors.subscribe({ onChanged: late, onRemoved: vi.fn() })
    await settle(1)
    expect(late).toHaveBeenCalledWith('me', { x: 3 })

    // remove は onRemoved を self-loop 配送する
    const removed = vi.fn()
    cursors.subscribe({ onChanged: vi.fn(), onRemoved: removed })
    await cursors.remove('me')
    await settle(1)
    expect(removed).toHaveBeenCalledWith('me')

    // session 終了で値は破棄される (非永続。復元が必要な値は synced へ commit する)
    cursors.publish('me', { x: 9 })
    await settle(1)
    await client.sync.unsubscribe()
    await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
      mode: 'standalone',
      localSnapshots: false,
    })
    const afterRestart = vi.fn()
    cursors.subscribe({ onChanged: afterRestart, onRemoved: vi.fn() })
    await settle(1)
    expect(afterRestart).not.toHaveBeenCalled()

    await client.sync.unsubscribe()
  })

  it('session 未開始の publish は静かに drop される', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub)

    const cursors = client.sync.channel<Cursor>('cursors', { throttleMs: 0 })
    cursors.publish('early', { x: 1 })

    const unsubscribe = await subscribeSettled(client, { groupId: GROUP_ID })
    await settle()
    expect(hub.inspect.channel(GROUP_ID, 'cursors')).toEqual({})

    await unsubscribe()
  })

  it('channels 未対応 transport では synced subscribe が fail-fast する', async () => {
    const hub = createMemoryHub()
    const {
      publishChannel: _publishChannel,
      removeChannelValue: _removeChannelValue,
      subscribeChannel: _subscribeChannel,
      ...legacyTransport
    } = hub.createTransport()
    const client = createClient(legacyTransport as SynquxTransport, {
      onSubscribeFailed: () => undefined,
    })

    client.sync.channel('cursors')

    await expect(
      client.sync.subscribe({ store: client.store, groupId: GROUP_ID }),
    ).rejects.toThrow(/channel support/)
  })

  it('同名 channel は同一 handle を返し、options が異なると throw する', async () => {
    const client = createHubClient(createMemoryHub())

    const first = client.sync.channel<Cursor>('cursors', { throttleMs: 10 })
    expect(client.sync.channel<Cursor>('cursors', { throttleMs: 10 })).toBe(
      first,
    )
    expect(() =>
      client.sync.channel<Cursor>('cursors', { throttleMs: 20 }),
    ).toThrow(/different options/)
  })

  it('channel 名と key の禁止文字は入口で拒否される', async () => {
    const client = createHubClient(createMemoryHub())

    expect(() => client.sync.channel('bad/name')).toThrow(/Invalid channel/)

    const cursors = client.sync.channel<Cursor>('cursors', { throttleMs: 0 })
    expect(() => cursors.publish('bad.key', { x: 1 })).toThrow(
      /Invalid channel/,
    )
  })
})
