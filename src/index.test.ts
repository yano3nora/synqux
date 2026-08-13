import { readFileSync } from 'node:fs'
import type { Action } from '@reduxjs/toolkit'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as synqux from './index.js'
import {
  SYNQUX_VERSION,
  type Peer,
  type SynquxAutomation,
  type SynquxListener,
  type SynquxListenerContext,
} from './index.js'

describe('package smoke test', () => {
  it('SYNQUX_VERSION は package.json の version と一致する (publish 時の更新漏れ検出)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }

    expect(SYNQUX_VERSION).toBe(pkg.version)
  })

  it('main entry の runtime export は SPEC-0002 の公開一覧と一致する (公開 surface の回帰検出)', () => {
    // 増減どちらも意図的な変更のみ許す。増やす / 減らす場合は SPEC-0002 の
    // subpath exports 一覧とセットで更新する (breaking の可能性を release notes に明記)
    expect(Object.keys(synqux).sort()).toEqual(
      [
        'SYNQUX_SCHEMA_VERSION',
        'SYNQUX_VERSION',
        'createSynqux',
        'createSynquxRootReducer',
        'createSyncedActionMatchers',
        'generateResult',
        'isResultForPeer',
        'isSynquxAction',
        'localStorageSnapshotStore',
        'selectIsHost',
        'selectIsLive',
        'selectIsSyncStalled',
        'selectIsSyncUnrecoverable',
        'selectPeers',
        'selectSelf',
        'selectSelfId',
        'selectSelfRole',
        'selectSyncHealth',
        'selectSyncPhase',
        'stateWithDefaultResult',
        'stateWithError',
        'stateWithResult',
        'stateWithTransaction',
        'synquxReducer',
        'synquxRestored',
      ].sort(),
    )
  })

  it('SynquxAutomation 型を main entry から公開する', () => {
    expectTypeOf<SynquxAutomation<{ count: number }, Action>>().toMatchTypeOf<{
      id: string
      when: (synced: { count: number }, ctx: { now: number }) => boolean
      action: (synced: { count: number }) => Action
      retryMs?: number
    }>()
  })

  it('SynquxListener 型を main entry から公開し、effect ctx は synced と self を持つ', () => {
    type Listener = SynquxListener<{ count: number }, Action>

    expectTypeOf<Listener>().toMatchTypeOf<{
      id: string
      match: (action: Action) => boolean
      mode: 'host-only' | 'everyone'
      scope?: 'synced' | 'all'
      effect: (
        action: Action,
        ctx: SynquxListenerContext<{ count: number }>,
      ) => void | Promise<void>
    }>()
    expectTypeOf<Parameters<Listener['effect']>[1]>().toEqualTypeOf<{
      synced: { count: number }
      self: Peer | null
    }>()
  })

  it("SynquxListener は scope 'all' の variant でだけ action 型を Action へ広げる", () => {
    type DomainAction = Action<'game/increment'> & { payload: number }
    type Listener = SynquxListener<{ count: number }, DomainAction>
    type AllRule = Extract<Listener, { scope: 'all' }>
    type SyncedRule = Exclude<Listener, { scope: 'all' }>

    // 既定 scope は domain action のまま narrowing 済みで受け取れる
    expectTypeOf<
      Parameters<SyncedRule['match']>[0]
    >().toEqualTypeOf<DomainAction>()
    expectTypeOf<
      Parameters<SyncedRule['effect']>[0]
    >().toEqualTypeOf<DomainAction>()

    // 'all' は local action を含むため Action へ widen され、
    // domain 固有の payload は narrowing なしには読めない
    expectTypeOf<Parameters<AllRule['match']>[0]>().toEqualTypeOf<Action>()
    expectTypeOf<Parameters<AllRule['effect']>[0]>().toEqualTypeOf<Action>()
    expectTypeOf<Parameters<AllRule['effect']>[0]>().not.toHaveProperty(
      'payload',
    )
  })
})
