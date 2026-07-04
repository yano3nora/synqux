import { deriveHostId } from './host.js'
import type { SynquxState } from './slice.js'
import type { Peer } from './types.js'

/**
 * ゲーム開発者層向けの読み取り selector (ADR-0001 Decision 7)
 * `state.synqux` が予約 key のため instance に依存しない静的関数として提供できる
 */
type WithSynqux = { synqux: SynquxState }

/**
 * 自端末が host か
 * standalone (enabled=false) 時は常に true として単独進行させる (移植元踏襲)
 */
export const selectIsHost = (root: WithSynqux): boolean => {
  const { enabled, connections } = root.synqux

  if (!enabled) {
    return true
  }

  if (!connections.selfId) {
    return false
  }

  return (
    deriveHostId(Object.values(connections.entities)) === connections.selfId
  )
}

export const selectPeers = (root: WithSynqux): Peer[] =>
  Object.values(root.synqux.connections.entities)

export const selectSelfId = (root: WithSynqux): Peer['id'] | null =>
  root.synqux.connections.selfId
