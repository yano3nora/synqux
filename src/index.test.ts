import { readFileSync } from 'node:fs'
import type { Action } from '@reduxjs/toolkit'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as synqux from './index.js'
import { SYNQUX_VERSION, type SynquxAutomation } from './index.js'

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
})
