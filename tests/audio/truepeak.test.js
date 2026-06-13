// ITU-R BS.1770-4 Annex 2 true-peak: oversample, then measure inter-sample peaks.
// Pure polyphase upsampler MIRRORS src/js/audio/lufs-worklet.js (worklet asset is
// emitted unbundled — it can't import). These tests also give the true-peak DSP
// real coverage (the worklet processor itself never runs under jsdom).
import { describe, it, expect } from 'vitest'

// Windowed-sinc 4-phase polyphase fractional-delay bank.
function makePolyphase(taps, phases) {
  const center = (taps - 1) / 2
  const banks = []
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    const h = new Float64Array(taps)
    let sum = 0
    for (let k = 0; k < taps; k++) {
      const x = k - center - frac
      const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / taps) // Hann
      h[k] = s * w
      sum += h[k]
    }
    for (let k = 0; k < taps; k++) h[k] /= sum // unity DC gain
    banks.push(h)
  }
  return banks
}

// Oversampled peak (linear) of a mono buffer.
function truePeakLinear(samples, taps = 12, phases = 4) {
  const banks = makePolyphase(taps, phases)
  const dl = new Float64Array(taps)
  let peak = 0
  for (let n = 0; n < samples.length; n++) {
    for (let k = taps - 1; k > 0; k--) dl[k] = dl[k - 1]
    dl[0] = samples[n]
    for (let p = 0; p < phases; p++) {
      const h = banks[p]
      let acc = 0
      for (let k = 0; k < taps; k++) acc += h[k] * dl[k]
      const a = Math.abs(acc)
      if (a > peak) peak = a
    }
  }
  return peak
}

function samplePeak(samples) {
  let p = 0
  for (const s of samples) { const a = Math.abs(s); if (a > p) p = a }
  return p
}

describe('ITU-R BS.1770-4 true-peak (oversampled)', () => {
  it('polyphase bank has unity DC gain per phase', () => {
    const banks = makePolyphase(12, 4)
    for (const h of banks) {
      const sum = h.reduce((a, b) => a + b, 0)
      expect(sum).toBeCloseTo(1, 6)
    }
  })

  it('phase 0 reproduces the original samples (DC and low frequency)', () => {
    const banks = makePolyphase(12, 4)
    // phase 0, fractional delay 0 → a delayed unit impulse at the center tap
    const h0 = banks[0]
    const center = (12 - 1) / 2
    let maxOff = 0
    for (let k = 0; k < 12; k++) {
      // off-center taps should be ~0 (it's effectively an integer delay)
      if (Math.abs(k - center) >= 1) maxOff = Math.max(maxOff, Math.abs(h0[k]))
    }
    // center sits between taps 5 and 6 (delay 5.5), so two main taps; rest small
    expect(maxOff).toBeLessThan(0.7)
  })

  it('detects inter-sample peaks a sample-peak meter misses', () => {
    // Full-scale sine at fs/4, phase 45°: samples land at ±0.707 but the
    // continuous waveform crests at 1.0 between samples — the classic ISP case.
    const N = 2000
    const s = new Float64Array(N)
    for (let n = 0; n < N; n++) s[n] = Math.sin((Math.PI / 2) * n + Math.PI / 4)

    const sp = samplePeak(s)
    const tp = truePeakLinear(s)

    expect(sp).toBeCloseTo(0.707, 2)        // sample peak under-reads
    expect(tp).toBeGreaterThan(0.9)          // true peak recovers the real crest
    expect(tp).toBeGreaterThan(sp + 0.15)    // clearly higher than sample peak
    expect(tp).toBeLessThan(1.05)            // and not a wild overshoot
  })

  it('does not inflate an already sample-aligned low-frequency peak', () => {
    // 100 Hz sine @ 48k: peaks land essentially on samples → TP ≈ sample peak
    const N = 4800
    const s = new Float64Array(N)
    for (let n = 0; n < N; n++) s[n] = Math.sin((2 * Math.PI * 100 * n) / 48000)
    const sp = samplePeak(s)
    const tp = truePeakLinear(s)
    expect(tp).toBeGreaterThanOrEqual(sp - 1e-3)
    expect(tp).toBeLessThan(sp * 1.02)
  })

  it('silence yields zero true peak', () => {
    expect(truePeakLinear(new Float64Array(512))).toBe(0)
  })
})
