import { describe, it, expect } from 'vitest'
import { averageSpectrum, computeMatchCurve } from '../../src/js/audio/match-eq.js'

const SR = 48000
const BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

function sine(freq, amp, secs) {
  const n = Math.round(SR * secs)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * freq * i / SR)
  return x
}
function nearestBand(freq) {
  let best = 0, bd = Infinity
  BANDS.forEach((b, i) => { const d = Math.abs(Math.log2(b / freq)); if (d < bd) { bd = d; best = i } })
  return best
}

describe('averageSpectrum', () => {
  it('puts a tone’s energy in the band nearest its frequency', () => {
    const x = sine(1000, 0.5, 1)
    const bands = averageSpectrum([x, x], SR, BANDS)
    const peakBand = bands.indexOf(Math.max(...bands))
    expect(peakBand).toBe(nearestBand(1000))   // band index 5 (1kHz)
  })

  it('a low tone peaks in a low band, a high tone in a high band', () => {
    const lo = sine(80, 0.5, 1)
    const hi = sine(8000, 0.5, 1)
    const loBands = averageSpectrum([lo, lo], SR, BANDS)
    const hiBands = averageSpectrum([hi, hi], SR, BANDS)
    expect(loBands.indexOf(Math.max(...loBands))).toBeLessThan(3)
    expect(hiBands.indexOf(Math.max(...hiBands))).toBeGreaterThan(6)
  })

  it('returns one magnitude per band', () => {
    const x = sine(440, 0.3, 0.5)
    expect(averageSpectrum([x], SR, BANDS).length).toBe(BANDS.length)
  })

  it('returns null for a clip shorter than one FFT frame (no silent flat match)', () => {
    const tiny = new Float32Array(1000)   // < 4096 samples
    for (let i = 0; i < tiny.length; i++) tiny[i] = Math.sin(i)
    expect(averageSpectrum([tiny], SR, BANDS)).toBeNull()
  })
})

describe('computeMatchCurve', () => {
  it('identical spectra → ~0 dB across all bands', () => {
    const s = [1, 2, 3, 4, 5, 4, 3, 2, 1, 0.5]
    computeMatchCurve(s, s).forEach(g => expect(Math.abs(g)).toBeLessThan(1e-6))
  })

  it('is zero-mean (matches shape, not overall level)', () => {
    const src = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const ref = [4, 4, 4, 4, 4, 1, 1, 1, 1, 1]   // ref louder in lows
    const curve = computeMatchCurve(src, ref)
    const mean = curve.reduce((a, b) => a + b, 0) / curve.length
    expect(Math.abs(mean)).toBeLessThan(1e-6)
  })

  it('reference with more low-end → positive low-band gains, negative highs', () => {
    const src = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const ref = [4, 4, 4, 2, 1, 1, 1, 1, 1, 1]
    const curve = computeMatchCurve(src, ref)
    expect(curve[0]).toBeGreaterThan(0)   // lows boosted
    expect(curve[9]).toBeLessThan(0)      // highs cut (relative)
  })

  it('clamps to ±maxDb', () => {
    const src = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0.0001]   // huge deficit in last band
    const ref = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1000]
    const curve = computeMatchCurve(src, ref, 12)
    curve.forEach(g => { expect(g).toBeLessThanOrEqual(12); expect(g).toBeGreaterThanOrEqual(-12) })
  })

  it('ignores near-empty bands (no spurious gain on silent frequencies)', () => {
    // band 0 has negligible energy in both → must stay 0, not clamp to ±max
    const src = [0.0000001, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const ref = [0.0000001, 1, 1, 1, 1, 1, 1, 1, 1, 4]
    const curve = computeMatchCurve(src, ref)
    expect(curve[0]).toBe(0)         // empty band untouched
    expect(curve[9]).toBeGreaterThan(0)  // real difference still applied
  })

  it('strength scales the curve', () => {
    const src = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const ref = [4, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const full = computeMatchCurve(src, ref, 12, 1)
    const half = computeMatchCurve(src, ref, 12, 0.5)
    expect(half[0]).toBeCloseTo(full[0] * 0.5, 6)
  })
})
