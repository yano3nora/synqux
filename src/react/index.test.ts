// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it } from 'vitest'
import { synquxActions } from '../core/slice.js'
import { createClient, type GameAction } from '../core/test-fixtures.js'
import type { SynquxTransport } from '../core/types.js'
import {
  SynquxProvider,
  useIsHost,
  useIsSyncStalled,
  useLatestResult,
  usePeers,
  useSelfId,
  useSyncHealth,
} from './index.js'

/** hooks は購読と描画の glue のみなので、store 直接操作で読み取り面だけ検証する */
const noopTransport: SynquxTransport = {
  connect: async () => ({ selfId: 'peer-self' }),
  disconnect: async () => undefined,
  serverNow: async () => Date.now(),
  subscribePeers: () => () => undefined,
  pushRequest: async () => ({ id: 'req-1' }),
  respondRequest: async () => undefined,
  subscribeRequests: () => () => undefined,
  saveSnapshot: () => undefined,
  loadSnapshot: () => null,
}

const setup = () => {
  const { sync, store } = createClient(noopTransport)

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, {
      store,
      children: createElement(SynquxProvider, { sync, children }),
    })

  return { store, wrapper }
}

describe('synqux/react hooks', () => {
  it('useIsHost / usePeers / useSelfId が state.synqux を読める', () => {
    const { store, wrapper } = setup()

    store.dispatch(
      synquxActions.sessionStarted({ selfId: 'peer-1', enabled: true }),
    )
    store.dispatch(
      synquxActions.peerUpserted({ id: 'peer-1', groupId: 'g', connected: 1 }),
    )

    expect(renderHook(() => useIsHost(), { wrapper }).result.current).toBe(true)
    expect(
      renderHook(() => usePeers(), { wrapper }).result.current,
    ).toHaveLength(1)
    expect(renderHook(() => useSelfId(), { wrapper }).result.current).toBe(
      'peer-1',
    )
  })

  it('useLatestResult は Provider 経由で synced の位置を解決して result を読む', () => {
    const { store, wrapper } = setup()

    // 素通し経路 (requestedBy 付き) で validation エラーを発生させ result を積む
    store.dispatch({
      type: 'game/forbidden',
      meta: { requestedBy: 'peer-1', hash: 'h-1', dispatched: 1 },
    })

    const { result } = renderHook(() => useLatestResult<GameAction>(), {
      wrapper,
    })
    expect(result.current?.type).toBe('error')
    expect(result.current?.message).toBe('forbidden')
  })

  it('useSyncHealth / useIsSyncStalled は Provider 追加なしで health を読める', () => {
    const { store, wrapper } = setup()
    store.dispatch(
      synquxActions.healthChanged({
        phase: 'stalled',
        expectedSeq: 2,
        maxSeenSeq: 3,
        gapSince: 100,
      }),
    )

    expect(
      renderHook(() => useSyncHealth(), { wrapper }).result.current,
    ).toMatchObject({ phase: 'stalled', expectedSeq: 2 })
    expect(
      renderHook(() => useIsSyncStalled(), { wrapper }).result.current,
    ).toBe(true)
  })

  it('useLatestResult は Provider がないと throw する', () => {
    expect(() => renderHook(() => useLatestResult())).toThrow(
      'within <SynquxProvider>',
    )
  })
})
