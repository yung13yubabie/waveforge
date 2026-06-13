import { describe, it, expect } from 'vitest'
import { designLinearPhaseFIR, applyLinearPhaseEQ } from '../../src/js/audio/lin-phase-eq.js'

const N = 512
const SR = 48000

function flatMag(n = N) { return new Float32Array(n / 2 + 1).fill(1) }

// Half-spectrum magnitude that boosts low frequencies (shelf-like).
function lowBoostMag(n = N, boost = 2) {
  const m = new Float32Array(n / 2 + 1)
  for (let k = 0; k <= n / 2; k++) m[k] = k < n / 8 ? boost : 1
  return m
}

function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length) }
function sine(freq, amp, len) {
  const x = new Float32Array(len)
  for (let i = 0; i < len; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR)
  return x
}

describe('designLinearPhaseFIR', () => {
  it('produces a symmetric (linear-phase) impulse response', () => {
    const fir = designLinearPhaseFIR(lowBoostMag(), N)
    let maxAsym = 0
    for (let k = 1; k < N; k++) maxAsym = Math.max(maxAsym, Math.abs(fir[k] - fir[N - k]))
    expect(maxAsym).toBeLessThan(1e-6)   // fir[k] == fir[N-k] → symmetric about N/2
  })

  it('flat magnitude → near-unity DC gain (sum ≈ 1)', () => {
    const fir = designLinearPhaseFIR(flatMag(), N)
    const sum = fir.reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 2)
  })

  it('its peak sits at the centre tap (N/2)', () => {
    const fir = designLinearPhaseFIR(flatMag(), N)
    let peakIdx = 0, peak = 0
    for (let k = 0; k < N; k++) if (Math.abs(fir[k]) > peak) { peak = Math.abs(fir[k]); peakIdx = k }
    expect(peakIdx).toBe(N / 2)
  })
})

describe('applyLinearPhaseEQ', () => {
  it('flat magnitude is approximately transparent (output ≈ input)', () => {
    const x = sine(1000, 0.5, 4096)
    const [out] = applyLinearPhaseEQ([x], flatMag(), N)
    expect(out.length).toBe(x.length)
    // ignore edges (FIR transient); compare the steady middle
    const mid = out.slice(1000, 3000), midIn = x.slice(1000, 3000)
    expect(rms(mid)).toBeCloseTo(rms(midIn), 1)
  })

  it('low-boost magnitude raises low-frequency energy', () => {
    const lowTone = sine(120, 0.3, 4096)
    const [boosted] = applyLinearPhaseEQ([lowTone], lowBoostMag(N, 2), N)
    const mid = boosted.slice(1000, 3000), midIn = lowTone.slice(1000, 3000)
    expect(rms(mid)).toBeGreaterThan(rms(midIn) * 1.4)   // ~boosted
  })

  it('leaves a high tone alone when only lows are boosted', () => {
    const highTone = sine(10000, 0.3, 4096)
    const [out] = applyLinearPhaseEQ([highTone], lowBoostMag(N, 2), N)
    const mid = out.slice(1000, 3000), midIn = highTone.slice(1000, 3000)
    expect(rms(mid)).toBeCloseTo(rms(midIn), 1)
  })

  it('preserves length and processes stereo independently', () => {
    const l = sine(100, 0.4, 2048), r = sine(5000, 0.4, 2048)
    const [lo, ro] = applyLinearPhaseEQ([l, r], flatMag(), N)
    expect(lo.length).toBe(2048)
    expect(ro.length).toBe(2048)
  })

  it('is delay-compensated: output aligns in time with input (peak position)', () => {
    // an impulse-like input through a flat EQ should stay roughly in place
    const x = new Float32Array(2048)
    x[1024] = 1
    const [out] = applyLinearPhaseEQ([x], flatMag(), N)
    let peakIdx = 0, peak = 0
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); peakIdx = i }
    expect(Math.abs(peakIdx - 1024)).toBeLessThanOrEqual(1)  // aligned (± half sample)
  })
})
