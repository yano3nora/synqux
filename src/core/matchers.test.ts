import type { UnknownAction } from '@reduxjs/toolkit'
import { describe, expect, it } from 'vitest'
import { isDeliveredSyncedAction, isSynquxAction } from './matchers.js'
import { synquxActions, synquxRestored } from './slice.js'

describe('isSynquxAction', () => {
  it('内部 action を判定し consumer action を除外する', () => {
    expect(
      isSynquxAction(
        synquxActions.sessionStarted({ selfId: null, mode: 'standalone' }),
      ),
    ).toBe(true)
    expect(isSynquxAction(synquxRestored({ synced: {} }))).toBe(true)
    expect(isSynquxAction({ type: 'game/foo' })).toBe(false)
  })
})

describe('isDeliveredSyncedAction', () => {
  const deliveredMeta = {
    // 配達済み action は必ず hash を持つ (ADR-0024 で契約化)
    hash: '01HDELIVERED00000000000000',
    requestedBy: 'peer-1',
    dispatched: 1,
    responsedBy: 'peer-host',
    responsed: 2,
    epoch: 1,
    seq: 3,
  }

  it('request / response の同期情報が揃えば配達済み action と判定する', () => {
    const action = {
      type: 'game/foo',
      meta: deliveredMeta,
    }

    expect(isDeliveredSyncedAction(action)).toBe(true)
  })

  it.each([
    'hash',
    'requestedBy',
    'dispatched',
    'responsedBy',
    'responsed',
    'epoch',
    'seq',
  ] as const)('%s がなければ false', (missing) => {
    const action: UnknownAction = {
      type: 'game/foo',
      meta: { ...deliveredMeta, [missing]: undefined },
    }

    expect(isDeliveredSyncedAction(action)).toBe(false)
  })

  it('type guard として request / response meta を必須へ絞り込む', () => {
    const action: UnknownAction = {
      type: 'game/foo',
      meta: deliveredMeta,
    }

    const delivery = isDeliveredSyncedAction(action)
      ? [
          action.meta.requestedBy,
          action.meta.dispatched,
          action.meta.responsedBy,
          action.meta.seq,
        ]
      : null

    expect(delivery).toEqual(['peer-1', 1, 'peer-host', 3])
  })
})
