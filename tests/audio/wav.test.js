// WAV encoder tests (24-bit + 16-bit/dither). Previously the encoder was an
// untestable closure in main.js — this gives it real byte-level coverage.
import { describe, it, expect } from 'vitest'
import { encodeWAV } from '../../src/js/audio/wav.js'

function parseHeader(buf) {
  const v = new DataView(buf)
  const str = o => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3))
  return {
    riff: str(0), wave: str(8), fmt: str(12),
    audioFormat: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    blockAlign: v.getUint16(32, true),
    bitDepth: v.getUint16(34, true),
    dataTag: str(36), dataSize: v.getUint32(40, true),
  }
}

describe('encodeWAV', () => {
  it('writes a valid 24-bit stereo header', () => {
    const ch = [new Float32Array(100), new Float32Array(100)]
    const h = parseHeader(encodeWAV(ch, 48000, 24))
    expect(h.riff).toBe('RIFF'); expect(h.wave).toBe('WAVE'); expect(h.fmt).toBe('fmt ')
    expect(h.audioFormat).toBe(1)
    expect(h.channels).toBe(2)
    expect(h.sampleRate).toBe(48000)
    expect(h.bitDepth).toBe(24)
    expect(h.blockAlign).toBe(6)        // 2ch × 3 bytes
    expect(h.dataSize).toBe(100 * 6)
  })

  it('writes a valid 16-bit header with correct sizes', () => {
    const ch = [new Float32Array(100), new Float32Array(100)]
    const buf = encodeWAV(ch, 44100, 16)
    const h = parseHeader(buf)
    expect(h.bitDepth).toBe(16)
    expect(h.blockAlign).toBe(4)        // 2ch × 2 bytes
    expect(h.dataSize).toBe(100 * 4)
    expect(buf.byteLength).toBe(44 + 100 * 4)
  })

  it('24-bit encodes full-scale samples deterministically (no dither)', () => {
    const ch = [new Float32Array([1.0, -1.0, 0])]
    const buf = encodeWAV(ch, 48000, 24)
    const v = new DataView(buf)
    // +1.0 → 0x7FFFFF (LE: FF FF 7F)
    expect([v.getUint8(44), v.getUint8(45), v.getUint8(46)]).toEqual([0xFF, 0xFF, 0x7F])
    // -1.0 → 0x800000 (LE: 00 00 80)
    expect([v.getUint8(47), v.getUint8(48), v.getUint8(49)]).toEqual([0x00, 0x00, 0x80])
    // 0 → 0
    expect([v.getUint8(50), v.getUint8(51), v.getUint8(52)]).toEqual([0x00, 0x00, 0x00])
  })

  it('clamps out-of-range samples instead of wrapping', () => {
    const ch = [new Float32Array([2.0, -2.0])]
    const v = new DataView(encodeWAV(ch, 48000, 24))
    expect([v.getUint8(44), v.getUint8(45), v.getUint8(46)]).toEqual([0xFF, 0xFF, 0x7F])  // clamped +1
    expect([v.getUint8(47), v.getUint8(48), v.getUint8(49)]).toEqual([0x00, 0x00, 0x80])  // clamped -1
  })

  it('24-bit silence is exactly zero (no dither at 24-bit)', () => {
    const buf = encodeWAV([new Float32Array(2000)], 48000, 24)
    const bytes = new Uint8Array(buf, 44)
    expect(bytes.every(b => b === 0)).toBe(true)
  })

  it('16-bit silence carries TPDF dither (not all zero) but stays at ±1 LSB', () => {
    const buf = encodeWAV([new Float32Array(20000)], 48000, 16)
    const v = new DataView(buf)
    let nonZero = 0, maxAbs = 0
    for (let o = 44; o < buf.byteLength; o += 2) {
      const s = v.getInt16(o, true)
      if (s !== 0) nonZero++
      maxAbs = Math.max(maxAbs, Math.abs(s))
    }
    expect(nonZero).toBeGreaterThan(0)   // dither present
    expect(maxAbs).toBeLessThanOrEqual(1) // bounded to ±1 LSB
  })

  it('16-bit encodes a mid-scale value within 1 LSB (dither-bounded)', () => {
    const ch = [new Float32Array([0.5])]
    const v = new DataView(encodeWAV(ch, 48000, 16))
    const s = v.getInt16(44, true)
    expect(Math.abs(s - Math.round(0.5 * 0x7FFF))).toBeLessThanOrEqual(1)
  })
})
