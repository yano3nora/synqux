import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHub, type MemoryHub } from '../testing/memory-hub.js'
import { APPLIED_WINDOW_SIZE } from './ordering.js'
import { selectIsHost, selectSelfId, selectSyncHealth } from './selectors.js'
import { parseSnapshotPayload } from './snapshot.js'
import { createHubClient, settle } from './test-fixtures.js'
import type { SynquxHealth } from './slice.js'

// fake timers 下でも simulation の CPU 実行時間が数秒かかるため、
// vitest デフォルト 5000ms では並列実行時に margin 不足で timeout する。
vi.setConfig({ testTimeout: 30_000 })

const INITIAL_CLIENT_COUNT = 4
const STALL_AFTER_MS = 3_000
const CHAOS_REQUEST_COUNT = 240
const JOIN_AFTER_REQUEST = 220
const SEEDS = [0x12345678, 0x9e3779b9, 0xdeadbeef] as const

type Client = ReturnType<typeof createHubClient>
type TrackedClient = {
  client: Client
  peerId: string
  dispatched: number
  phases: Set<SynquxHealth['phase']>
}
type DelayHandle = ReturnType<MemoryHub['faults']['delay']>
type FaultKind =
  | 'duplicate-added'
  | 'duplicate-changed'
  | 'delay-added'
  | 'delay-changed'

type Harness = {
  hub: MemoryHub
  groupId: string
  random: () => number
  allClients: TrackedClient[]
  activeClients: TrackedClient[]
  delays: DelayHandle[]
  injectedFaults: Record<FaultKind, number>
  disconnectedCount: number
  nextRequestSequence: number
}

/** mulberry32: 同じ seed から必ず同じ送信元・fault 列を生成する。 */
const createRandom = (seed: number): (() => number) => {
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(values: readonly T[], random: () => number): T => {
  const selected = values[Math.floor(random() * values.length)]
  if (selected === undefined) {
    throw new Error('Cannot pick from an empty collection')
  }
  return selected
}

const requestId = (sequence: number): string =>
  sequence.toString().padStart(12, '0')

const createHarness = async (
  scenario: number,
  seed: number,
): Promise<Harness> => {
  const hub = createMemoryHub()
  const groupId = `stress-${scenario}-${seed.toString(16)}`
  const allClients: TrackedClient[] = []

  for (let index = 0; index < INITIAL_CLIENT_COUNT; index += 1) {
    const client = createHubClient(hub, {
      stallAfterMs: STALL_AFTER_MS,
      // この test は reducer の乱数ではなく、同期 state machine を stress する。
      devDeterminismCheck: false,
    })
    await client.sync.subscribe({ store: client.store, groupId })
    const peerId = selectSelfId(client.store.getState())
    if (peerId === null) {
      throw new Error('Subscribed client has no peer id')
    }

    const tracked: TrackedClient = {
      client,
      peerId,
      dispatched: 0,
      phases: new Set(['ok']),
    }
    client.store.subscribe(() => {
      tracked.phases.add(selectSyncHealth(client.store.getState()).phase)
    })
    allClients.push(tracked)
  }
  await settle(10)

  return {
    hub,
    groupId,
    random: createRandom(seed),
    allClients,
    activeClients: [...allClients],
    delays: [],
    injectedFaults: {
      'duplicate-added': 0,
      'duplicate-changed': 0,
      'delay-added': 0,
      'delay-changed': 0,
    },
    disconnectedCount: 0,
    nextRequestSequence: 1,
  }
}

const addClient = async (harness: Harness): Promise<TrackedClient> => {
  const client = createHubClient(harness.hub, {
    stallAfterMs: STALL_AFTER_MS,
    devDeterminismCheck: false,
  })
  // 初回購読 barrier (ADR-0021) は backlog の適用完了を待つため settle を併走させる
  const subscribing = client.sync.subscribe({
    store: client.store,
    groupId: harness.groupId,
  })
  await settle()
  await subscribing
  const peerId = selectSelfId(client.store.getState())
  if (peerId === null) {
    throw new Error('Subscribed client has no peer id')
  }

  const tracked: TrackedClient = {
    client,
    peerId,
    dispatched: 0,
    phases: new Set(['ok']),
  }
  client.store.subscribe(() => {
    tracked.phases.add(selectSyncHealth(client.store.getState()).phase)
  })
  harness.allClients.push(tracked)
  harness.activeClients.push(tracked)
  await settle(20)
  return tracked
}

const currentHost = (harness: Harness): TrackedClient | undefined =>
  harness.activeClients.find(({ client }) =>
    selectIsHost(client.store.getState()),
  )

const disconnectHost = async (harness: Harness): Promise<void> => {
  if (harness.activeClients.length <= 2) {
    return
  }

  const host = currentHost(harness)
  if (host === undefined) {
    throw new Error('No host to disconnect')
  }

  harness.hub.faults.disconnect(host.peerId)
  harness.activeClients = harness.activeClients.filter(
    (tracked) => tracked !== host,
  )
  harness.disconnectedCount += 1
  await settle(10)
}

const injectTransientFault = (harness: Harness, id: string): void => {
  // fault の有無・種類・配送先をすべて seed 付き乱数で決める。
  if (harness.random() >= 0.12) {
    return
  }

  const kinds: readonly FaultKind[] = [
    'duplicate-added',
    'duplicate-changed',
    'delay-added',
    'delay-changed',
  ]
  const kind = pick(kinds, harness.random)
  const target = pick(harness.activeClients, harness.random)
  const event = kind.endsWith('added') ? 'added' : 'changed'

  if (kind.startsWith('duplicate')) {
    harness.hub.faults.duplicate({ requestId: id, to: target.peerId, event })
  } else {
    harness.delays.push(
      harness.hub.faults.delay({
        requestId: id,
        to: target.peerId,
        event,
      }),
    )
  }
  harness.injectedFaults[kind] += 1
}

const dispatchRequest = (
  harness: Harness,
  payload: number,
  options?: { sender?: TrackedClient; permanentDropTo?: TrackedClient },
): void => {
  const id = requestId(harness.nextRequestSequence)
  harness.nextRequestSequence += 1

  if (options?.permanentDropTo !== undefined) {
    harness.hub.faults.drop({
      requestId: id,
      to: options.permanentDropTo.peerId,
      event: 'changed',
    })
  } else {
    injectTransientFault(harness, id)
  }

  const sender = options?.sender ?? pick(harness.activeClients, harness.random)
  sender.client.store.dispatch({ type: 'game/increment', payload })
  sender.dispatched += 1
}

const runRequests = async (
  harness: Harness,
  from: number,
  to: number,
  options?: {
    disconnectAt?: ReadonlySet<number>
    permanentDrops?: ReadonlyMap<number, TrackedClient>
    firstSender?: TrackedClient
  },
): Promise<void> => {
  for (let payload = from; payload <= to; payload += 1) {
    // 現 host だけでなく、この後 host へ昇格して切断され得る端末も送信元から
    // 外す。プロセス死した端末の request を期待件数へ紛れ込ませず、終了時に
    // 「生存端末が dispatch した総数」をそのまま厳密に検証するため。
    const remainingDisconnects = [...(options?.disconnectAt ?? [])].filter(
      (point) => point >= payload,
    ).length
    const safeSenderCount = Math.max(
      1,
      harness.activeClients.length - remainingDisconnects,
    )
    const senders = harness.activeClients.slice(0, safeSenderCount)
    const sender =
      payload === from && options?.firstSender !== undefined
        ? options.firstSender
        : pick(
            senders.length > 0 ? senders : harness.activeClients,
            harness.random,
          )

    dispatchRequest(harness, payload, {
      sender,
      permanentDropTo: options?.permanentDrops?.get(payload),
    })

    // 複数 request を settle 前に投入し、host の直列裁定ゲートを並行負荷へ晒す。
    if (payload % 24 === 0) {
      await settle(2)
    }

    // delay は一過性 fault なので stall 閾値より前に定期解放する。末尾に
    // 残った handle は finishChaos が全解放し、release 漏れを防ぐ。
    if (payload % 48 === 0) {
      for (const delayed of harness.delays) {
        delayed.release()
      }
    }

    if (
      options?.disconnectAt?.has(payload) === true &&
      harness.random() < 0.85
    ) {
      await settle(5)
      await disconnectHost(harness)
    }
  }
}

const finishChaos = async (harness: Harness): Promise<void> => {
  for (const delayed of harness.delays) {
    delayed.release()
  }

  // stall 検知 → requests 再購読 → snapshot restore の 2 段階が完了する
  // 十分な仮想時間を進めた後、配送 queue と待機 fork を空にする。
  await vi.advanceTimersByTimeAsync(STALL_AFTER_MS * 3 + 4_000)
  await settle(20)
}

const expectFaultCoverage = (harness: Harness): void => {
  for (const count of Object.values(harness.injectedFaults)) {
    expect(count).toBeGreaterThan(0)
  }
}

const expectConverged = (
  harness: Harness,
  expectedRequestCount: number,
): void => {
  const [reference, ...others] = harness.activeClients
  if (reference === undefined) {
    throw new Error('No surviving clients')
  }

  const referenceGame = reference.client.store.getState().game
  expect(referenceGame.log).toHaveLength(expectedRequestCount)
  expect(new Set(referenceGame.log).size).toBe(expectedRequestCount)
  expect(
    harness.activeClients.reduce(
      (total, client) => total + client.dispatched,
      0,
    ),
  ).toBe(expectedRequestCount)

  for (const tracked of [reference, ...others]) {
    expect(tracked.client.store.getState().game).toEqual(referenceGame)
    expect(selectSyncHealth(tracked.client.store.getState()).phase).toBe('ok')
  }
}

const expectRetention = (harness: Harness): void => {
  const requests = harness.hub.inspect.requests(harness.groupId)
  expect(requests.length).toBeLessThanOrEqual(APPLIED_WINDOW_SIZE + 2)

  const snapshotPayload = harness.hub.inspect.snapshot(harness.groupId)
  if (snapshotPayload === null) {
    throw new Error('Host did not persist a snapshot')
  }
  const appliedSeq = parseSnapshotPayload(snapshotPayload).ordering.appliedSeq
  const seqs = requests.map(({ seq }) => {
    if (seq === undefined) {
      throw new Error('Unresponsed request remained after convergence')
    }
    return seq
  })

  // ADR-0005 は seq < boundary を prune し、boundary 自体は保持する。
  expect(Math.min(...seqs)).toBeGreaterThanOrEqual(
    appliedSeq - APPLIED_WINDOW_SIZE,
  )
}

/**
 * 実証マップ:
 * - scenario 1/2/3: 全端末の適用列完全一致 + request の高々 1 回適用
 * - scenario 1/3: ADR-0005 retention prune + prune 後の途中参加収束
 * - scenario 2: ADR-0003 の stall 検知 + ADR-0004 のリロードなし自動回復
 *
 * Firebase adapter 固有の prune logs 退避と presence 再登録は対象外。
 * これらは adapter unit test が担保し、本 test は transport 非依存 core に集中する。
 */
describe('multi-client stress simulation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it.each(SEEDS)(
    'scenario 1: transient chaos converges with retention (seed=%i)',
    async (seed) => {
      expect.hasAssertions()
      const harness = await createHarness(1, seed)
      await runRequests(harness, 1, CHAOS_REQUEST_COUNT, {
        disconnectAt: new Set([80, 160]),
      })
      await finishChaos(harness)

      expectFaultCoverage(harness)
      expect(harness.disconnectedCount).toBeGreaterThan(0)
      expectConverged(harness, CHAOS_REQUEST_COUNT)
      expectRetention(harness)
    },
  )

  it.each(SEEDS)(
    'scenario 2: permanent drops trigger detection and auto recovery (seed=%i)',
    async (seed) => {
      expect.hasAssertions()
      const harness = await createHarness(2, seed)
      const initialHost = currentHost(harness)
      const dropCandidates = harness.activeClients.filter(
        (client) => client !== initialHost,
      )
      const permanentDrops = new Map<number, TrackedClient>([
        [33, pick(dropCandidates, harness.random)],
        [97, pick(dropCandidates, harness.random)],
        [171, pick(dropCandidates, harness.random)],
      ])

      await runRequests(harness, 1, CHAOS_REQUEST_COUNT, {
        disconnectAt: new Set([80, 160]),
        permanentDrops,
      })
      await finishChaos(harness)

      expectFaultCoverage(harness)
      expect(harness.disconnectedCount).toBeGreaterThan(0)
      expect(
        harness.allClients.some(({ phases }) =>
          [...phases].some((phase) => phase !== 'ok'),
        ),
      ).toBe(true)
      expectConverged(harness, CHAOS_REQUEST_COUNT)
    },
  )

  it.each(SEEDS)(
    'scenario 3: a client joining after prune converges (seed=%i)',
    async (seed) => {
      expect.hasAssertions()
      const harness = await createHarness(3, seed)
      await runRequests(harness, 1, JOIN_AFTER_REQUEST, {
        disconnectAt: new Set([80, 160]),
      })
      await settle(20)

      const joined = await addClient(harness)
      const joinedState = joined.client.store.getState().game
      expect(joinedState.log).toHaveLength(JOIN_AFTER_REQUEST)
      expect(joinedState.count).toBe(
        (JOIN_AFTER_REQUEST * (JOIN_AFTER_REQUEST + 1)) / 2,
      )

      await runRequests(harness, JOIN_AFTER_REQUEST + 1, CHAOS_REQUEST_COUNT, {
        firstSender: joined,
      })
      await finishChaos(harness)

      expectFaultCoverage(harness)
      expect(harness.disconnectedCount).toBeGreaterThan(0)
      expect(joined.dispatched).toBeGreaterThan(0)
      expectConverged(harness, CHAOS_REQUEST_COUNT)
      expectRetention(harness)
    },
  )
})
