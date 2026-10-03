import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createClient, createHubClient, settle } from './test-fixtures.js'
import type { SynquxTransport } from './types.js'

const GROUP_ID = 'group-inspections'

/**
 * 裁定到達の調査記録 (transport 契約 19、ADR-0030)。host は最後に subscribe
 * した端末 (a)。既定で裁定ごとに 1 件残り、correctness には影響しない
 */
describe('inspections (ADR-0030)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** b (client) を先に、a (host) を後に subscribe する。a の transport は差し替え可能 */
  const arrange = async (
    hub: ReturnType<typeof createMemoryHub>,
    hostTransport: SynquxTransport = hub.createTransport(),
    options?: Parameters<typeof createClient>[1],
  ) => {
    const b = createHubClient(hub)
    const a = createClient(hostTransport, options)
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle(10)
    return { a, b }
  }

  const dispatchIncrements = async (
    client: ReturnType<typeof createHubClient>,
    count: number,
  ) => {
    for (let index = 0; index < count; index += 1) {
      client.store.dispatch({ type: 'game/increment', payload: 1 })
      await settle(2)
    }
  }

  it('既定で commit 済みの裁定ごとに 1 件残す (requested / responsedBy / seq / snapshotBytes)', async () => {
    const hub = createMemoryHub()
    const { a, b } = await arrange(hub)
    const hostId = a.store.getState().synqux.connections.selfId

    await dispatchIncrements(b, 3)

    const inspections = hub.inspect
      .inspections(GROUP_ID)
      .sort((left, right) => left.seq - right.seq)
    const requests = hub.inspect.requests(GROUP_ID)

    expect(inspections).toHaveLength(3)
    expect(inspections.map((record) => record.seq)).toEqual([1, 2, 3])
    for (const record of inspections) {
      const envelope = requests.find((request) => request.id === record.id)
      expect(envelope).toBeDefined()
      expect(record.requested).toBe(envelope!.requested)
      expect(record.responsedBy).toBe(hostId)
      expect(record.epoch).toBe(envelope!.epoch)
      expect(record.responsed).toBeGreaterThanOrEqual(record.requested)
    }
    // snapshotBytes は「直前に commit した snapshot」の byte 数。初回は未保存で 0、
    // 以降は裁定ごとの保存を反映する
    expect(inspections[0]!.snapshotBytes).toBe(0)
    expect(inspections[1]!.snapshotBytes).toBeGreaterThan(0)
    expect(inspections[2]!.snapshotBytes).toBeGreaterThanOrEqual(
      inspections[1]!.snapshotBytes,
    )
  })

  it('inspections: false で omit する', async () => {
    const hub = createMemoryHub()
    const { a, b } = await arrange(hub, undefined, { inspections: false })

    await dispatchIncrements(b, 2)

    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)
    expect(hub.inspect.inspections(GROUP_ID)).toHaveLength(0)
  })

  it('inspectResponse を持たない transport では黙って skip する', async () => {
    const hub = createMemoryHub()
    const { inspectResponse: _omitted, ...transport } = hub.createTransport()
    const { a, b } = await arrange(hub, transport)

    await dispatchIncrements(b, 2)

    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)
    expect(hub.inspect.inspections(GROUP_ID)).toHaveLength(0)
  })

  it('記録の失敗は裁定と適用に影響しない', async () => {
    const hub = createMemoryHub()
    const transport: SynquxTransport = {
      ...hub.createTransport(),
      inspectResponse: async () => {
        throw new Error('Injected inspectResponse failure')
      },
    }
    const { a, b } = await arrange(hub, transport)
    // vitest.setup の console.error 検査を opt-out する (注入エラーは想定内)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await dispatchIncrements(b, 2)

    expect(a.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(2)
    expect(hub.inspect.snapshotFence(GROUP_ID)?.appliedSeq).toBe(2)
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Injected inspectResponse failure' }),
    )
    consoleError.mockRestore()
  })
})
