import { describe, it, expect } from 'vitest'
import { sha256Hex } from '../../src/js/audio/sha256.js'

const enc = new TextEncoder()

describe('sha256Hex', () => {
  it('hashes the empty input to the known SHA-256 vector', async () => {
    const hex = await sha256Hex(new Uint8Array(0).buffer)
    expect(hex).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes "abc" to the known vector', async () => {
    const hex = await sha256Hex(enc.encode('abc').buffer)
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is deterministic and 64 hex chars', async () => {
    const buf = enc.encode('waveforge-original-recording').buffer
    const a = await sha256Hex(buf)
    const b = await sha256Hex(buf)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})
