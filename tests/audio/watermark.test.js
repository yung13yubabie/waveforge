import { describe, it, expect } from 'vitest'
import { embedWatermark, detectWatermark } from '../../src/js/audio/watermark.js'

// Deterministic PRNG so the test is reproducible (Math.random made it flaky:
// random noise occasionally correlated with the PN and spiked confidence).
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Synthetic test signal: several seconds of tone + noise (music-like,
// uncorrelated with PN). 8s → enough frames for a stable baseline distribution.
function makeSignal(seconds = 8, sr = 44100, seed = 12345) {
  const rng = mulberry32(seed)
  const n = seconds * sr
  const ch = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    ch[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr) + 0.2 * (rng() * 2 - 1)
  }
  return ch
}

function rms(arr) {
  let s = 0
  for (const v of arr) s += v * v
  return Math.sqrt(s / arr.length)
}

describe('audio watermark', () => {
  it('detects the correct payload with high confidence after embedding', () => {
    const original = [makeSignal(), makeSignal()]
    const marked = embedWatermark(original, 44100, 'LIN-2026-001')
    const { confidence } = detectWatermark(marked, 44100, 'LIN-2026-001')
    expect(confidence).toBeGreaterThan(0.7)
  })

  it('reports low confidence for a wrong payload', () => {
    const original = [makeSignal(), makeSignal()]
    const marked = embedWatermark(original, 44100, 'LIN-2026-001')
    const { confidence } = detectWatermark(marked, 44100, 'SOMEONE-ELSE')
    expect(confidence).toBeLessThan(0.3)
  })

  it('reports low confidence on un-watermarked audio', () => {
    const clean = [makeSignal(), makeSignal()]
    const { confidence } = detectWatermark(clean, 44100, 'LIN-2026-001')
    expect(confidence).toBeLessThan(0.3)
  })

  it('is quiet — added signal is small relative to the original', () => {
    const original = [makeSignal()]
    const marked = embedWatermark(original, 44100, 'LIN-2026-001', { strength: 0.02 })
    const delta = new Float32Array(original[0].length)
    for (let i = 0; i < delta.length; i++) delta[i] = marked[0][i] - original[0][i]
    // watermark energy should be a small fraction of the signal (~strength)
    expect(rms(delta) / rms(original[0])).toBeLessThan(0.05)
  })

  it('does not mutate the original channels', () => {
    // Short signal — a full toEqual on a multi-hundred-k Float32Array is slow
    // enough to trip the test timeout under parallel load; 1s is plenty here.
    const original = [makeSignal(1)]
    const snapshot = Float32Array.from(original[0])
    embedWatermark(original, 44100, 'LIN-2026-001')
    expect(original[0]).toEqual(snapshot)
  })

  it('survives a light volume change (transcode-like)', () => {
    const original = [makeSignal(), makeSignal()]
    const marked = embedWatermark(original, 44100, 'LIN-2026-001')
    const quieter = marked.map((ch) => ch.map((s) => s * 0.7)) // -3dB
    const { confidence } = detectWatermark(quieter, 44100, 'LIN-2026-001')
    expect(confidence).toBeGreaterThan(0.7)
  })

  it('throws on empty payload', () => {
    expect(() => embedWatermark([makeSignal()], 44100, '')).toThrow()
  })
})

it('preserves floating-point overload for the final limiter instead of hard clipping', () => {
  const source = new Float32Array(1024).fill(1.2)
  const result = embedWatermark([source], 48000, '中文作品')
  expect(Math.max(...result[0])).toBeGreaterThan(1.2)
  expect(source[0]).toBeCloseTo(1.2)
})
