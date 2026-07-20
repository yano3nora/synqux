import type {
  Peer,
  RequestEnvelope,
  SnapshotFence,
  SynquxTransport,
} from '../core/types.js'

export type FaultTarget = {
  requestId: RequestEnvelope['id']
  /** 対象端末の peer id。省略時は 1 fan-out の全端末配送へ適用して消費 */
  to?: Peer['id']
  /** 対象イベント種別。省略時は added / changed の両方が対象 */
  event?: 'added' | 'changed'
}

export type MemoryHub = {
  /** 仮想端末 1 台ぶんの transport を生成する。テストでは端末数ぶん作る */
  createTransport(): SynquxTransport

  faults: {
    /** 次の該当配送を二重化する。to 省略時は 1 fan-out の全端末配送へ適用して消費 */
    duplicate(target: FaultTarget): void
    /** 該当配送を保留し、release() で保留分を元の順序のまま解放する */
    delay(target: FaultTarget): { release(): void }
    /** 次の該当配送を破棄する。to 省略時は 1 fan-out の全端末配送へ適用して消費 */
    drop(target: FaultTarget): void
    /** respondRequest の resolve (ack) だけを保留する。変更イベントの配送は保留しない */
    holdAck(requestId: RequestEnvelope['id']): { release(): void }
    /** 該当 respondRequest を指定回数 reject し、request の更新も配送も行わない */
    failRespond(
      requestId: RequestEnvelope['id'],
      options?: { times?: number },
    ): void
    /** 次の該当 respondRequest は更新・配送し、ack だけを reject する */
    loseAck(requestId: RequestEnvelope['id']): void
    /** saveSnapshot を指定回数 reject し、snapshot を更新しない */
    failSnapshot(options?: { times?: number }): void
    /** 該当端末の snapshot 書き込みを保留し、release 時に呼び出し順で着地させる */
    holdSnapshot(peerId: Peer['id']): { release(): void }
    /** 端末側の disconnect() を経ない切断 (プロセス死の模擬)。presence cleanup として全端末へ onRemoved を配送する */
    disconnect(peerId: Peer['id']): void
  }

  /** テストの assert 用の覗き窓。返り値はすべて deep copy */
  inspect: {
    requests(groupId: string): RequestEnvelope[]
    peers(groupId: string): Peer[]
    snapshot(key: string): string | null
  }
}

type PeerHandlers = Parameters<SynquxTransport['subscribePeers']>[0]
type RequestHandlers = Parameters<SynquxTransport['subscribeRequests']>[1]
type RequestEvent = 'added' | 'changed'

type PeerSubscriber = {
  id: number
  groupId: string
  peerId: Peer['id']
  active: boolean
  kind: 'peers'
  handlers: PeerHandlers
  queue: (() => void)[]
  scheduled: boolean
}

type RequestSubscriber = {
  id: number
  groupId: string
  peerId: Peer['id']
  active: boolean
  kind: 'requests'
  handlers: RequestHandlers
  queue: (() => void)[]
  scheduled: boolean
}

type Subscriber = PeerSubscriber | RequestSubscriber

type GroupState = {
  peers: Peer[]
  requests: RequestEnvelope[]
  peerSubscribers: PeerSubscriber[]
  requestSubscribers: RequestSubscriber[]
}

type OneShotFault = {
  target: FaultTarget
  consumedDeliveryId: number | null
}

type DelayFault = {
  target: FaultTarget
  released: boolean
  buffered: (() => void)[]
}

type AckHold = {
  released: boolean
  resolvers: (() => void)[]
}

type SnapshotHold = {
  released: boolean
  buffered: (() => void)[]
}

type StoredSnapshot = { fence: SnapshotFence; payload: string }

type CountedFailure = {
  remaining: number
}

const clone = <T>(value: T): T => structuredClone(value)

const formatRequestId = (sequence: number): string =>
  sequence.toString().padStart(12, '0')

const matchesFault = (
  target: FaultTarget,
  delivery: {
    requestId: RequestEnvelope['id']
    to: Peer['id']
    event: RequestEvent
  },
): boolean =>
  target.requestId === delivery.requestId &&
  (target.to === undefined || target.to === delivery.to) &&
  (target.event === undefined || target.event === delivery.event)

export function createMemoryHub(): MemoryHub {
  let nextPeerSequence = 1
  let nextRequestSequence = 1
  let nextSubscriberId = 1
  let nextDeliveryId = 1

  const groups = new Map<string, GroupState>()
  const snapshots = new Map<string, StoredSnapshot>()
  const duplicateFaults: OneShotFault[] = []
  const dropFaults: OneShotFault[] = []
  const delayFaults: DelayFault[] = []
  const ackHolds = new Map<RequestEnvelope['id'], AckHold>()
  const respondFailures = new Map<RequestEnvelope['id'], CountedFailure>()
  const lostAcks = new Set<RequestEnvelope['id']>()
  const snapshotFailure: CountedFailure = { remaining: 0 }
  const snapshotHolds = new Map<Peer['id'], SnapshotHold>()

  const consumeFailure = (failure: CountedFailure | undefined): boolean => {
    if (failure === undefined || failure.remaining <= 0) {
      return false
    }
    if (failure.remaining !== Number.POSITIVE_INFINITY) {
      failure.remaining -= 1
    }
    return true
  }

  const saveFencedSnapshot = (
    key: string,
    payload: string,
    fence: SnapshotFence,
  ): boolean => {
    const stored = snapshots.get(key)
    if (
      stored !== undefined &&
      !(
        fence.epoch > stored.fence.epoch ||
        (fence.epoch === stored.fence.epoch &&
          fence.appliedSeq >= stored.fence.appliedSeq)
      )
    ) {
      return false
    }

    snapshots.set(key, { fence: clone(fence), payload })
    return true
  }

  const getGroup = (groupId: string): GroupState => {
    const existing = groups.get(groupId)
    if (existing !== undefined) {
      return existing
    }

    const created: GroupState = {
      peers: [],
      requests: [],
      peerSubscribers: [],
      requestSubscribers: [],
    }
    groups.set(groupId, created)
    return created
  }

  const requirePeer = (
    peerId: Peer['id'],
  ): { group: GroupState; peer: Peer } => {
    for (const group of groups.values()) {
      const peer = group.peers.find((candidate) => candidate.id === peerId)
      if (peer !== undefined) {
        return { group, peer }
      }
    }
    throw new Error(`Unknown peer: ${peerId}`)
  }

  const scheduleSubscriber = (subscriber: Subscriber): void => {
    if (subscriber.scheduled) {
      return
    }

    subscriber.scheduled = true
    setTimeout(() => {
      subscriber.scheduled = false

      if (!subscriber.active) {
        subscriber.queue = []
        return
      }

      const task = subscriber.queue.shift()
      task?.()

      if (subscriber.queue.length > 0) {
        scheduleSubscriber(subscriber)
      }
    }, 0)
  }

  const enqueue = (subscriber: Subscriber, task: () => void): void => {
    if (!subscriber.active) {
      return
    }

    subscriber.queue.push(task)
    scheduleSubscriber(subscriber)
  }

  const enqueueRequest = (
    subscriber: RequestSubscriber,
    delivery: {
      deliveryId: number
      requestId: RequestEnvelope['id']
      event: RequestEvent
      task: () => void
    },
  ): void => {
    const faultDelivery = {
      requestId: delivery.requestId,
      to: subscriber.peerId,
      event: delivery.event,
    }

    const delay = delayFaults.find(
      (fault) => !fault.released && matchesFault(fault.target, faultDelivery),
    )
    if (delay !== undefined) {
      delay.buffered.push(() => enqueue(subscriber, delivery.task))
      return
    }

    const drop = dropFaults.find(
      (fault) =>
        (fault.consumedDeliveryId === null ||
          fault.consumedDeliveryId === delivery.deliveryId) &&
        matchesFault(fault.target, faultDelivery),
    )
    if (drop !== undefined) {
      drop.consumedDeliveryId = delivery.deliveryId
      return
    }

    const duplicate = duplicateFaults.find(
      (fault) =>
        (fault.consumedDeliveryId === null ||
          fault.consumedDeliveryId === delivery.deliveryId) &&
        matchesFault(fault.target, faultDelivery),
    )
    if (duplicate !== undefined) {
      duplicate.consumedDeliveryId = delivery.deliveryId
      enqueue(subscriber, delivery.task)
      enqueue(subscriber, delivery.task)
      return
    }

    enqueue(subscriber, delivery.task)
  }

  const removePeer = (peerId: Peer['id']): void => {
    const { group, peer } = requirePeer(peerId)
    group.peers = group.peers.filter((candidate) => candidate.id !== peerId)

    for (const subscriber of group.peerSubscribers) {
      enqueue(subscriber, () => subscriber.handlers.onRemoved(clone(peer)))
    }
  }

  const resolveAckNextTick = (
    requestId: RequestEnvelope['id'],
    resolve: () => void,
  ): void => {
    const hold = ackHolds.get(requestId)
    if (hold !== undefined && !hold.released) {
      hold.resolvers.push(resolve)
      return
    }

    setTimeout(resolve, 0)
  }

  const createTransport = (): SynquxTransport => {
    let connected = false
    let closed = false
    let groupId: string | null = null
    let selfId: Peer['id'] | null = null

    const assertConnected = (): {
      group: GroupState
      peerId: Peer['id']
      groupId: string
    } => {
      if (!connected || closed || groupId === null || selfId === null) {
        throw new Error('Memory transport is not connected')
      }
      return { group: getGroup(groupId), peerId: selfId, groupId }
    }

    return {
      async connect(options) {
        if (connected && !closed) {
          throw new Error('Memory transport is already connected')
        }

        const peer: Peer = {
          id: `peer-${nextPeerSequence.toString()}`,
          groupId: options.groupId,
          connected: Date.now(),
          role: options.role,
          label: options.label,
        }
        nextPeerSequence += 1

        const group = getGroup(options.groupId)
        group.peers.push(peer)
        connected = true
        closed = false
        groupId = options.groupId
        selfId = peer.id

        for (const subscriber of group.peerSubscribers) {
          enqueue(subscriber, () => subscriber.handlers.onAdded(clone(peer)))
        }

        return { selfId: peer.id }
      },

      async disconnect() {
        const { peerId } = assertConnected()
        removePeer(peerId)
        closed = true
      },

      async serverNow() {
        return Date.now()
      },

      subscribePeers(handlers) {
        const { group, peerId, groupId: boundGroupId } = assertConnected()
        const subscriber: PeerSubscriber = {
          id: nextSubscriberId,
          groupId: boundGroupId,
          peerId,
          active: true,
          kind: 'peers',
          handlers,
          queue: [],
          scheduled: false,
        }
        nextSubscriberId += 1
        group.peerSubscribers.push(subscriber)

        for (const peer of group.peers) {
          enqueue(subscriber, () => subscriber.handlers.onAdded(clone(peer)))
        }

        return () => {
          subscriber.active = false
          subscriber.queue = []
          const currentGroup = getGroup(boundGroupId)
          currentGroup.peerSubscribers = currentGroup.peerSubscribers.filter(
            (candidate) => candidate.id !== subscriber.id,
          )
        }
      },

      async pushRequest(envelope) {
        const { group, groupId: boundGroupId } = assertConnected()
        if (envelope.groupId !== boundGroupId) {
          throw new Error('Request groupId must match connected group')
        }

        const id = formatRequestId(nextRequestSequence)
        nextRequestSequence += 1

        const stored: RequestEnvelope = { ...clone(envelope), id }
        group.requests.push(stored)

        const deliveryId = nextDeliveryId
        nextDeliveryId += 1
        for (const subscriber of group.requestSubscribers) {
          enqueueRequest(subscriber, {
            deliveryId,
            requestId: id,
            event: 'added',
            task: () => subscriber.handlers.onAdded(clone(stored)),
          })
        }

        return { id }
      },

      async respondRequest(id, patch) {
        const { group } = assertConnected()
        const index = group.requests.findIndex((request) => request.id === id)
        if (index === -1) {
          throw new Error(`Unknown request: ${id}`)
        }

        if (consumeFailure(respondFailures.get(id))) {
          throw new Error(`Injected respondRequest failure: ${id}`)
        }

        const current = group.requests[index]
        const updated: RequestEnvelope = {
          ...current,
          epoch: patch.epoch,
          seq: patch.seq,
          responsedBy: patch.responsedBy,
          responsed: patch.responsed,
          result: patch.result === null ? undefined : patch.result,
        }
        // RTDB の update() は null 指定でキーを削除するため、result: null は
        // 「既存値の温存」ではなく「除去」に揃える (dual-host が同一 request に
        // 応答し合う境界ケースで実インフラと挙動が乖離しないように)
        if (updated.result === undefined) {
          delete updated.result
        }
        group.requests[index] = updated

        const deliveryId = nextDeliveryId
        nextDeliveryId += 1
        for (const subscriber of group.requestSubscribers) {
          enqueueRequest(subscriber, {
            deliveryId,
            requestId: id,
            event: 'changed',
            task: () => subscriber.handlers.onChanged(clone(updated)),
          })
        }

        if (lostAcks.delete(id)) {
          throw new Error(`Injected respondRequest ack loss: ${id}`)
        }

        await new Promise<void>((resolve) => resolveAckNextTick(id, resolve))
      },

      async pruneRequests(beforeSeq) {
        const { group } = assertConnected()
        group.requests = group.requests.filter(
          (request) =>
            typeof request.seq !== 'number' || request.seq >= beforeSeq,
        )
      },

      subscribeRequests(options, handlers) {
        const { group, peerId, groupId: boundGroupId } = assertConnected()
        const subscriber: RequestSubscriber = {
          id: nextSubscriberId,
          groupId: boundGroupId,
          peerId,
          active: true,
          kind: 'requests',
          handlers,
          queue: [],
          scheduled: false,
        }
        nextSubscriberId += 1
        group.requestSubscribers.push(subscriber)

        const existing = group.requests
          .filter(
            (request) =>
              options.after === undefined || request.id > options.after,
          )
          .sort((left, right) => left.id.localeCompare(right.id))

        existing.forEach((request) => {
          const deliveryId = nextDeliveryId
          nextDeliveryId += 1
          enqueueRequest(subscriber, {
            deliveryId,
            requestId: request.id,
            event: 'added',
            task: () => subscriber.handlers.onAdded(clone(request)),
          })
        })

        return () => {
          subscriber.active = false
          subscriber.queue = []
          const currentGroup = getGroup(boundGroupId)
          currentGroup.requestSubscribers =
            currentGroup.requestSubscribers.filter(
              (candidate) => candidate.id !== subscriber.id,
            )
        }
      },

      async saveSnapshot(key, payload, fence) {
        const { peerId } = assertConnected()
        if (consumeFailure(snapshotFailure)) {
          throw new Error('Injected saveSnapshot failure')
        }

        const hold = snapshotHolds.get(peerId)
        if (hold !== undefined && !hold.released) {
          return new Promise<boolean>((resolve) => {
            const capturedFence = clone(fence)
            // key / payload / fence は closure へ呼び出し時点の値を capture する。
            // release は transport の接続状態を再検査せず、プロセス死後も着地させる。
            hold.buffered.push(() => {
              resolve(saveFencedSnapshot(key, payload, capturedFence))
            })
          })
        }
        return saveFencedSnapshot(key, payload, fence)
      },

      async loadSnapshot(key) {
        assertConnected()
        return snapshots.get(key)?.payload ?? null
      },
    }
  }

  return {
    createTransport,

    faults: {
      duplicate(target) {
        duplicateFaults.push({ target, consumedDeliveryId: null })
      },

      delay(target) {
        const fault: DelayFault = { target, released: false, buffered: [] }
        delayFaults.push(fault)

        return {
          release() {
            if (fault.released) {
              return
            }
            fault.released = true
            const buffered = [...fault.buffered]
            fault.buffered = []
            for (const deliver of buffered) {
              deliver()
            }
          },
        }
      },

      drop(target) {
        dropFaults.push({ target, consumedDeliveryId: null })
      },

      holdAck(requestId) {
        const hold: AckHold = ackHolds.get(requestId) ?? {
          released: false,
          resolvers: [],
        }
        hold.released = false
        ackHolds.set(requestId, hold)

        return {
          release() {
            if (hold.released) {
              return
            }
            hold.released = true
            const resolvers = [...hold.resolvers]
            hold.resolvers = []
            ackHolds.delete(requestId)
            for (const resolve of resolvers) {
              resolve()
            }
          },
        }
      },

      failRespond(requestId, options) {
        respondFailures.set(requestId, { remaining: options?.times ?? 1 })
      },

      loseAck(requestId) {
        lostAcks.add(requestId)
      },

      failSnapshot(options) {
        snapshotFailure.remaining = options?.times ?? 1
      },

      holdSnapshot(peerId) {
        const hold: SnapshotHold = { released: false, buffered: [] }
        snapshotHolds.set(peerId, hold)

        return {
          release() {
            if (hold.released) {
              return
            }
            hold.released = true
            snapshotHolds.delete(peerId)
            const buffered = [...hold.buffered]
            hold.buffered = []
            for (const write of buffered) {
              write()
            }
          },
        }
      },

      disconnect(peerId) {
        removePeer(peerId)
      },
    },

    inspect: {
      requests(groupId) {
        return clone(getGroup(groupId).requests)
      },

      peers(groupId) {
        return clone(getGroup(groupId).peers)
      },

      snapshot(key) {
        return snapshots.get(key)?.payload ?? null
      },
    },
  }
}
