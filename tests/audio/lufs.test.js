// Tests for LUFS worklet logic extracted into pure functions.
// The worklet itself runs in AudioWorklet scope; we test the math here.
import { describe, it, expect } from 'vitest'

// ── Pure functions mirroring lufs-worklet.js logic ────────
function toLUFS(ms) {
  return ms <= 1e-10 ? -Infinity : -0.691 + 10 * Math.log10(ms)
}

function bufMean(buf, filled) {
  const n = Math.min(filled, buf.length)
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += buf[i]
  return s / n
}

// K-weighting coefficients at 48kHz (must match lufs-worklet.js exactly)
function buildKWeightCoeffs(sr = 48000) {
  const f0 = 1681.974450955533
  const G  = 3.999843853973347
  const Q  = 0.7071752369554196
  const K  = Math.tan(Math.PI * f0 / sr)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const d  = 1 + K / Q + K * K
  const preB = [
    (Vh + Vb * K / Q + K * K) / d,
    2 * (K * K - Vh) / d,
    (Vh - Vb * K / Q + K * K) / d,
  ]
  const preA = [2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]

  const f1 = 38.13547087613982
  const K2 = Math.tan(Math.PI * f1 / sr)
  const n  = 1 / (1 + K2 * Math.SQRT2 + K2 * K2)
  const rlbB = [n, -2 * n, n]
  const rlbA = [2 * (K2 * K2 - 1) * n, (1 - K2 * Math.SQRT2 + K2 * K2) * n]

  return { preB, preA, rlbB, rlbA }
}

function applyBiquad(x, state, b, a) {
  const y = b[0]*x + b[1]*state[0] + b[2]*state[1] - a[0]*state[2] - a[1]*state[3]
  state[1] = state[0]; state[0] = x
  state[3] = state[2]; state[2] = y
  return y
}

describe('LUFS measurement math', () => {
  describe('toLUFS()', () => {
    it('returns -Infinity for zero mean-square', () => {
      expect(toLUFS(0)).toBe(-Infinity)
    })

    it('returns -Infinity for negative mean-square (corrupted data)', () => {
      expect(toLUFS(-0.001)).toBe(-Infinity)
    })

    it('returns -Infinity for near-zero values below threshold', () => {
      expect(toLUFS(1e-12)).toBe(-Infinity)
    })

    it('returns ≈ -0.691 LUFS for unity mean-square (1.0)', () => {
      expect(toLUFS(1)).toBeCloseTo(-0.691, 2)
    })

    it('returns finite number for valid mean-square', () => {
      const v = toLUFS(0.01)
      expect(isFinite(v)).toBe(true)
    })

    it('is monotonically increasing with mean-square', () => {
      expect(toLUFS(0.1)).toBeLessThan(toLUFS(0.5))
      expect(toLUFS(0.5)).toBeLessThan(toLUFS(1.0))
    })
  })

  describe('bufMean()', () => {
    it('returns 0 for empty buffer (filled=0)', () => {
      expect(bufMean(new Float32Array(100), 0)).toBe(0)
    })

    it('calculates correct mean of fully filled buffer', () => {
      const buf = new Float32Array([1, 2, 3, 4])
      expect(bufMean(buf, 4)).toBeCloseTo(2.5, 5)
    })

    it('only averages up to filled count, not full length', () => {
      const buf = new Float32Array([0.5, 0.5, 99, 99])
      expect(bufMean(buf, 2)).toBeCloseTo(0.5, 5)
    })

    it('clamps filled to buffer length when filled exceeds length', () => {
      const buf = new Float32Array([1, 1, 1])
      expect(bufMean(buf, 1000)).toBeCloseTo(1.0, 5)
    })
  })

  describe('K-weighting filter coefficients', () => {
    it('builds coefficients at 48kHz without throwing', () => {
      expect(() => buildKWeightCoeffs(48000)).not.toThrow()
    })

    it('pre-filter b coefficients sum to a positive number', () => {
      const { preB } = buildKWeightCoeffs(48000)
      expect(preB[0] + preB[1] + preB[2]).toBeGreaterThan(0)
    })

    it('RLB filter b coefficients satisfy high-pass constraint (b0=b2, b1=-2*b0)', () => {
      const { rlbB } = buildKWeightCoeffs(48000)
      expect(rlbB[0]).toBeCloseTo(rlbB[2], 6)
      expect(rlbB[1]).toBeCloseTo(-2 * rlbB[0], 6)
    })

    it('produces different coefficients for different sample rates', () => {
      const c48 = buildKWeightCoeffs(48000)
      const c44 = buildKWeightCoeffs(44100)
      expect(c48.preB[0]).not.toBeCloseTo(c44.preB[0], 6)
    })
  })

  describe('K-weighting filter: DC signal rejection', () => {
    it('attenuates DC (0 Hz) through RLB high-pass filter', () => {
      const { rlbB, rlbA } = buildKWeightCoeffs(48000)
      const state = new Float32Array(4)
      // Feed DC=1.0 for many samples, filter should reject it
      let out = 0
      for (let i = 0; i < 10000; i++) {
        out = applyBiquad(1.0, state, rlbB, rlbA)
      }
      // DC should be nearly zero at steady state (high-pass)
      expect(Math.abs(out)).toBeLessThan(0.01)
    })
  })

  describe('K-weighting filter: high-frequency pass', () => {
    it('passes high-frequency content (>1kHz) with near-unity gain through RLB', () => {
      const { rlbB, rlbA } = buildKWeightCoeffs(48000)
      const state = new Float32Array(4)
      const freq = 5000
      const sr   = 48000
      // Fill filter with steady-state
      let out = 0
      for (let i = 0; i < 2000; i++) {
        out = applyBiquad(Math.sin(2 * Math.PI * freq * i / sr), state, rlbB, rlbA)
      }
      // At 5kHz, RLB should pass near unity
      expect(Math.abs(out)).toBeGreaterThan(0.8)
    })
  })

  describe('integrated LUFS gating: silent file', () => {
    it('silent signal (all zeros) produces -Infinity LUFS', () => {
      const ms = 0
      expect(toLUFS(ms)).toBe(-Infinity)
    })
  })

  describe('BS.1770-4 two-stage gating (mirrors lufs-worklet._integratedMS)', () => {
    function integratedMS(blocks) {
      if (blocks.length === 0) return 0
      const ABS_GATE_MS = Math.pow(10, (-70 + 0.691) / 10)
      let sum1 = 0, n1 = 0
      for (const b of blocks) if (b > ABS_GATE_MS) { sum1 += b; n1++ }
      if (n1 === 0) return 0
      const relGateMS = (sum1 / n1) * Math.pow(10, -1)
      let sum2 = 0, n2 = 0
      for (const b of blocks) if (b > ABS_GATE_MS && b > relGateMS) { sum2 += b; n2++ }
      return n2 === 0 ? 0 : sum2 / n2
    }

    it('returns 0 (→ -Inf LUFS) for empty block list', () => {
      expect(integratedMS([])).toBe(0)
    })

    it('returns 0 when all blocks are below the -70 LUFS absolute gate', () => {
      const tiny = Math.pow(10, (-80 + 0.691) / 10)   // -80 LUFS block
      expect(integratedMS([tiny, tiny, tiny])).toBe(0)
    })

    it('leading silence does NOT drag integrated reading down (gating works)', () => {
      const loud   = Math.pow(10, (-14 + 0.691) / 10)  // -14 LUFS blocks
      const silent = 0                                  // gated out
      const gated   = integratedMS([silent, silent, silent, loud, loud, loud])
      const ungated = [silent, silent, silent, loud, loud, loud].reduce((a, b) => a + b) / 6
      expect(toLUFS(gated)).toBeCloseTo(-14, 1)        // gated = true loudness
      expect(toLUFS(ungated)).toBeLessThan(-16)         // ungated would under-report
    })

    it('relative gate drops blocks 10 LU below the mean', () => {
      const loud  = Math.pow(10, (-10 + 0.691) / 10)   // -10 LUFS
      const quiet = Math.pow(10, (-40 + 0.691) / 10)   // -40 LUFS — above abs gate, below rel gate
      const result = integratedMS([loud, loud, loud, loud, quiet])
      expect(toLUFS(result)).toBeCloseTo(-10, 1)
    })

    it('uniform loudness passes through unchanged', () => {
      const b = Math.pow(10, (-23 + 0.691) / 10)        // -23 LUFS (EBU R128 ref)
      expect(toLUFS(integratedMS([b, b, b, b]))).toBeCloseTo(-23, 1)
    })
  })

  describe('LUFS range sanity', () => {
    it('typical music (RMS ~-18 dBFS) yields ~-16 to -20 integrated LUFS', () => {
      // RMS of -18 dBFS ≈ linear 0.126
      const rms = Math.pow(10, -18 / 20)
      const ms = rms * rms
      const lufs = toLUFS(ms)
      expect(lufs).toBeGreaterThan(-25)
      expect(lufs).toBeLessThan(-10)
    })

    it('full-scale digital sine (RMS ≈ 0.707) yields ~0 LUFS (unweighted)', () => {
      const ms = 0.5  // RMS of full-scale sine
      const lufs = toLUFS(ms)
      expect(lufs).toBeCloseTo(-3.69, 1)
    })
  })
})
