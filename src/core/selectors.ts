import { deriveHostId } from './host.js'
import type { SynquxHealth, SynquxPhase, SynquxState } from './slice.js'
import type { Peer, PeerRole } from './types.js'

/**
 * ゲーム開発者層向けの読み取り selector (ADR-0001 Decision 7)
 * `state.synqux` が予約 key のため instance に依存しない静的関数として提供できる
 */
type WithSynqux = { synqux: SynquxState }

/**
 * 自端末が host か
 * standalone 時は常に true として単独進行させる (移植元踏襲)
 */
export const selectIsHost = (root: WithSynqux): boolean => {
  const { mode, connections } = root.synqux

  if (mode === 'standalone') {
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

/** 自端末の Peer。未接続 (selfId なし) や presence 反映前は null */
export const selectSelf = (root: WithSynqux): Peer | null => {
  const selfId = selectSelfId(root)
  return selfId === null
    ? null
    : (root.synqux.connections.entities[selfId] ?? null)
}

/**
 * 自端末の現在 role。role 未指定の peer は host 導出 (host.ts) と同じ既定の
 * 'player' に正規化して返す。presence 反映ラグがあるため、setRole 直後は
 * 旧 role が返る窓がある
 */
export const selectSelfRole = (root: WithSynqux): PeerRole | null => {
  const self = selectSelf(root)
  return self === null ? null : (self.role ?? 'player')
}

/**
 * subscribe の進行 phase。restore replay 中 ('subscribing') とライブ配信 ('live') の
 * 区別に使う (例: reset action での reload を live 時に限定し、replay 再適用での
 * reload ループを防ぐ)。listener middleware / UI 専用 — synced reducer から読むと
 * 決定性が壊れるため使用禁止 (meta.root 不透過と同じ理屈)
 */
export const selectSyncPhase = (root: WithSynqux): SynquxPhase =>
  root.synqux.phase

export const selectIsLive = (root: WithSynqux): boolean =>
  selectSyncPhase(root) === 'live'

export const selectSyncHealth = (root: WithSynqux): SynquxHealth =>
  root.synqux.health

export const selectIsSyncStalled = (root: WithSynqux): boolean =>
  selectSyncHealth(root).phase !== 'ok'

export const selectIsSyncUnrecoverable = (root: WithSynqux): boolean =>
  selectSyncHealth(root).phase === 'unrecoverable'
