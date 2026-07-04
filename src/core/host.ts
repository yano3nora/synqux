import type { Peer } from './types.js'

/**
 * host 決定ロジック (移植元 constants/connections.ts の isHostPlayer 相当)
 *
 * 全端末が共有する peer プールから host を導出する純粋関数。選挙プロトコルなしで
 * 全端末が同じ host に合意でき、host 離脱時もプールの変化だけで次の host が定まる
 * (host migration)。「全端末が同じ結論に達する」ことが同期の成立条件のため、
 * このロジックは consumer に委ねない (ADR-0001 Decision 7)
 *
 * 優先順位: 最新接続の dedicated → いなければ最新接続の player。
 * observer は昇格しない。player もいなければ host 不在 (undefined)
 */
export const deriveHostId = (peers: Peer[]): Peer['id'] | undefined => {
  const dedicated = peers.filter((peer) => peer.role === 'dedicated')
  const players = peers.filter(
    (peer) => peer.role === 'player' || peer.role === undefined,
  )
  const pool = dedicated.length ? dedicated : players

  return lastConnectedId(pool)
}

/**
 * 「最後に接続した端末」の id
 *
 * 移植元は connected のみで sort していたが、同時刻 (同 ms) 接続時に entities の
 * 列挙順次第で端末間の結論が割れ得るため、id の辞書順を tiebreak に加えて
 * peer 集合の純粋関数にしている (数少ない意図的な移植元からの変更)
 */
const lastConnectedId = (peers: Peer[]): Peer['id'] | undefined =>
  [...peers]
    .sort((a, b) => a.connected - b.connected || a.id.localeCompare(b.id))
    .at(-1)?.id
