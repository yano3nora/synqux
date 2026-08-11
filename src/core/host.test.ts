import { describe, expect, it } from 'vitest'
import { deriveHostId } from './host.js'
import type { Peer } from './types.js'

const peer = (props: Partial<Peer> & Pick<Peer, 'id' | 'connected'>): Peer => ({
  groupId: 'group-a',
  ...props,
})

describe('deriveHostId (移植元 isHostPlayer の導出部)', () => {
  it('dedicated がいれば最新接続の dedicated が host になる', () => {
    const id = deriveHostId([
      peer({ id: 'p1', connected: 1 }),
      peer({ id: 'd1', connected: 2, role: 'dedicated' }),
      peer({ id: 'd2', connected: 3, role: 'dedicated' }),
      peer({ id: 'p2', connected: 4 }), // player が後から来ても dedicated 優先
    ])
    expect(id).toBe('d2')
  })

  it('dedicated 不在時は最新接続の player が host になる (role 省略は player 扱い)', () => {
    const id = deriveHostId([
      peer({ id: 'p1', connected: 1, role: 'player' }),
      peer({ id: 'p2', connected: 2 }),
    ])
    expect(id).toBe('p2')
  })

  it('guest は昇格しない', () => {
    const id = deriveHostId([
      peer({ id: 'p1', connected: 1 }),
      peer({ id: 'o1', connected: 2, role: 'guest' }),
    ])
    expect(id).toBe('p1')
  })

  it('昇格可能な端末がいなければ host 不在 (undefined)', () => {
    expect(deriveHostId([])).toBeUndefined()
    expect(
      deriveHostId([peer({ id: 'o1', connected: 1, role: 'guest' })]),
    ).toBeUndefined()
  })

  it('host 離脱 (プールからの除去) で次点が自動的に host になる (host migration)', () => {
    const pool = [
      peer({ id: 'p1', connected: 1 }),
      peer({ id: 'p2', connected: 2 }),
    ]
    expect(deriveHostId(pool)).toBe('p2')
    expect(deriveHostId(pool.filter((p) => p.id !== 'p2'))).toBe('p1')
  })

  it('同時刻接続は id の辞書順 tiebreak で全端末が同じ結論に達する (列挙順に依存しない)', () => {
    const a = peer({ id: 'aaa', connected: 1 })
    const b = peer({ id: 'bbb', connected: 1 })
    expect(deriveHostId([a, b])).toBe('bbb')
    expect(deriveHostId([b, a])).toBe('bbb')
  })
})
