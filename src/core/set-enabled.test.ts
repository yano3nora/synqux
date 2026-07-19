import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { createHubClient, settle } from './test-fixtures.js'
import type { SnapshotStore } from './types.js'

/**
 * runtime の setEnabled on/off (tutorial 用途) の契約を固定する simulation
 * (SPEC-0001「setEnabled の契約」)
 *
 * setEnabled(false) は「自端末の synced action を request 化せず local 適用する」
 * 送信ゲートであり、受信 request の適用・host 責務・購読は止まらない。
 * 移植元 (_prepareTutorial) と同じセマンティクスで、tutorial は
 * 「同期グループが動いていない状況」で使う前提
 */

const GROUP_ID = 'group-tutorial'

describe('setEnabled (runtime on/off)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('off 中の synced action は request 化されず local にのみ即時適用され、localSnapshots にも保存しない', async () => {
    const saveSnapshot = vi.fn()
    const localSnapshots: SnapshotStore = {
      saveSnapshot,
      loadSnapshot: () => null,
    }

    const hub = createMemoryHub()
    const a = createHubClient(hub, { localSnapshots })
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(a.sync.actions.setEnabled(false))
    a.store.dispatch({ type: 'game/increment', payload: 5 })

    // request 化を通らないため楽観更新なしの原則の例外になる (local 即時適用)
    expect(a.store.getState().game.count).toBe(5)

    await settle()

    // transport に request は積まれず、他端末は影響を受けない
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(0)
    expect(b.store.getState().game.count).toBe(0)

    // runtime off は standalone (instance enabled: false) と違い永続化もしない
    expect(saveSnapshot).not.toHaveBeenCalled()
  })

  it('off は送信ゲートのみ: 他端末発の request の受信・適用は継続し、local 乖離が残る', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    a.store.dispatch(a.sync.actions.setEnabled(false))
    a.store.dispatch({ type: 'game/increment', payload: 5 })

    // off 中でも b 発の request は a にも適用される (購読・適用は止まらない)
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()

    expect(a.store.getState().game.count).toBe(15) // 5 (local) + 10 (sync)
    expect(b.store.getState().game.count).toBe(10)

    // on へ戻すと request 化は再開するが、off 中の local 乖離は残り続ける。
    // 正史 (host + snapshot) は local 乖離を知らないため、以降の同期適用も
    // 乖離した土台の上に乗る — tutorial 後の復帰は再 subscribe で行うこと
    a.store.dispatch(a.sync.actions.setEnabled(true))
    a.store.dispatch({ type: 'game/increment', payload: 1 })
    await settle()

    expect(a.store.getState().game.count).toBe(16)
    expect(b.store.getState().game.count).toBe(11)
  })

  it('off 中も host 責務は継続し、自端末が host だと乖離 state を土台に裁定され正史が汚染される', async () => {
    const hub = createMemoryHub()
    const b = createHubClient(hub)
    const a = createHubClient(hub)

    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    // 最新接続の player = a が host になる
    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await settle()

    // host 導出は peer pool の全端末合意で、enabled は端末 local のため
    // off にしても host 候補からは外れない (外すと他端末との合意が壊れる)
    a.store.dispatch(a.sync.actions.setEnabled(false))
    a.store.dispatch({ type: 'game/increment', payload: 5 })

    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()

    // host (a) は乖離 state (5) を土台に試し実行して snapshot を保存するため
    // 正史は 15 になる一方、b は自分の state へ適用して 10 — 正史が割れる。
    // これが「グループ稼働中の setEnabled(false) 禁止」の理由 (SPEC-0001)
    expect(a.store.getState().game.count).toBe(15)
    expect(b.store.getState().game.count).toBe(10)

    const c = createHubClient(hub)
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle()
    expect(c.store.getState().game.count).toBe(15) // 汚染 snapshot を引き継ぐ
  })

  it('tutorial 後の復帰: リロード相当の新規 subscribe で snapshot の正史へ戻る', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub)
    const b = createHubClient(hub)

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle()

    // 正史を 1 手進めてから a が tutorial (off + local 乖離) に入る
    b.store.dispatch({ type: 'game/increment', payload: 10 })
    await settle()

    a.store.dispatch(a.sync.actions.setEnabled(false))
    a.store.dispatch({ type: 'game/increment', payload: 5 })
    expect(a.store.getState().game.count).toBe(15)

    // 復帰はリロード相当 (新しい client / store で subscribe し直す)。
    // snapshot restore が正史を全量で上書きするため乖離が残らない
    const a2 = createHubClient(hub)
    await a2.sync.subscribe({ store: a2.store, groupId: GROUP_ID })
    await settle()

    expect(a2.store.getState().game.count).toBe(10)
    expect(a2.store.getState().game.log).toEqual(['increment:10'])
  })
})
