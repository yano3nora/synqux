import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SYNQUX_SCHEMA_VERSION,
  type Peer,
  type RequestEnvelope,
  type SynquxTransport,
} from '../core/types.js'
import { createMemoryHub } from './memory-hub.js'

const GROUP_ID = 'group-a'

const flushDeliveries = async (times = 10): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    await vi.runOnlyPendingTimersAsync()
  }
}

const createEnvelope = (params: {
  groupId?: string
  requestedBy: Peer['id']
  type?: string
}): Omit<RequestEnvelope, 'id'> => ({
  v: SYNQUX_SCHEMA_VERSION,
  groupId: params.groupId ?? GROUP_ID,
  action: { type: params.type ?? 'game/action' },
  requested: Date.now(),
  requestedBy: params.requestedBy,
})

const connectTwo = async (): Promise<{
  hub: ReturnType<typeof createMemoryHub>
  a: SynquxTransport
  b: SynquxTransport
  aId: Peer['id']
  bId: Peer['id']
}> => {
  const hub = createMemoryHub()
  const a = hub.createTransport()
  const b = hub.createTransport()
  const { selfId: aId } = await a.connect({ groupId: GROUP_ID, label: 'a' })
  const { selfId: bId } = await b.connect({ groupId: GROUP_ID, label: 'b' })

  return { hub, a, b, aId, bId }
}

describe('createMemoryHub', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('基本フロー: pushRequest と respondRequest を全端末へ非同期配送する', async () => {
    const { a, b, aId } = await connectTwo()
    const addedA: RequestEnvelope[] = []
    const addedB: RequestEnvelope[] = []
    const changedA: RequestEnvelope[] = []
    const changedB: RequestEnvelope[] = []

    a.subscribeRequests(
      {},
      {
        onAdded: (envelope) => addedA.push(envelope),
        onChanged: (envelope) => changedA.push(envelope),
      },
    )
    b.subscribeRequests(
      {},
      {
        onAdded: (envelope) => addedB.push(envelope),
        onChanged: (envelope) => changedB.push(envelope),
      },
    )

    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    expect(addedA).toEqual([])

    await flushDeliveries()
    expect(addedA).toHaveLength(1)
    expect(addedB).toHaveLength(1)
    expect(addedA[0]).toEqual(addedB[0])
    expect(addedA[0]?.id).toBe(id)

    const response = a.respondRequest(id, {
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: '{"type":"success"}',
    })
    await flushDeliveries()
    await response

    expect(changedA).toHaveLength(1)
    expect(changedB).toHaveLength(1)
    expect(changedA[0]).toMatchObject({
      id,
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: '{"type":"success"}',
    })
    expect(changedB[0]).toEqual(changedA[0])
  })

  it('id 採番: 連続 push の id は挿入順で辞書順単調 (transport 契約 1)', async () => {
    const { a, aId } = await connectTwo()

    const first = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'first' }),
    )
    const second = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'second' }),
    )
    const third = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'third' }),
    )
    await flushDeliveries()

    expect([first.id, second.id, third.id]).toEqual(
      [first.id, second.id, third.id].sort((left, right) =>
        left.localeCompare(right),
      ),
    )
  })

  it('after 指定の購読: 対象既存 request だけを id 順で配送する', async () => {
    const { a, b, aId } = await connectTwo()
    const first = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'first' }),
    )
    const second = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'second' }),
    )
    const third = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'third' }),
    )
    await flushDeliveries()

    const received: string[] = []
    b.subscribeRequests(
      { after: first.id },
      {
        onAdded: (envelope) => received.push(envelope.id),
        onChanged: () => undefined,
      },
    )
    await flushDeliveries()

    expect(received).toEqual([second.id, third.id])
  })

  it('responsedBy 付き既存 request も restore 模擬として onAdded で届く', async () => {
    const { a, b, aId } = await connectTwo()
    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    const response = a.respondRequest(id, {
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: '{"ok":true}',
    })
    await flushDeliveries()
    await response

    const added: RequestEnvelope[] = []
    const changed: RequestEnvelope[] = []
    b.subscribeRequests(
      {},
      {
        onAdded: (envelope) => added.push(envelope),
        onChanged: (envelope) => changed.push(envelope),
      },
    )
    await flushDeliveries()

    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      id,
      responsedBy: aId,
      responsed: 1,
      result: '{"ok":true}',
    })
    expect(changed).toEqual([])
  })

  it('faults.duplicate: 対象端末の対象イベントだけを 2 回届ける', async () => {
    const { hub, a, b, aId, bId } = await connectTwo()
    const addedA: string[] = []
    const addedB: string[] = []
    const changedA: string[] = []
    const changedB: string[] = []
    a.subscribeRequests(
      {},
      {
        onAdded: (envelope) => addedA.push(envelope.id),
        onChanged: (envelope) => changedA.push(envelope.id),
      },
    )
    b.subscribeRequests(
      {},
      {
        onAdded: (envelope) => addedB.push(envelope.id),
        onChanged: (envelope) => changedB.push(envelope.id),
      },
    )

    const expectedId = '000000000001'
    hub.faults.duplicate({ requestId: expectedId, to: bId, event: 'changed' })
    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    const response = a.respondRequest(id, {
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: '{"ok":true}',
    })
    await flushDeliveries()
    await response

    expect(addedA).toEqual([id])
    expect(addedB).toEqual([id])
    expect(changedA).toEqual([id])
    expect(changedB).toEqual([id, id])
  })

  it('faults.drop: to 省略時は 1 fan-out の全端末配送を破棄する', async () => {
    const { hub, a, b, aId } = await connectTwo()
    const c = hub.createTransport()
    await c.connect({ groupId: GROUP_ID, label: 'c' })
    const received = [a, b, c].map(() => [] as string[])

    for (const [index, transport] of [a, b, c].entries()) {
      transport.subscribeRequests(
        {},
        {
          onAdded: (envelope) => received[index]!.push(envelope.action.type),
          onChanged: () => undefined,
        },
      )
    }

    hub.faults.drop({ requestId: '000000000001', event: 'added' })
    await a.pushRequest(createEnvelope({ requestedBy: aId, type: 'dropped' }))
    await flushDeliveries()
    expect(received).toEqual([[], [], []])

    await a.pushRequest(createEnvelope({ requestedBy: aId, type: 'delivered' }))
    await flushDeliveries()
    expect(received).toEqual([['delivered'], ['delivered'], ['delivered']])
  })

  it('faults.duplicate: to 省略時は 1 fan-out を全端末へ 2 回ずつ届ける', async () => {
    const { hub, a, b, aId } = await connectTwo()
    const c = hub.createTransport()
    await c.connect({ groupId: GROUP_ID, label: 'c' })
    const received = [a, b, c].map(() => [] as string[])

    for (const [index, transport] of [a, b, c].entries()) {
      transport.subscribeRequests(
        {},
        {
          onAdded: (envelope) => received[index]!.push(envelope.action.type),
          onChanged: () => undefined,
        },
      )
    }

    hub.faults.duplicate({ requestId: '000000000001', event: 'added' })
    await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'duplicated' }),
    )
    await flushDeliveries()
    expect(received).toEqual([
      ['duplicated', 'duplicated'],
      ['duplicated', 'duplicated'],
      ['duplicated', 'duplicated'],
    ])

    await a.pushRequest(createEnvelope({ requestedBy: aId, type: 'once' }))
    await flushDeliveries()
    expect(received).toEqual([
      ['duplicated', 'duplicated', 'once'],
      ['duplicated', 'duplicated', 'once'],
      ['duplicated', 'duplicated', 'once'],
    ])
  })

  it('faults.drop: to 指定時は指定端末だけを破棄し、他端末へは届ける', async () => {
    const { hub, a, b, aId, bId } = await connectTwo()
    const c = hub.createTransport()
    await c.connect({ groupId: GROUP_ID, label: 'c' })
    const received = [a, b, c].map(() => [] as string[])

    for (const [index, transport] of [a, b, c].entries()) {
      transport.subscribeRequests(
        {},
        {
          onAdded: (envelope) => received[index]!.push(envelope.id),
          onChanged: () => undefined,
        },
      )
    }

    hub.faults.drop({
      requestId: '000000000001',
      to: bId,
      event: 'added',
    })
    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    await flushDeliveries()

    expect(received).toEqual([[id], [], [id]])
  })

  it('faults.delay → release: 保留を後で元の順序のまま解放し、順序入れ替えを作れる', async () => {
    const { hub, a, b, aId, bId } = await connectTwo()
    const receivedB: string[] = []
    b.subscribeRequests(
      {},
      {
        onAdded: (envelope) => receivedB.push(envelope.action.type),
        onChanged: () => undefined,
      },
    )

    const delay = hub.faults.delay({
      requestId: '000000000001',
      to: bId,
      event: 'added',
    })
    const first = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'first' }),
    )
    const second = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'second' }),
    )
    await flushDeliveries()

    expect(receivedB).toEqual(['second'])

    delay.release()
    await flushDeliveries()

    expect(second.id > first.id).toBe(true)
    expect(receivedB).toEqual(['second', 'first'])
  })

  it('faults.drop: 対象配送 1 回だけを破棄し、以後の配送は正常に戻す', async () => {
    const { hub, a, b, aId, bId } = await connectTwo()
    const receivedB: string[] = []
    b.subscribeRequests(
      {},
      {
        onAdded: (envelope) => receivedB.push(envelope.action.type),
        onChanged: () => undefined,
      },
    )

    hub.faults.drop({ requestId: '000000000001', to: bId, event: 'added' })
    await a.pushRequest(createEnvelope({ requestedBy: aId, type: 'dropped' }))
    await flushDeliveries()
    expect(receivedB).toEqual([])

    await a.pushRequest(createEnvelope({ requestedBy: aId, type: 'delivered' }))
    await flushDeliveries()
    expect(receivedB).toEqual(['delivered'])
  })

  it('faults.holdAck: ack は release まで pending のまま、onChanged local echo は先に届く', async () => {
    const { hub, a, aId } = await connectTwo()
    const changed: string[] = []
    a.subscribeRequests(
      {},
      {
        onAdded: () => undefined,
        onChanged: (envelope) => changed.push(envelope.id),
      },
    )

    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    const hold = hub.faults.holdAck(id)
    let resolved = false
    const response = a
      .respondRequest(id, {
        epoch: 1,
        seq: 1,
        responsedBy: aId,
        responsed: 1,
        result: '{"ok":true}',
      })
      .then(() => {
        resolved = true
      })

    await flushDeliveries()
    expect(changed).toEqual([id])
    expect(resolved).toBe(false)

    hold.release()
    await response
    expect(resolved).toBe(true)
  })

  it('respondRequest の result: null は RTDB の update 同様に既存 result を除去する', async () => {
    const { hub, a, aId, bId } = await connectTwo()
    const { id } = await a.pushRequest(createEnvelope({ requestedBy: aId }))
    const first = a.respondRequest(id, {
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: '{"ok":true}',
    })
    await flushDeliveries()
    await first

    // dual-host 窓で 2 つ目の host が result なしで応答し直すケースの模擬
    const second = a.respondRequest(id, {
      epoch: 2,
      seq: 1,
      responsedBy: bId,
      responsed: 1,
      result: null,
    })
    await flushDeliveries()
    await second

    expect(hub.inspect.requests(GROUP_ID)[0]).not.toHaveProperty('result')
    expect(hub.inspect.requests(GROUP_ID)[0]?.responsedBy).toBe(bId)
  })

  it('pruneRequests: seq が閾値未満の裁定済み request だけを冪等に削除する', async () => {
    const { hub, a, aId } = await connectTwo()
    const first = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'old' }),
    )
    const second = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'kept' }),
    )
    const pending = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'pending' }),
    )

    const firstResponse = a.respondRequest(first.id, {
      epoch: 1,
      seq: 1,
      responsedBy: aId,
      responsed: 1,
      result: null,
    })
    const secondResponse = a.respondRequest(second.id, {
      epoch: 1,
      seq: 3,
      responsedBy: aId,
      responsed: 1,
      result: null,
    })
    await flushDeliveries()
    await Promise.all([firstResponse, secondResponse])

    await a.pruneRequests!(3)
    expect(hub.inspect.requests(GROUP_ID).map(({ id }) => id)).toEqual([
      second.id,
      pending.id,
    ])

    // 同一・後退した閾値の再実行でも、未裁定 request や残存分を巻き込まない。
    await a.pruneRequests!(3)
    await a.pruneRequests!(2)
    expect(hub.inspect.requests(GROUP_ID).map(({ id }) => id)).toEqual([
      second.id,
      pending.id,
    ])
  })

  it('faults.disconnect / disconnect(): 全端末に onRemoved が届き、unsubscribe 後は届かない', async () => {
    const { hub, a, b, aId, bId } = await connectTwo()
    const removedA: string[] = []
    const removedB: string[] = []
    const unsubscribeA = a.subscribePeers({
      onAdded: () => undefined,
      onChanged: () => undefined,
      onRemoved: (peer) => removedA.push(peer.id),
    })
    b.subscribePeers({
      onAdded: () => undefined,
      onChanged: () => undefined,
      onRemoved: (peer) => removedB.push(peer.id),
    })
    await flushDeliveries()

    hub.faults.disconnect(bId)
    await flushDeliveries()
    expect(removedA).toEqual([bId])
    expect(removedB).toEqual([bId])

    unsubscribeA()
    await a.disconnect()
    await flushDeliveries()
    expect(removedA).toEqual([bId])
    expect(removedB).toEqual([bId, aId])
  })

  it('受信側が envelope を破壊しても hub の inspect 結果を汚染しない', async () => {
    const { hub, a, aId } = await connectTwo()
    a.subscribeRequests(
      {},
      {
        onAdded: (envelope) => {
          envelope.action.type = 'mutated'
        },
        onChanged: () => undefined,
      },
    )

    const { id } = await a.pushRequest(
      createEnvelope({ requestedBy: aId, type: 'original' }),
    )
    await flushDeliveries()

    expect(hub.inspect.requests(GROUP_ID)).toMatchObject([
      { id, action: { type: 'original' } },
    ])
    const inspected = hub.inspect.requests(GROUP_ID)
    inspected[0]!.action.type = 'mutated-again'
    expect(hub.inspect.requests(GROUP_ID)[0]?.action.type).toBe('original')
  })

  it('connect 前のメソッド呼び出しは throw するが serverNow は呼べる', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()

    await expect(transport.serverNow()).resolves.toBe(Date.now())
    await expect(transport.disconnect()).rejects.toThrow('not connected')
    expect(() =>
      transport.subscribePeers({
        onAdded: () => undefined,
        onChanged: () => undefined,
        onRemoved: () => undefined,
      }),
    ).toThrow('not connected')
    await expect(
      transport.pushRequest(createEnvelope({ requestedBy: 'peer-x' })),
    ).rejects.toThrow('not connected')
    await expect(
      transport.respondRequest('000000000001', {
        epoch: 1,
        seq: 1,
        responsedBy: 'peer-x',
        responsed: 1,
        result: null,
      }),
    ).rejects.toThrow('not connected')
    await expect(transport.pruneRequests!(2)).rejects.toThrow('not connected')
    expect(() =>
      transport.subscribeRequests(
        {},
        { onAdded: () => undefined, onChanged: () => undefined },
      ),
    ).toThrow('not connected')
    await expect(transport.saveSnapshot('key', 'payload')).rejects.toThrow(
      'not connected',
    )
    await expect(transport.loadSnapshot('key')).rejects.toThrow('not connected')
  })
})
