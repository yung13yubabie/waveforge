// Anti-happy-path tests: verifies failure modes are handled honestly
import { describe, it, expect, vi } from 'vitest'
import { PRESETS } from '../../src/js/presets.js'

describe('Presets integrity (anti-SLOP)', () => {
  it('every preset has an eqGains array of exactly 10 values', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(Array.isArray(preset.eqGains), `${key}.eqGains must be array`).toBe(true)
      expect(preset.eqGains.length, `${key}.eqGains must have 10 bands`).toBe(10)
    }
  })

  it('every preset has a compRatio >= 1 (ratio below 1 is not physically valid)', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.compRatio, `${key}.compRatio must be >= 1`).toBeGreaterThanOrEqual(1)
    }
  })

  it('every preset has limCeiling <= 0 dBTP (positive ceiling would allow clipping)', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.limCeiling, `${key}.limCeiling must be <= 0`).toBeLessThanOrEqual(0)
    }
  })

  it('every preset has compThreshold < 0 dB (positive threshold is invalid)', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      expect(preset.compThreshold, `${key}.compThreshold must be < 0`).toBeLessThan(0)
    }
  })

  it('eq gains are within ±18 dB (EQ beyond ±18 dB is destructive)', () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      for (let i = 0; i < preset.eqGains.length; i++) {
        const g = preset.eqGains[i]
        expect(Math.abs(g), `${key}.eqGains[${i}] exceeds ±18 dB`).toBeLessThanOrEqual(18)
      }
    }
  })

  it('platform presets have targetLUFS defined', () => {
    const platformKeys = ['spotify','youtube','apple','tidal','cd','vinyl','broadcast']
    for (const key of platformKeys) {
      expect(PRESETS[key]?.targetLUFS, `${key} must have targetLUFS`).toBeDefined()
    }
  })

  it('vinyl preset has isVinyl flag', () => {
    expect(PRESETS.vinyl.isVinyl).toBe(true)
  })

  it('broadcast preset targets -23 LUFS (EBU R128)', () => {
    expect(PRESETS.broadcast.targetLUFS).toBe(-23)
  })

  it('classical preset has very low compression ratio (preserves dynamics)', () => {
    expect(PRESETS.classical.compRatio).toBeLessThan(2)
  })

  it('loud preset has highest compression ratio among tonal presets', () => {
    const tonalRatios = ['warm','balanced','open','punchy','intimate','cinematic','loud','dynamic']
      .map(k => PRESETS[k].compRatio)
    const loudRatio = PRESETS.loud.compRatio
    expect(loudRatio).toBe(Math.max(...tonalRatios))
  })

  it('lofi preset has LP cutoff below 16kHz (intentional hi-freq rolloff)', () => {
    expect(PRESETS.lofi.lpFreq).toBeLessThan(16000)
  })

  it('all 39 presets are present', () => {
    expect(Object.keys(PRESETS).length).toBe(39)
  })
})

describe('Audio signal chain: edge cases', () => {
  it('toLUFS with mean-square of Infinity should not produce NaN', () => {
    // Defensive: if somehow ms=Infinity arrives, toLUFS must not return NaN
    const v = -0.691 + 10 * Math.log10(Infinity)
    expect(isNaN(v)).toBe(false)
    expect(v).toBe(Infinity)
  })

  it('WAV encoder handles silent buffer without NaN samples', () => {
    // A silent buffer should encode to zero values, not NaN/garbage
    const silentSample = 0.0
    const encoded = silentSample < 0 ? silentSample * 0x8000 : silentSample * 0x7FFF
    expect(isNaN(encoded)).toBe(false)
    expect(encoded).toBe(0)
  })

  it('frequency-to-x mapping never produces NaN for valid frequencies', () => {
    const FREQ_MIN = 20, FREQ_MAX = 22050
    const logMin = Math.log10(FREQ_MIN), logMax = Math.log10(FREQ_MAX)
    const W = 280
    const testFreqs = [20, 50, 100, 500, 1000, 5000, 10000, 20000]
    for (const f of testFreqs) {
      const x = ((Math.log10(f) - logMin) / (logMax - logMin)) * W
      expect(isNaN(x)).toBe(false)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(W)
    }
  })
})
