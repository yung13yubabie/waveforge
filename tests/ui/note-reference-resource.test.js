// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('cancelled reference source ownership', () => {
  it('releases source PCM while native resume remains pending and cannot start it later', () => {
    // Isolated Node avoids the test runner's own mock call logs retaining PCM.
    // This is a specific WeakRef reachability check, not a browser/RSS claim.
    const output = execFileSync(process.execPath, ['--expose-gc',
      resolve('scripts/check-note-reference-release.mjs'), process.cwd()], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(output)
    expect(result.passed).toBe(true)
    expect(result.aliveWhileResumePending).toEqual({ source: false, channel: false, backingStore: false })
    expect(result.oscillatorCreations).toBe(0)
    expect(result.collectionTurns).toBeGreaterThanOrEqual(8)
  }, 20000)
})
