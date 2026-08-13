// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createHubClient } from './test-fixtures.js'

describe('standalone localSnapshots の browser 既定値', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('省略時は localStorage へ保存し、新しい instance で restore する', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub, { mode: 'standalone' })
    await first.sync.subscribe({ store: first.store, groupId: 'solo-default' })

    first.store.dispatch({ type: 'game/increment', payload: 11 })
    expect(localStorage.getItem('solo-default')).not.toBeNull()

    const second = createHubClient(hub, { mode: 'standalone' })
    await second.sync.subscribe({
      store: second.store,
      groupId: 'solo-default',
    })
    expect(second.store.getState().game.count).toBe(11)
    expect(second.store.getState().game.result).toBeNull()
  })

  it('localSnapshots: false なら localStorage へ保存しない', async () => {
    const client = createHubClient(createMemoryHub(), {
      mode: 'standalone',
      localSnapshots: false,
    })
    await client.sync.subscribe({ store: client.store, groupId: 'solo-off' })

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(localStorage.getItem('solo-off')).toBeNull()
  })

  it('session の localSnapshots: false は既存 save key を read / write しない', async () => {
    localStorage.setItem('tutorial', 'existing-save')
    const getItem = vi.spyOn(Storage.prototype, 'getItem')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    getItem.mockClear()
    setItem.mockClear()

    const client = createHubClient(createMemoryHub())
    await client.sync.subscribe({
      store: client.store,
      groupId: 'tutorial',
      mode: 'standalone',
      localSnapshots: false,
    })
    client.store.dispatch({ type: 'game/increment', payload: 1 })

    expect(getItem).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalledWith('tutorial', expect.any(String))
    expect(localStorage.getItem('tutorial')).toBe('existing-save')
    getItem.mockRestore()
    setItem.mockRestore()
  })
})
