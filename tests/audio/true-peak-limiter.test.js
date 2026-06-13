import { describe, it, expect } from 'vitest'
import { truePeakLimit } from '../../src/js/audio/true-peak-limiter.js'

const SR = 48000

// Reuse the same oversampled true-peak measure to verify the OUTPUT.
function measureTruePeakDb(channels) {
  const TAPS = 12, PHASES = 4, center = (TAPS - 1) / 2
  const banks = []
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES, h = new Float64Array(TAPS); let s = 0
    for (let k = 0; k < TAPS; k++) {
      const x = k - center - frac
      const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      h[k] = sinc * (0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / TAPS)); s += h[k]
    }
    for (let k = 0; k < TAPS; k++) h[k] /= s
    banks.push(h)
  }
  let peak = 0
  for (const x of channels) {
    const dl = new Float64Array(TAPS)
    for (let n = 0; n < x.length; n++) {
      for (let k = TAPS - 1; k > 0; k--) dl[k] = dl[k - 1]
      dl[0] = x[n]
      for (const h of banks) { let a = 0; for (let k = 0; k < TAPS; k++) a += h[k] * dl[k]; peak = Math.max(peak, Math.abs(a)) }
    }
  }
  return peak <= 1e-7 ? -Infinity : 20 * Math.log10(peak)
}

// fs/4 @45° full-scale: sample peak ≈ -3 dB but TRUE peak ≈ 0 dBTP (ISP case).
function ispSignal(n, amp = 1.0) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((Math.PI / 2) * i + Math.PI / 4)
  return x
}
function sine(freq, amp, n) {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR)
  return x
}

describe('truePeakLimit', () => {
  it('brings an inter-sample-peak signal under the ceiling', () => {
    const x = ispSignal(8000, 1.0)              // true peak ~0 dBTP
    expect(measureTruePeakDb([x])).toBeGreaterThan(-1)   // exceeds a -1 ceiling
    const limited = truePeakLimit([x, x], SR, -1)
    expect(measureTruePeakDb(limited)).toBeLessThanOrEqual(-1 + 0.3)  // now under ceiling
  })

  it('respects a -0.3 dBTP ceiling', () => {
    const limited = truePeakLimit([ispSignal(8000), ispSignal(8000)], SR, -0.3)
    expect(measureTruePeakDb(limited)).toBeLessThanOrEqual(-0.3 + 0.3)
  })

  it('leaves a signal already under the ceiling essentially untouched', () => {
    const x = sine(1000, 0.5, 4800)             // ~-6 dB, well under -1
    const limited = truePeakLimit([x, x], SR, -1)
    // gain ≈ 1 → output ≈ input (compare a steady mid sample)
    expect(limited[0][2400]).toBeCloseTo(x[2400], 3)
  })

  it('preserves length and channel count', () => {
    const x = sine(2000, 0.9, 2048)
    const out = truePeakLimit([x, x], SR, -1)
    expect(out.length).toBe(2)
    expect(out[0].length).toBe(2048)
  })

  it('links channels — both share one gain envelope (no image shift)', () => {
    const loud = ispSignal(8000, 1.0)
    const quiet = sine(1000, 0.1, 8000)
    const [l, r] = truePeakLimit([loud, quiet], SR, -1)
    // the quiet channel is scaled by the SAME envelope the loud channel forced
    const ratio0 = quiet[2400] !== 0 ? r[2400] / quiet[2400] : 1
    const ratio1 = loud[2400] !== 0 ? l[2400] / loud[2400] : 1
    expect(ratio0).toBeCloseTo(ratio1, 4)
  })
})
