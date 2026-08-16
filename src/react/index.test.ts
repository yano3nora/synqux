// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'
import { createClient } from '../core/test-fixtures.js'
import type { SynquxTransport } from '../core/types.js'
import { useSynquxSubscription } from './index.js'

/**
 * synqux/react は購読開始 hook のみ (ADR-0023)。読み取りは core selectors を
 * consumer の typed useAppSelector へ渡す形が canonical で、hook wrapper は無い
 */
const noopTransport: SynquxTransport = {
  connect: async () => ({ selfId: 'peer-self' }),
  disconnect: async () => undefined,
  updateSelf: async () => undefined,
  heartbeat: async () => undefined,
  demotePeer: async () => undefined,
  serverNow: async () => Date.now(),
  subscribePeers: () => () => undefined,
  pushRequest: async () => ({ id: 'req-1' }),
  respondRequest: async () => undefined,
  // backlog なしの一括配送完了を同期通知する (契約 12。barrier を待たせない)
  subscribeRequests: (_options, handlers) => {
    handlers.onReady?.()
    return () => undefined
  },
  saveSnapshot: () => true,
  loadSnapshot: () => null,
}

const setup = (
  transport: SynquxTransport = noopTransport,
  options?: Parameters<typeof createClient>[1],
) => {
  const { sync, store } = createClient(transport, options)

  // SynquxProvider は廃止 (ADR-0022)。redux の Provider だけで全 hooks が動く
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, { store, children })

  return { sync, store, wrapper }
}

describe('synqux/react hooks', () => {
  it('useSynquxSubscription は groupId 指定時に購読し live を返す', async () => {
    const { sync, wrapper } = setup()
    const { result } = renderHook(
      () =>
        useSynquxSubscription(sync, {
          groupId: 'react-group',
        }),
      { wrapper },
    )

    await waitFor(() => expect(result.current).toBe('live'))
  })

  it('useSynquxSubscription は groupId 未確定なら購読しない', () => {
    const { sync, wrapper } = setup()
    const subscribe = vi.spyOn(sync, 'subscribe')

    renderHook(
      () =>
        useSynquxSubscription(sync, {
          groupId: undefined,
        }),
      { wrapper },
    )
    expect(subscribe).not.toHaveBeenCalled()
  })

  it('useSynquxSubscription は同一 store の二重 mount でも一度だけ購読する', async () => {
    const { sync, wrapper } = setup()
    const subscribe = vi.spyOn(sync, 'subscribe')

    renderHook(
      () =>
        useSynquxSubscription(sync, {
          groupId: 'react-group',
        }),
      { wrapper },
    )
    renderHook(
      () =>
        useSynquxSubscription(sync, {
          groupId: 'react-group',
        }),
      { wrapper },
    )

    await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  })

  it('useSynquxSubscription の失敗は config の onSubscribeFailed へ通知する', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const failingTransport: SynquxTransport = {
      ...noopTransport,
      connect: async () => {
        throw new Error('offline')
      },
    }
    const onSubscribeFailed = vi.fn()
    const { sync, wrapper } = setup(failingTransport, { onSubscribeFailed })

    renderHook(
      () =>
        useSynquxSubscription(sync, {
          groupId: 'react-group',
        }),
      { wrapper },
    )
    await waitFor(() => expect(onSubscribeFailed).toHaveBeenCalledTimes(1))
    expect(onSubscribeFailed).toHaveBeenCalledWith(expect.any(Error))
    consoleError.mockRestore()
  })
})
