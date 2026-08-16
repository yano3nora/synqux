import { describe, expect, it } from 'vitest'
import { synquxActions, synquxReducer, synquxInitialState } from './slice.js'
import { selectPeers, selectSelf, selectSyncHealth } from './selectors.js'

/**
 * useSelector へ直接渡す canonical 用法 (ADR-0023) の前提となる参照安定性:
 * state が変わらない限り同一参照を返すこと (毎回新オブジェクトだと無関係な
 * dispatch でも再描画 + react-redux の安定性警告になる)
 */
describe('selectors の参照安定性', () => {
  const buildState = () => {
    let state = synquxReducer(
      synquxInitialState,
      synquxActions.sessionStarted({ selfId: 'peer-1', mode: 'synced' }),
    )
    state = synquxReducer(
      state,
      synquxActions.peerUpserted({ id: 'peer-1', groupId: 'g', connected: 1 }),
    )
    state = synquxReducer(
      state,
      synquxActions.peerUpserted({ id: 'peer-2', groupId: 'g', connected: 2 }),
    )
    return { synqux: state }
  }

  it('selectPeers は同じ state に対して同一の配列参照を返す', () => {
    const root = buildState()

    const first = selectPeers(root)
    expect(first).toHaveLength(2)
    expect(selectPeers(root)).toBe(first)

    // peers に無関係な state 変化 (health) では entities が同一参照のまま
    const changed = {
      synqux: synquxReducer(
        root.synqux,
        synquxActions.healthChanged({
          phase: 'stalled',
          expectedSeq: 1,
          maxSeenSeq: 2,
          gapSince: 1,
        }),
      ),
    }
    expect(selectPeers(changed)).toBe(first)

    // peers が変わったときだけ新しい参照になる
    const upserted = {
      synqux: synquxReducer(
        root.synqux,
        synquxActions.peerUpserted({
          id: 'peer-3',
          groupId: 'g',
          connected: 3,
        }),
      ),
    }
    expect(selectPeers(upserted)).not.toBe(first)
    expect(selectPeers(upserted)).toHaveLength(3)
  })

  it('selectSelf / selectSyncHealth は state 内の参照をそのまま返す', () => {
    const root = buildState()

    expect(selectSelf(root)).toBe(root.synqux.connections.entities['peer-1'])
    expect(selectSyncHealth(root)).toBe(root.synqux.health)
  })
})
