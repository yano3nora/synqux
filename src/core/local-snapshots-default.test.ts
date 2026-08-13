// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createHubClient } from './test-fixtures.js'

describe('standalone localSnapshots の browser 既定値', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('省略時は localStorage へ保存し、新しい instance で restore する', async () => {
    const hub = createMemoryHub()
    const first = createHubClient(hub, { enabled: false })
    await first.sync.subscribe({ store: first.store, groupId: 'solo-default' })

    first.store.dispatch({ type: 'game/increment', payload: 11 })
    expect(localStorage.getItem('solo-default')).not.toBeNull()

    const second = createHubClient(hub, { enabled: false })
    await second.sync.subscribe({
      store: second.store,
      groupId: 'solo-default',
    })
    expect(second.store.getState().game.count).toBe(11)
    expect(second.store.getState().game.result).toBeNull()
  })

  it('localSnapshots: false なら localStorage へ保存しない', async () => {
    const client = createHubClient(createMemoryHub(), {
      enabled: false,
      localSnapshots: false,
    })
    await client.sync.subscribe({ store: client.store, groupId: 'solo-off' })

    client.store.dispatch({ type: 'game/increment', payload: 1 })
    expect(localStorage.getItem('solo-off')).toBeNull()
  })
})
