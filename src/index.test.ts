import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SYNQUX_VERSION } from './index.js'

describe('package smoke test', () => {
  it('SYNQUX_VERSION は package.json の version と一致する (publish 時の更新漏れ検出)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { version: string }

    expect(SYNQUX_VERSION).toBe(pkg.version)
  })
})
