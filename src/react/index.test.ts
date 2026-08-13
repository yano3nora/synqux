// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { Provider } from 'react-redux'
import { describe, expect, it, vi } from 'vitest'
import { synquxActions } from '../core/slice.js'
import { createClient, type GameAction } from '../core/test-fixtures.js'
import type { SynquxTransport } from '../core/types.js'
import {
  SynquxProvider,
  useIsHost,
  useIsLive,
  useIsSyncStalled,
  useIsSyncUnrecoverable,
  useLatestResult,
  useMyLatestResult,
  usePeers,
  useSelf,
  useSelfId,
  useSelfRole,
  useSyncHealth,
  useSyncPhase,
  useSynquxSubscription,
} from './index.js'

/** hooks は購読と描画の glue のみなので、store 直接操作で読み取り面だけ検証する */
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
  subscribeRequests: () => () => undefined,
  saveSnapshot: () => true,
  loadSnapshot: () => null,
}

const setup = (
  transport: SynquxTransport = noopTransport,
  options?: Parameters<typeof createClient>[1],
) => {
  const { sync, store } = createClient(transport, options)

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(Provider, {
      store,
      children: createElement(SynquxProvider, { sync, children }),
    })

  return { sync, store, wrapper }
}

describe('synqux/react hooks', () => {
  it('peer hooks が state.synqux の自端末情報を読める', () => {
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
    expect(renderHook(() => useSelf(), { wrapper }).result.current?.id).toBe(
      'peer-1',
    )
    expect(renderHook(() => useSelfRole(), { wrapper }).result.current).toBe(
      'player',
    )
  })

  it('useSyncPhase / useIsLive が購読 phase を読む', () => {
    const { store, wrapper } = setup()
    store.dispatch(synquxActions.phaseChanged('subscribing'))
    expect(renderHook(() => useSyncPhase(), { wrapper }).result.current).toBe(
      'subscribing',
    )
    expect(renderHook(() => useIsLive(), { wrapper }).result.current).toBe(
      false,
    )

    store.dispatch(synquxActions.phaseChanged('live'))
    expect(renderHook(() => useIsLive(), { wrapper }).result.current).toBe(true)
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
    expect(result.current?.log).toBe('forbidden')
  })

  it('useMyLatestResult は自端末宛てだけを返す', () => {
    const { store, wrapper } = setup()
    store.dispatch(
      synquxActions.sessionStarted({ selfId: 'peer-1', enabled: true }),
    )
    store.dispatch({
      type: 'game/message-forbidden',
      meta: { requestedBy: 'peer-1', hash: 'h-self', dispatched: 1 },
    })
    expect(
      renderHook(() => useMyLatestResult<GameAction>(), { wrapper }).result
        .current?.type,
    ).toBe('error')

    store.dispatch({
      type: 'game/message-forbidden',
      meta: { requestedBy: 'peer-2', hash: 'h-other', dispatched: 2 },
    })
    expect(
      renderHook(() => useMyLatestResult<GameAction>(), { wrapper }).result
        .current,
    ).toBeNull()
  })

  it('sync health hooks は Provider 追加なしで health を読める', () => {
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
    expect(
      renderHook(() => useIsSyncUnrecoverable(), { wrapper }).result.current,
    ).toBe(false)

    store.dispatch(
      synquxActions.healthChanged({
        phase: 'unrecoverable',
        expectedSeq: 2,
        maxSeenSeq: 3,
        gapSince: 100,
      }),
    )
    expect(
      renderHook(() => useIsSyncUnrecoverable(), { wrapper }).result.current,
    ).toBe(true)
  })

  it('useLatestResult は Provider がないと throw する', () => {
    expect(() => renderHook(() => useLatestResult())).toThrow(
      'within <SynquxProvider>',
    )
  })

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
