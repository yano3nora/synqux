import { describe, expect, it } from 'vitest'
import { findFirstDivergence } from './diff.js'

describe('findFirstDivergence', () => {
  it('同じ JSON 値には差分がない', () => {
    expect(
      findFirstDivergence(
        { talks: [{ text: 'hello' }], enabled: true },
        { enabled: true, talks: [{ text: 'hello' }] },
      ),
    ).toBeNull()
  })

  it('object のキーを辞書順で走査し最初の値差分を返す', () => {
    expect(
      findFirstDivergence(
        { talks: { phase2: 2, phase1: { current: 1 } } },
        { talks: { phase2: 3, phase1: { current: 9 } } },
      ),
    ).toEqual({
      path: 'talks.phase1.current',
      expected: 1,
      actual: 9,
    })
  })

  it('片側だけにある object キーは欠落側を undefined として返す', () => {
    expect(findFirstDivergence({ alpha: 1, beta: 2 }, { beta: 2 })).toEqual({
      path: 'alpha',
      expected: 1,
      actual: undefined,
    })
  })

  it('配列を index 順で走査し入れ子の path を bracket で表す', () => {
    expect(
      findFirstDivergence(
        { entities: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] },
        { entities: [{ text: 'a' }, { text: 'b' }, { text: 'changed' }] },
      ),
    ).toEqual({
      path: 'entities[2].text',
      expected: 'c',
      actual: 'changed',
    })
  })

  it('配列長の差は最初の欠落 index を返す', () => {
    expect(findFirstDivergence([1, 2], [1])).toEqual({
      path: '[1]',
      expected: 2,
      actual: undefined,
    })
  })

  it('root の型または primitive が異なる場合は空 path を返す', () => {
    expect(findFirstDivergence({ value: 1 }, [1])).toEqual({
      path: '',
      expected: { value: 1 },
      actual: [1],
    })
    expect(findFirstDivergence('expected', 'actual')).toEqual({
      path: '',
      expected: 'expected',
      actual: 'actual',
    })
  })
})
