import type { Reducer, UnknownAction } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { createSynquxRootReducer } from './root-reducer.js'
import { synquxRestored } from './slice.js'
import type { SynquxSynced } from './types.js'

type Synced = SynquxSynced & { count: number; sawRootMeta: boolean }

const syncedInitial: Synced = { result: null, count: 0, sawRootMeta: false }

const syncedReducer: Reducer<Synced> = (state = syncedInitial, action) => {
  if (action.type !== 'game/increment') {
    return state
  }

  return {
    ...state,
    count: state.count + 1,
    // 決定性契約の検証用: synced に meta.root が渡ってきたら記録する (来ないのが正)
    sawRootMeta:
      (action as UnknownAction).meta !== undefined &&
      'root' in ((action as UnknownAction).meta as object),
  }
}

// locals: meta.root から「適用後の synced」と「前段の local」を読む
type FirstLocal = { syncedCountSeen: number }
type SecondLocal = { firstSeen: number; restoredCount: number | null }

const firstLocalReducer: Reducer<FirstLocal> = (
  state = { syncedCountSeen: -1 },
  action,
) => {
  const root = ((action as UnknownAction).meta as { root?: { game: Synced } })
    ?.root

  if (action.type !== 'game/increment' || !root) {
    return state
  }

  return { syncedCountSeen: root.game.count }
}

const secondLocalReducer: Reducer<SecondLocal> = (
  state = { firstSeen: -1, restoredCount: null },
  action,
) => {
  const root = (
    (action as UnknownAction).meta as {
      root?: { game: Synced; first: FirstLocal }
    }
  )?.root

  if (synquxRestored.match(action) && root) {
    // restore にも meta.root 経由で反応できる
    return { ...state, restoredCount: root.game.count }
  }

  if (action.type !== 'game/increment' || !root) {
    return state
  }

  // 宣言順で自分より前に実行された first の「更新後」の値が読める
  return { ...state, firstSeen: root.first.syncedCountSeen }
}

const setup = () =>
  createSynquxRootReducer({
    synced: { game: syncedReducer },
    locals: { first: firstLocalReducer, second: secondLocalReducer },
  })

describe('createSynquxRootReducer', () => {
  it('synced には meta.root を渡さず、locals には直列進行に応じた root を渡す', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const next = rootReducer(initial, { type: 'game/increment' })

    // synced reducer は素の action を受け取る (決定性の構成的保証)
    expect(next.game.count).toBe(1)
    expect(next.game.sawRootMeta).toBe(false)

    // first は「適用後の synced」を読める
    expect(next.first.syncedCountSeen).toBe(1)

    // second は「自分より前に実行された first の更新後の値」を読める
    expect(next.second.firstSeen).toBe(1)
  })

  it('dispatch した action object 自体は汚染しない (meta.root は reducer 呼び出しごとの複製に付く)', () => {
    const { rootReducer } = setup()
    const action = { type: 'game/increment' }

    rootReducer(rootReducer(undefined, { type: '@@INIT' }), action)

    expect('meta' in action).toBe(false)
  })

  it('synquxRestored で synced subtree を全量差し替え、locals は meta.root で復元後の synced に反応できる', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })

    const restored = rootReducer(
      initial,
      synquxRestored({
        synced: { result: null, count: 42, sawRootMeta: false },
      }),
    )

    expect(restored.game.count).toBe(42)
    expect(restored.second.restoredCount).toBe(42)
  })

  it('どの slice にも変化がない action では state の参照を維持する', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const next = rootReducer(initial, { type: 'unrelated/noop' })

    expect(next).toBe(initial)
  })

  it('selectSynced は synced slice を返す', () => {
    const { rootReducer, selectSynced } = setup()
    const state = rootReducer(undefined, { type: '@@INIT' })

    expect(selectSynced(state)).toBe(state.game)
  })

  it('synced slice が 1 エントリでなければ throw する (v1 制約)', () => {
    expect(() =>
      createSynquxRootReducer({
        synced: {
          a: syncedReducer,
          b: syncedReducer,
        } as never,
        locals: {},
      }),
    ).toThrow('exactly one synced slice')
  })
})
