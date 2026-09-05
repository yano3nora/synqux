import { describe, expect, it, vi } from 'vitest'
import { keepAcrossHmr } from './hmr.js'

describe('keepAcrossHmr', () => {
  it('hot がなければ毎回 create する (本番 build / HMR 無効と同じ挙動)', () => {
    const create = vi.fn(() => ({}))

    const first = keepAcrossHmr(undefined, 'synqux', create)
    const second = keepAcrossHmr(undefined, 'synqux', create)

    expect(create).toHaveBeenCalledTimes(2)
    expect(first).not.toBe(second)
  })

  it('hot.data に保持し、再評価 (同じ hot.data での再呼び出し) では create せず同じ instance を返す', () => {
    const hot = { data: {} as Record<string, unknown> }
    const create = vi.fn(() => ({}))

    const first = keepAcrossHmr(hot, 'synqux', create)
    const second = keepAcrossHmr(hot, 'synqux', create)

    expect(create).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    expect(hot.data.synqux).toBe(first)
  })

  it('key ごとに独立して保持する', () => {
    const hot = { data: {} as Record<string, unknown> }

    const a = keepAcrossHmr(hot, 'synqux', () => ({ kind: 'synqux' }))
    const b = keepAcrossHmr(hot, 'store', () => ({ kind: 'store' }))

    expect(a).not.toBe(b)
    expect(keepAcrossHmr(hot, 'store', () => ({ kind: 'other' }))).toBe(b)
  })
})
