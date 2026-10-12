import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub } from '../testing/memory-hub.js'
import { selectIsHost } from './selectors.js'
import { synquxActions } from './slice.js'
import {
  createClient,
  createHubClient,
  settle,
  type GameAction,
  type GameState,
} from './test-fixtures.js'
import type { SyncedActionMeta } from './action.js'
import type { SynquxAutomation } from './create-synqux.js'
import type { RequestEnvelope } from './types.js'

const GROUP_ID = 'group-automations'
const START = new Date('2026-08-11T00:00:00.000Z').getTime()

const incrementOnce = (
  overrides?: Partial<SynquxAutomation<GameState, GameAction>>,
): SynquxAutomation<GameState, GameAction> => ({
  id: 'increment-once',
  retryMs: 100,
  when: (synced) => synced.count === 0,
  action: () => ({ type: 'game/increment-once' }),
  ...overrides,
})

describe('automations', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('サーバ時刻が閾値を超えると発行し、適用後 when=false なら再発行しない', async () => {
    const hub = createMemoryHub()
    const transport = hub.createTransport()
    const serverNow = vi.spyOn(transport, 'serverNow')
    const client = createClient(transport, {
      automations: [
        incrementOnce({
          when: (synced, { now }) => synced.count === 0 && now >= START + 1000,
        }),
      ],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(999)
    expect(client.store.getState().game.count).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await settle(20)
    expect(client.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    const callsBeforeIdle = serverNow.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    // tick は止まらず、各 evaluation path が serverNow を 1 回だけ読む。
    expect(serverNow.mock.calls.length).toBeGreaterThan(callsBeforeIdle)

    await unsubscribe()
    const callsAfterUnsubscribe = serverNow.mock.calls.length
    await vi.advanceTimersByTimeAsync(500)
    expect(serverNow).toHaveBeenCalledTimes(callsAfterUnsubscribe)
  })

  it('最初の request 配送が drop されても retryMs 後に再発行して適用する', async () => {
    const hub = createMemoryHub()
    const client = createHubClient(hub, { automations: [incrementOnce()] })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(0)
    hub.faults.drop({
      requestId: '000000000001',
      to: 'peer-1',
      event: 'added',
    })

    await vi.advanceTimersByTimeAsync(100)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    expect(client.store.getState().game.count).toBe(0)

    await vi.advanceTimersByTimeAsync(100)
    await settle(20)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)
    expect(client.store.getState().game.count).toBe(1)
  })

  it('非 host は発行せず、host migration 後の新 host が state だけから発行する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { automations: [incrementOnce()] })
    const b = createHubClient(hub, {
      automations: [incrementOnce()],
      canRequest: () => false,
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await settle(5)

    expect(selectIsHost(a.store.getState())).toBe(false)
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(hub.inspect.requests(GROUP_ID)).toEqual([])

    hub.faults.disconnect('peer-2')
    await settle(10)

    expect(selectIsHost(a.store.getState())).toBe(true)
    expect(a.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)
    expect(hub.inspect.requests(GROUP_ID)[0]?.requestedBy).toBe('peer-1')
  })

  it('dual-host 相当の二重発行も rejects-repeat reducer により 1 回適用へ収束する', async () => {
    // dual-host 窓ではシナリオ上 determinism check のエラーログが発生するため黙殺する
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const automation = incrementOnce({ retryMs: 10_000 })
    const a = createHubClient(hub, { automations: [automation] })
    const b = createHubClient(hub, { automations: [automation] })
    const c = createHubClient(hub, { automations: [automation] })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    // b だけが c の presence を失った観測窓を作り、b/c が同時に host を自認する。
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(selectIsHost(c.store.getState())).toBe(true)

    await vi.advanceTimersByTimeAsync(9500)
    await settle(40)

    expect(hub.inspect.requests(GROUP_ID).length).toBeGreaterThanOrEqual(2)
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(1)
      expect(client.store.getState().game.log).toEqual(['increment-once'])
    }
  })

  it('instance / session 指定の standalone で評価を続け local 適用する', async () => {
    const standaloneHub = createMemoryHub()
    const standaloneTransport = standaloneHub.createTransport()
    const standaloneServerNow = vi.spyOn(standaloneTransport, 'serverNow')
    const standalone = createClient(standaloneTransport, {
      mode: 'standalone',
      automations: [incrementOnce()],
    })

    await standalone.sync.subscribe({
      store: standalone.store,
      groupId: 'standalone',
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(standalone.store.getState().game.count).toBe(1)
    expect(standaloneServerNow).not.toHaveBeenCalled()
    expect(standaloneHub.inspect.requests('standalone')).toEqual([])

    const sessionHub = createMemoryHub()
    const sessionStandalone = createHubClient(sessionHub, {
      automations: [incrementOnce()],
    })
    await sessionStandalone.sync.subscribe({
      store: sessionStandalone.store,
      groupId: 'session-standalone',
      mode: 'standalone',
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(sessionStandalone.store.getState().game.count).toBe(1)
    expect(sessionHub.inspect.requests('session-standalone')).toEqual([])
  })

  it('when が throw する rule を記録して skip し、他 rule は動かし続ける', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const thrown = new Error('broken predicate')
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      automations: [
        incrementOnce({
          id: 'broken',
          when: () => {
            throw thrown
          },
        }),
        incrementOnce({ id: 'healthy' }),
      ],
    })

    await client.sync.subscribe({ store: client.store, groupId: GROUP_ID })
    await vi.advanceTimersByTimeAsync(100)
    await settle(20)

    expect(consoleError).toHaveBeenCalledWith(thrown)
    expect(client.store.getState().game.count).toBe(1)
  })

  it('validatorOf が拒否する間は発行せず lastIssuedAt も進めない。warn は遷移時 1 回だけ (ADR-0031)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let blocked = true
    const validate = vi.fn(
      (_synced: GameState, _payload: unknown, _meta?: SyncedActionMeta) =>
        blocked ? 'blocked' : null,
    )
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      validatorOf: (type) => (type === 'game/increment' ? validate : undefined),
      automations: [
        {
          id: 'always',
          // interval を 1000ms にし、適用後の再評価 (evaluateAfterApply) と区別する
          retryMs: 1000,
          when: () => true,
          action: () => ({ type: 'game/increment', payload: 1 }),
        },
      ],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(1000)
    await settle(5)

    // 止まっている: request は流れず、warn は 1 回
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('"always"')
    expect(warn.mock.calls[0]?.[0]).toContain('blocked')

    // pre-check の meta は実 request と同じ生成規則 (hash / dispatched / requestedBy)
    const meta = validate.mock.lastCall?.[2]
    expect(typeof meta?.hash).toBe('string')
    expect(meta?.dispatched).toBe(START + 1000)
    expect(meta?.requestedBy).toBe(
      client.store.getState().synqux.connections.selfId,
    )

    // 止まり続けても warn は増えない
    await vi.advanceTimersByTimeAsync(500)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(0)

    // 解除後、user の dispatch 適用で再評価される。止まっていた間に lastIssuedAt が
    // 進んでいないので、retryMs (1000ms) を待たずに即発行される
    blocked = false
    client.store.dispatch({ type: 'game/increment', payload: 0 })
    await settle(10)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)
    expect(client.store.getState().game.count).toBe(1)

    // 再び止まると、次の評価で遷移としてもう 1 回だけ warn する
    blocked = true
    await vi.advanceTimersByTimeAsync(1500)
    await settle(5)
    expect(warn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(2)

    await unsubscribe()
  })

  it('validate が throw する rule は console.error して skip し、他 rule は動く', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const thrown = new Error('validate failed')
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      validatorOf: (type) =>
        type === 'game/broken'
          ? () => {
              throw thrown
            }
          : undefined,
      automations: [
        incrementOnce({
          id: 'broken',
          action: () => ({ type: 'game/broken' }),
        }),
        incrementOnce(),
      ],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(100)
    await settle(20)

    expect(consoleError).toHaveBeenCalledWith(thrown)
    expect(client.store.getState().game.count).toBe(1)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(1)

    await unsubscribe()
  })

  it('automation id が重複していれば createSynqux が同期的に throw する', () => {
    const hub = createMemoryHub()

    expect(() =>
      createHubClient(hub, {
        automations: [incrementOnce(), incrementOnce()],
      }),
    ).toThrow('Duplicate SynquxAutomation id: increment-once')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'retryMs=%s は正の有限数でないため createSynqux が同期的に throw する',
    (retryMs) => {
      const hub = createMemoryHub()

      expect(() =>
        createHubClient(hub, {
          automations: [incrementOnce({ retryMs })],
        }),
      ).toThrow('SynquxAutomation retryMs must be a positive finite number')
    },
  )
})

/**
 * 多段依存チェーン: 移植元系列 consumer の bot (前段の適用結果が次段の発行条件になる
 * 多段 dispatch を host が回す) を automations で表現したとき、host migration・
 * 遅配・重複・dual-host を跨いでも各段が 1 回ずつ適用されて完走することを検証する。
 * 段の間隔を時間で開け、障害を挟む位置を決定的にしている
 */
describe('automations 多段依存チェーン', () => {
  const CHAIN_START = START + 1000
  const STAGE_MS = 5000
  const STEPS = [1, 2, 3] as const

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const stepChain = (): SynquxAutomation<GameState, GameAction>[] =>
    STEPS.map((step) => ({
      id: `step-${String(step)}`,
      // 評価 tick は min(retryMs) なので、時間ゲートが settle 内で評価される幅にする
      retryMs: 500,
      when: (synced, { now }) =>
        now >= CHAIN_START + (step - 1) * STAGE_MS && synced.count === step - 1,
      action: () => ({ type: 'game/step', payload: step }),
    }))

  const stageAt = (step: number): number => CHAIN_START + (step - 1) * STAGE_MS

  const advanceTo = async (time: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(Math.max(0, time - Date.now()))
  }

  const expectCompleted = (
    client: ReturnType<typeof createHubClient>,
  ): void => {
    expect(client.store.getState().game.count).toBe(3)
    expect(client.store.getState().game.log).toEqual([
      'step:1',
      'step:2',
      'step:3',
    ])
  }

  it('host migration・裁定の遅配・added の重複を跨いで各段が 1 回ずつ適用され完走する', async () => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { automations: stepChain() })
    const b = createHubClient(hub, { automations: stepChain() })
    const c = createHubClient(hub, { automations: stepChain() })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)
    expect(selectIsHost(c.store.getState())).toBe(true)

    // a には step-2 の裁定を遅配し、step-3 の added は全端末へ二重配送する
    const delayed = hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-1',
      event: 'changed',
    })
    hub.faults.duplicate({ requestId: '000000000003', event: 'added' })

    await advanceTo(stageAt(1))
    await settle(10)
    for (const client of [a, b, c]) {
      expect(client.store.getState().game.count).toBe(1)
    }

    // step-1 と step-2 の間で host が落ち、b が state だけから続きを回す
    hub.faults.disconnect('peer-3')
    await settle(10)
    expect(selectIsHost(b.store.getState())).toBe(true)

    await advanceTo(stageAt(2))
    await settle(10)
    await advanceTo(stageAt(3))
    await settle(10)

    // 遅配された a は step-2 待ちで step-3 を先行適用しない (線形化)
    expect(a.store.getState().game.count).toBe(1)
    expectCompleted(b)

    delayed.release()
    await settle()
    expectCompleted(a)

    const requests = hub.inspect.requests(GROUP_ID)
    expect(requests).toHaveLength(3)
    expect(requests.map((request) => request.responsedBy)).toEqual([
      'peer-3',
      'peer-2',
      'peer-2',
    ])
  })

  /**
   * 遅れ端末 (裁定 changed が未着) の host 昇格。再現テストと完走テストに分ける:
   * it.fails は最初の assertion 失敗で終わるため、封筒の不変条件だけを見る
   */
  const promoteLaggingHost = async (): Promise<{
    hub: ReturnType<typeof createMemoryHub>
    a: ReturnType<typeof createHubClient>
    b: ReturnType<typeof createHubClient>
    delayed: { release(): void }
    /** 前 host が確定した step-2 の response 封筒 (deep copy) */
    frozen: RequestEnvelope
  }> => {
    const hub = createMemoryHub()
    const a = createHubClient(hub, { automations: stepChain() })
    const b = createHubClient(hub, { automations: stepChain() })
    const c = createHubClient(hub, { automations: stepChain() })

    // b だけ step-2 の裁定が届かない (バックグラウンドタブの適用遅延の模擬)。
    // step-1 は届いているので、b は epoch 1 を観測済みのまま遅れて昇格する
    const delayed = hub.faults.delay({
      requestId: '000000000002',
      to: 'peer-2',
      event: 'changed',
    })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    await advanceTo(stageAt(1))
    await settle(10)
    await advanceTo(stageAt(2))
    await settle(10)
    expect(a.store.getState().game.count).toBe(2)
    expect(c.store.getState().game.count).toBe(2)
    expect(b.store.getState().game.count).toBe(1)

    const frozen = hub.inspect.requests(GROUP_ID)[1]
    if (frozen === undefined) {
      throw new Error('step-2 request is missing')
    }
    expect(frozen).toMatchObject({ responsedBy: 'peer-3', seq: 2 })

    // 遅れたまま b が host 化する
    hub.faults.disconnect('peer-3')
    await settle(10)
    expect(selectIsHost(b.store.getState())).toBe(true)

    return { hub, a, b, delayed, frozen }
  }

  /**
   * ADR-0029 の再現テスト (移植元系列 consumer の issue と同型): 新 host は裁定
   * (changed) が未着の request を「未裁定」とみなして再裁定するが、respond CAS
   * (契約 18) が自分の観測していない確定済み response の置換を拒否し、catch-up
   * barrier が耐久化済み位置まで裁定を止める
   */
  it('適用が遅れた端末が host に昇格しても、前 host の確定済み response を再裁定で上書きしない', async () => {
    const { hub, frozen } = await promoteLaggingHost()

    // 「未裁定」として観測した caller は、保存済み response を置換できない
    // (観測済み敗者の正当な再裁定とは区別する。ADR-0010 Decision 1)
    const current = hub.inspect.requests(GROUP_ID)[1]
    expect({
      epoch: current?.epoch,
      seq: current?.seq,
      responsedBy: current?.responsedBy,
      responsed: current?.responsed,
      result: current?.result,
    }).toEqual({
      epoch: frozen.epoch,
      seq: frozen.seq,
      responsedBy: frozen.responsedBy,
      responsed: frozen.responsed,
      result: frozen.result,
    })
  })

  it('適用が遅れた端末が host に昇格しても、追いついた後にチェーンを完走する', async () => {
    const { hub, a, b, delayed } = await promoteLaggingHost()

    delayed.release()
    await settle(10)
    await advanceTo(stageAt(3))
    await settle(10)

    expectCompleted(a)
    expectCompleted(b)
    for (const request of hub.inspect.requests(GROUP_ID)) {
      expect(request.seq).toBeDefined()
    }
  })

  it('dual-host 窓の中でも各段の二重発行が 1 回適用へ収束し完走する', async () => {
    // dual-host 窓ではシナリオ上 determinism check のエラーログが発生するため黙殺する
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const a = createHubClient(hub, { automations: stepChain() })
    const b = createHubClient(hub, { automations: stepChain() })
    const c = createHubClient(hub, { automations: stepChain() })

    await a.sync.subscribe({ store: a.store, groupId: GROUP_ID })
    await b.sync.subscribe({ store: b.store, groupId: GROUP_ID })
    await c.sync.subscribe({ store: c.store, groupId: GROUP_ID })
    await settle(5)

    // b だけが c の presence を失った観測窓を作り、b/c が同時に host を自認する
    b.store.dispatch(synquxActions.peerRemoved('peer-3'))
    expect(selectIsHost(b.store.getState())).toBe(true)
    expect(selectIsHost(c.store.getState())).toBe(true)

    for (const step of STEPS) {
      await advanceTo(stageAt(step))
      await settle(20)
    }

    // 各段が両 host から発行され (二重発行)、それでも各段 1 回の適用へ収束する
    for (const step of STEPS) {
      const issuers = hub.inspect
        .requests(GROUP_ID)
        .filter(
          (request) => JSON.parse(String(request.action.payload)) === step,
        )
        .map((request) => request.requestedBy)
      expect(issuers).toEqual(expect.arrayContaining(['peer-2', 'peer-3']))
    }
    // 敗者 request も裁定済み (未裁定の滞留なし) で収束する
    for (const request of hub.inspect.requests(GROUP_ID)) {
      expect(request.seq).toBeDefined()
      expect(request.responsedBy).toBeDefined()
    }
    for (const client of [a, b, c]) {
      expectCompleted(client)
    }
  })
})

describe('automations validate pre-check (ADR-0031)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('standalone でも pre-check の dispatched と適用された action の dispatched が一致する', async () => {
    const validate = vi.fn(
      (_synced: GameState, _payload: unknown, _meta?: SyncedActionMeta) => null,
    )
    const hub = createMemoryHub()
    const client = createHubClient(hub, {
      mode: 'standalone',
      validatorOf: () => validate,
      automations: [
        incrementOnce({
          // consumer が焼いた古い dispatched は now で上書きされる
          action: () => ({
            type: 'game/increment-once',
            meta: { hash: 'fixed-hash', dispatched: 0 },
          }),
        }),
      ],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(100)
    await settle(5)

    const game = client.store.getState().game
    expect(game.count).toBe(1)
    const applied = game.result?.action.meta
    expect(applied?.hash).toBe('fixed-hash')
    expect(applied?.dispatched).toBe(validate.mock.lastCall?.[2]?.dispatched)
    expect(applied?.dispatched).toBeGreaterThanOrEqual(START)

    await unsubscribe()
  })

  it('replaceRules で消した rule を同じ id で戻すと、拒否中なら初回 warn が再び出る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const hub = createMemoryHub()
    const rule = incrementOnce({
      id: 'blocked',
      when: () => true,
      action: () => ({ type: 'game/increment', payload: 1 }),
    })
    const client = createHubClient(hub, {
      validatorOf: (type) =>
        type === 'game/increment' ? () => 'blocked' : undefined,
      automations: [rule],
    })

    const unsubscribe = await client.sync.subscribe({
      store: client.store,
      groupId: GROUP_ID,
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(warn).toHaveBeenCalledTimes(1)

    client.sync.replaceRules({ automations: [] })
    client.sync.replaceRules({ automations: [rule] })
    await vi.advanceTimersByTimeAsync(100)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(hub.inspect.requests(GROUP_ID)).toHaveLength(0)

    await unsubscribe()
  })
})
