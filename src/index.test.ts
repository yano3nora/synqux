import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as synqux from './index.js'
import { SYNQUX_VERSION } from './index.js'

describe('package smoke test', () => {
  it('SYNQUX_VERSION は package.json の version と一致する (publish 時の更新漏れ検出)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }

    expect(SYNQUX_VERSION).toBe(pkg.version)
  })

  it('main entry の runtime export は SPEC-0002 の公開一覧と一致する (公開 surface の回帰検出)', () => {
    // 増減どちらも意図的な変更のみ許す。増やす / 減らす場合は SPEC-0002 の
    // subpath exports 一覧・CHANGELOG (breaking の可能性) とセットで更新すること
    expect(Object.keys(synqux).sort()).toEqual(
      [
        'SYNQUX_SCHEMA_VERSION',
        'SYNQUX_VERSION',
        'createSynqux',
        'createSynquxRootReducer',
        'generateResult',
        'localStorageSnapshotStore',
        'selectIsHost',
        'selectIsSyncStalled',
        'selectIsSyncUnrecoverable',
        'selectPeers',
        'selectSelfId',
        'selectSyncHealth',
        'stateWithError',
        'stateWithResult',
        'synquxReducer',
        'synquxRestored',
      ].sort(),
    )
  })
})
