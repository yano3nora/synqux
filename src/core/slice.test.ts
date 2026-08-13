import { describe, expect, it } from 'vitest'
import {
  selectIsHost,
  selectIsSyncStalled,
  selectIsSyncUnrecoverable,
  selectPeers,
  selectSelf,
  selectSelfId,
  selectSelfRole,
  selectSyncHealth,
  selectSyncPhase,
} from './selectors.js'
import {
  synquxActions,
  synquxInitialState,
  synquxReducer,
  type PendingRequest,
  type SynquxState,
} from './slice.js'
import type { Peer } from './types.js'

const peer = (props: Partial<Peer> & Pick<Peer, 'id' | 'connected'>): Peer => ({
  groupId: 'group-a',
  ...props,
})

const pending = (
  props: Partial<PendingRequest> & Pick<PendingRequest, 'id'>,
): PendingRequest => ({
  requested: 1,
  requestedBy: 'peer-1',
  action: { type: 'game/test', meta: { requestedBy: 'peer-1', hash: 'h-1' } },
  ...props,
})

const reduce = (
  state: SynquxState,
  ...actions: Parameters<typeof synquxReducer>[1][]
): SynquxState => actions.reduce(synquxReducer, state)

describe('synquxSlice', () => {
  it('sessionStarted で instance 設定 (enabled / selfId) を state に反映する', () => {
    const state = reduce(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: 'peer-1', enabled: true }),
    )
    expect(state.enabled).toBe(true)
    expect(state.connections.selfId).toBe('peer-1')
  })

  it('sessionEnded で内部 state を全破棄する (移植元 disconnectConnections 相当)', () => {
    const state = reduce(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: 'peer-1', enabled: true }),
      synquxActions.peerUpserted(peer({ id: 'peer-1', connected: 1 })),
      synquxActions.requestAdded({ request: pending({ id: 'r-1' }) }),
      synquxActions.sessionEnded(),
    )
    expect(state).toEqual(synquxInitialState)
  })

  it('peerUpserted / peerRemoved で接続プールを維持する', () => {
    const joined = reduce(
      synquxInitialState,
      synquxActions.peerUpserted(peer({ id: 'peer-1', connected: 1 })),
      synquxActions.peerUpserted(peer({ id: 'peer-2', connected: 2 })),
    )
    expect(Object.keys(joined.connections.entities)).toEqual([
      'peer-1',
      'peer-2',
    ])

    const left = reduce(joined, synquxActions.peerRemoved('peer-2'))
    expect(Object.keys(left.connections.entities)).toEqual(['peer-1'])
  })

  it('healthChanged で診断値を更新し、sessionEnded で ok に戻す', () => {
    const stalled = reduce(
      synquxInitialState,
      synquxActions.healthChanged({
        phase: 'stalled',
        expectedSeq: 2,
        maxSeenSeq: 3,
        gapSince: 100,
      }),
    )
    expect(selectIsSyncStalled({ synqux: stalled })).toBe(true)
    expect(selectIsSyncUnrecoverable({ synqux: stalled })).toBe(false)
    expect(selectSyncHealth({ synqux: stalled }).expectedSeq).toBe(2)

    const unrecoverable = reduce(
      stalled,
      synquxActions.healthChanged({
        phase: 'unrecoverable',
        expectedSeq: 2,
        maxSeenSeq: 3,
        gapSince: 100,
      }),
    )
    expect(selectIsSyncStalled({ synqux: unrecoverable })).toBe(true)
    expect(selectIsSyncUnrecoverable({ synqux: unrecoverable })).toBe(true)

    const ended = reduce(unrecoverable, synquxActions.sessionEnded())
    expect(selectIsSyncStalled({ synqux: ended })).toBe(false)
  })

  it('requestChanged は entity を裁定印ごと上書きする (再裁定の追従)', () => {
    const state = reduce(
      synquxInitialState,
      synquxActions.requestChanged({
        request: pending({
          id: 'r-1',
          responsedBy: 'peer-1',
          epoch: 1,
          seq: 1,
        }),
      }),
      // dual-host 敗者への再裁定: 新しい (epoch, seq) で上書きされる
      synquxActions.requestChanged({
        request: pending({
          id: 'r-1',
          responsedBy: 'peer-2',
          epoch: 2,
          seq: 3,
        }),
      }),
    )
    expect(state.requests.entities['r-1']?.epoch).toBe(2)
    expect(state.requests.entities['r-1']?.seq).toBe(3)
  })

  it('request 経路の action (meta.requestedBy + hash) が通過したら同 hash の entity を破棄する', () => {
    const before = reduce(
      synquxInitialState,
      synquxActions.requestAdded({
        request: pending({
          id: 'r-1',
          action: {
            type: 'game/test',
            meta: { requestedBy: 'peer-1', hash: 'h-1' },
          },
        }),
      }),
    )

    const after = synquxReducer(before, {
      type: 'game/test',
      meta: { requestedBy: 'peer-1', hash: 'h-1' },
    })
    expect(after.requests.entities['r-1']).toBeUndefined()
  })

  it('requestedBy のない action (standalone / local 進行) では entities を破棄しない', () => {
    const before = reduce(
      synquxInitialState,
      synquxActions.requestAdded({ request: pending({ id: 'r-1' }) }),
    )

    const after = synquxReducer(before, {
      type: 'game/test',
      meta: { hash: 'h-1' },
    })
    expect(after.requests.entities['r-1']).toBeDefined()
  })
})

describe('selectors', () => {
  const withSynqux = (synqux: SynquxState) => ({ synqux })

  it('standalone (enabled=false) では常に host', () => {
    const state = reduce(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: null, enabled: false }),
    )
    expect(selectIsHost(withSynqux(state))).toBe(true)
  })

  it('接続確立前 (selfId なし) は host ではない', () => {
    expect(selectIsHost(withSynqux(synquxInitialState))).toBe(false)
  })

  it('host 導出結果が自端末なら host', () => {
    const state = reduce(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: 'peer-2', enabled: true }),
      synquxActions.peerUpserted(peer({ id: 'peer-1', connected: 1 })),
      synquxActions.peerUpserted(peer({ id: 'peer-2', connected: 2 })),
    )
    expect(selectIsHost(withSynqux(state))).toBe(true)
    expect(selectPeers(withSynqux(state))).toHaveLength(2)
    expect(selectSelfId(withSynqux(state))).toBe('peer-2')
    expect(selectSelf(withSynqux(state))?.id).toBe('peer-2')
    expect(selectSelfRole(withSynqux(state))).toBe('player')
  })

  it('self 不在時は Peer / role とも null', () => {
    expect(selectSelf(withSynqux(synquxInitialState))).toBeNull()
    expect(selectSelfRole(withSynqux(synquxInitialState))).toBeNull()
  })

  it('購読 phase を state から返す', () => {
    const subscribing = reduce(
      synquxInitialState,
      synquxActions.phaseChanged('subscribing'),
    )
    expect(selectSyncPhase(withSynqux(subscribing))).toBe('subscribing')
  })

  it('host 離脱で自端末が次点なら host に昇格する (host migration)', () => {
    const both = reduce(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: 'peer-1', enabled: true }),
      synquxActions.peerUpserted(peer({ id: 'peer-1', connected: 1 })),
      synquxActions.peerUpserted(peer({ id: 'peer-2', connected: 2 })),
    )
    expect(selectIsHost(withSynqux(both))).toBe(false)

    const migrated = reduce(both, synquxActions.peerRemoved('peer-2'))
    expect(selectIsHost(withSynqux(migrated))).toBe(true)
  })
})
