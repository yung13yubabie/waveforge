import { describe, it, expect } from 'vitest'
import { detectBPM, detectKey, NOTE_NAMES } from '../../src/js/audio/analyze.js'

// ── Synthetic buffer factory ──────────────────────────────────────────────
function makeBuffer(samples, sr = 48000) {
  return {
    sampleRate: sr,
    length: samples,
    numberOfChannels: 1,
    duration: samples / sr,
    getChannelData: (ch) => new Float32Array(samples),
  }
}

function makeToneBuffer(frequencies, durationSec, sr = 48000) {
  const N     = Math.floor(sr * durationSec)
  const data  = new Float32Array(N)
  for (const hz of frequencies) {
    for (let i = 0; i < N; i++) data[i] += Math.sin(2 * Math.PI * hz * i / sr)
  }
  // Normalise to ±0.5 (avoid spreading large array into Math.max)
  let peak = 0
  for (let i = 0; i < N; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a }
  if (peak > 0) for (let i = 0; i < N; i++) data[i] /= peak * 2
  return {
    sampleRate: sr,
    length: N,
    numberOfChannels: 1,
    duration: durationSec,
    getChannelData: () => data,
  }
}

function makeImpulseTrain(bpm, durationSec, sr = 48000) {
  const N         = Math.floor(sr * durationSec)
  const data      = new Float32Array(N)
  const beatSamples = Math.round(sr * 60 / bpm)
  for (let i = 0; i < N; i += beatSamples) data[i] = 1.0
  return {
    sampleRate: sr,
    length: N,
    numberOfChannels: 1,
    duration: durationSec,
    getChannelData: () => data,
  }
}

// ── detectBPM ─────────────────────────────────────────────────────────────

describe('detectBPM()', () => {
  it('returns { bpm, confidence } shaped object', () => {
    const buf = makeImpulseTrain(120, 10)
    const res = detectBPM(buf)
    expect(res).toHaveProperty('bpm')
    expect(res).toHaveProperty('confidence')
  })

  it('returns confidence = 0 for silent audio', () => {
    const buf = makeBuffer(48000 * 5)
    const res = detectBPM(buf)
    expect(res.confidence).toBe(0)
    expect(res.bpm).toBeNull()
  })

  it('returns low confidence for too-short audio (< 64 frames)', () => {
    const buf = makeBuffer(64)  // only 64 samples — fewer than 1 hop frame
    const res = detectBPM(buf)
    expect(res.confidence).toBe(0)
  })

  it('detects 120 BPM impulse train within ±4 BPM', () => {
    const buf = makeImpulseTrain(120, 30)
    const res = detectBPM(buf)
    // Allow for half- or double-tempo detection
    const candidates = [res.bpm, res.bpm * 2, res.bpm / 2]
    const closest = candidates.reduce((a, b) => Math.abs(a - 120) < Math.abs(b - 120) ? a : b)
    expect(Math.abs(closest - 120)).toBeLessThan(4)
  })

  it('bpm value is a multiple of 0.5 (rounded)', () => {
    const buf = makeImpulseTrain(100, 20)
    const res = detectBPM(buf)
    if (res.bpm !== null) {
      expect(res.bpm % 0.5).toBeCloseTo(0, 5)
    }
  })

  it('confidence is in [0, 1]', () => {
    const buf = makeImpulseTrain(90, 20)
    const res = detectBPM(buf)
    expect(res.confidence).toBeGreaterThanOrEqual(0)
    expect(res.confidence).toBeLessThanOrEqual(1)
  })

  it('does not return NaN for any field', () => {
    const buf = makeImpulseTrain(140, 15)
    const res = detectBPM(buf)
    if (res.bpm !== null) expect(isNaN(res.bpm)).toBe(false)
    expect(isNaN(res.confidence)).toBe(false)
  })
})

// ── detectKey ─────────────────────────────────────────────────────────────

describe('detectKey()', () => {
  it('returns { key, scale, confidence } shaped object', () => {
    const buf = makeToneBuffer([261.63, 329.63, 392.00], 5)  // C major chord
    const res = detectKey(buf)
    expect(res).toHaveProperty('key')
    expect(res).toHaveProperty('scale')
    expect(res).toHaveProperty('confidence')
  })

  it('returns confidence = 0 for silent audio', () => {
    const buf = makeBuffer(48000 * 5)
    const res = detectKey(buf)
    expect(res.confidence).toBe(0)
    expect(res.key).toBeNull()
  })

  it('returns null key for audio shorter than one FFT frame', () => {
    const buf = makeBuffer(1024)
    const res = detectKey(buf)
    expect(res.key).toBeNull()
  })

  it('key is one of the 12 note names when detected', () => {
    const buf = makeToneBuffer([261.63, 329.63, 392.00], 10)
    const res = detectKey(buf)
    if (res.key !== null) {
      expect(NOTE_NAMES).toContain(res.key)
    }
  })

  it('scale is either 大調 or 小調 when detected', () => {
    const buf = makeToneBuffer([261.63, 329.63, 392.00], 10)
    const res = detectKey(buf)
    if (res.scale !== null) {
      expect(['大調', '小調']).toContain(res.scale)
    }
  })

  it('confidence is in [0, 1]', () => {
    const buf = makeToneBuffer([440, 550, 660], 10)  // rough A major
    const res = detectKey(buf)
    expect(res.confidence).toBeGreaterThanOrEqual(0)
    expect(res.confidence).toBeLessThanOrEqual(1)
  })

  it('does not return NaN for any field', () => {
    const buf = makeToneBuffer([440], 5)  // single A4 tone
    const res = detectKey(buf)
    if (res.confidence !== null) expect(isNaN(res.confidence)).toBe(false)
  })

  it('single pure 440Hz sine (A4) should yield non-null key', () => {
    const buf = makeToneBuffer([440], 8)
    const res = detectKey(buf)
    // A4 is the reference pitch — should clearly be detected as A major or A minor
    expect(res.key).not.toBeNull()
  })
})

// ── NOTE_NAMES export ─────────────────────────────────────────────────────

describe('NOTE_NAMES', () => {
  it('exports exactly 12 note names', () => {
    expect(NOTE_NAMES).toHaveLength(12)
  })

  it('starts with C', () => {
    expect(NOTE_NAMES[0]).toBe('C')
  })

  it('contains A at index 9', () => {
    expect(NOTE_NAMES[9]).toBe('A')
  })
})
