import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createHubClient, settle } from './test-fixtures.js'

/**
 * 決定性検出網 (ADR-0001 Decision 8 / D4) の検証
 *
 * 純粋性契約 (synced reducer は payload と決定的 meta しか読めない) でも
 * 防げない Date.now / Math.random 等の残余クラスを、「host の試し実行結果 vs
 * 実適用後 state」の比較で dev モードに検出できることを確認する
 */

const GROUP_ID = 'group-determinism'

describe('devDeterminismCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-05T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('非決定な reducer (Math.random) は host 端末で検出され console.error される', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub) // 単独接続 = 自分が host = 試し実行と実適用が同一端末

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/random' })
    await settle()

    expect(client.store.getState().game.log).toEqual(['random'])
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('Determinism check failed'),
    )

    consoleError.mockRestore()
  })

  it('決定的な reducer では何も報告されない (対照)', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub)

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(client.store.getState().game.count).toBe(1)
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })

  it('devDeterminismCheck: false で無効化できる (production 相当)', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)

    const hub = createMemoryHub()
    const client = createHubClient(hub, { devDeterminismCheck: false })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await settle()

    client.store.dispatch({ type: 'game/random' })
    await settle()

    expect(client.store.getState().game.log).toEqual(['random'])
    expect(consoleError).not.toHaveBeenCalled()

    consoleError.mockRestore()
  })
})
