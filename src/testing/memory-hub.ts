import type { Peer, RequestEnvelope, SynquxTransport } from '../core/types.js'

export type FaultTarget = {
  requestId: RequestEnvelope['id']
  /** 対象端末の peer id。省略時は全端末への配送が対象 */
  to?: Peer['id']
  /** 対象イベント種別。省略時は added / changed の両方が対象 */
  event?: 'added' | 'changed'
}

export type MemoryHub = {
  /** 仮想端末 1 台ぶんの transport を生成する。テストでは端末数ぶん作る */
  createTransport(): SynquxTransport

  faults: {
    /** 次の該当配送を同一 subscriber へ 2 回連続で届ける (二重配送) */
    duplicate(target: FaultTarget): void
    /** 該当配送を保留し、release() で保留分を元の順序のまま解放する */
    delay(target: FaultTarget): { release(): void }
    /** 次の該当配送を 1 回ぶん破棄する */
    drop(target: FaultTarget): void
    /** respondRequest の resolve (ack) だけを保留する。変更イベントの配送は保留しない */
    holdAck(requestId: RequestEnvelope['id']): { release(): void }
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
  consumed: boolean
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

  const groups = new Map<string, GroupState>()
  const snapshots = new Map<string, string>()
  const duplicateFaults: OneShotFault[] = []
  const dropFaults: OneShotFault[] = []
  const delayFaults: DelayFault[] = []
  const ackHolds = new Map<RequestEnvelope['id'], AckHold>()

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
      (fault) => !fault.consumed && matchesFault(fault.target, faultDelivery),
    )
    if (drop !== undefined) {
      drop.consumed = true
      return
    }

    const duplicate = duplicateFaults.find(
      (fault) => !fault.consumed && matchesFault(fault.target, faultDelivery),
    )
    if (duplicate !== undefined) {
      duplicate.consumed = true
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

        for (const subscriber of group.requestSubscribers) {
          enqueueRequest(subscriber, {
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

        for (const subscriber of group.requestSubscribers) {
          enqueueRequest(subscriber, {
            requestId: id,
            event: 'changed',
            task: () => subscriber.handlers.onChanged(clone(updated)),
          })
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
          enqueueRequest(subscriber, {
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

      async saveSnapshot(key, payload) {
        assertConnected()
        snapshots.set(key, payload)
      },

      async loadSnapshot(key) {
        assertConnected()
        return snapshots.get(key) ?? null
      },
    }
  }

  return {
    createTransport,

    faults: {
      duplicate(target) {
        duplicateFaults.push({ target, consumed: false })
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
        dropFaults.push({ target, consumed: false })
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
        return snapshots.get(key) ?? null
      },
    },
  }
}
