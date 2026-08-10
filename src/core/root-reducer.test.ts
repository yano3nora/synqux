import type { Reducer, UnknownAction } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { stateWithError } from './results.js'
import { createSynquxRootReducer } from './root-reducer.js'
import { synquxRestored } from './slice.js'
import type { SynquxSynced } from './types.js'

type Synced = SynquxSynced & { count: number; sawRootMeta: boolean }

const syncedInitial: Synced = { result: null, count: 0, sawRootMeta: false }

const syncedReducer: Reducer<Synced> = (state = syncedInitial, action) => {
  if (action.type === 'game/reject') {
    return stateWithError({ ...state }, action, {
      message: { text: 'rejected' },
    })
  }

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
    isSyncedAction,
    synced: { game: syncedReducer },
    locals: { first: firstLocalReducer, second: secondLocalReducer },
  })

const isSyncedAction = (action: {
  type: string
}): action is { type: `game/${string}`; meta?: { hash?: string } } =>
  action.type.startsWith('game/')

describe('createSynquxRootReducer', () => {
  it('result を書かない synced action に action 自身の default success を残す', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const action = {
      type: 'game/increment' as const,
      meta: { hash: 'hash-success' },
    }

    const next = rootReducer(initial, action)

    expect(next.game.result).toMatchObject({
      type: 'success',
      action: { type: action.type, meta: { hash: action.meta.hash } },
    })
  })

  it('stateWithError は default success stamp を上書きして error を残す', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const next = rootReducer(initial, {
      type: 'game/reject',
      meta: { hash: 'hash-error' },
    })

    expect(next.game.result).toMatchObject({
      type: 'error',
      action: { type: 'game/reject', meta: { hash: 'hash-error' } },
      message: { text: 'rejected' },
    })
  })

  it('synced action でない action は result を変更しない', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const rejected = rootReducer(initial, { type: 'game/reject' })
    const next = rootReducer(rejected, { type: 'local/noop' })

    expect(next).toBe(rejected)
    expect(next.game.result).toBe(rejected.game.result)
  })

  it('残留 error の後に result を書かない synced action を適用すると success へ更新する', () => {
    const { rootReducer } = setup()
    const initial = rootReducer(undefined, { type: '@@INIT' })
    const rejected = rootReducer(initial, { type: 'game/reject' })
    const next = rootReducer(rejected, {
      type: 'game/increment',
      meta: { hash: 'hash-after-error' },
    })

    expect(next.game.count).toBe(1)
    expect(next.game.result).toMatchObject({
      type: 'success',
      action: {
        type: 'game/increment',
        meta: { hash: 'hash-after-error' },
      },
    })
  })

  it('isSyncedAction は渡した述語と同一参照で返す', () => {
    expect(setup().isSyncedAction).toBe(isSyncedAction)
  })

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
        isSyncedAction,
        synced: {
          a: syncedReducer,
          b: syncedReducer,
        } as never,
        locals: {},
      }),
    ).toThrow('exactly one synced slice')
  })
})
