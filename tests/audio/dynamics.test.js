// Tests for Phase-2 DSP math: de-esser / dynamic EQ / M/S matrix.
// Pure functions here MIRROR src/js/audio/dynamics-worklet.js (which must stay
// self-contained — AudioWorklet assets are emitted unbundled, imports break).
import { describe, it, expect } from 'vitest'

// ── Envelope follower (one-pole, separate attack/release) ──
function envCoef(timeSec, sr) {
  return Math.exp(-1 / (Math.max(1e-4, timeSec) * sr))
}

function followEnvelope(env, level, atkCoef, relCoef) {
  const c = level > env ? atkCoef : relCoef
  return c * env + (1 - c) * level
}

// ── Gain computer: downward compression above threshold ────
function gainReductionDb(levelDb, threshDb, ratio) {
  if (!Number.isFinite(levelDb) || !Number.isFinite(threshDb)) return 0
  const r = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
  if (levelDb <= threshDb || r === 1) return 0
  return (threshDb - levelDb) * (1 - 1 / r)   // negative dB
}

// ── M/S matrix ──────────────────────────────────────────────
function msEncode(l, r) { return [(l + r) / 2, (l - r) / 2] }
function msDecode(m, s) { return [m + s, m - s] }

// ── RBJ lowpass biquad (used for the de-esser band split) ───
function lowpassCoeffs(freq, sr, q = 0.707) {
  const w = 2 * Math.PI * freq / sr
  const alpha = Math.sin(w) / (2 * q)
  const cosw = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: ((1 - cosw) / 2) / a0,
    b1: (1 - cosw) / a0,
    b2: ((1 - cosw) / 2) / a0,
    a1: (-2 * cosw) / a0,
    a2: (1 - alpha) / a0,
  }
}

function biquadStep(x, st, c) {
  const y = c.b0 * x + c.b1 * st[0] + c.b2 * st[1] - c.a1 * st[2] - c.a2 * st[3]
  st[1] = st[0]; st[0] = x
  st[3] = st[2]; st[2] = y
  return y
}

describe('Phase-2 dynamics DSP math', () => {
  const SR = 48000

  describe('envelope follower', () => {
    it('rises toward a step input at the attack rate (~63% after 1 time-constant)', () => {
      const atk = envCoef(0.001, SR)   // 1 ms attack
      const rel = envCoef(0.05, SR)
      let env = 0
      for (let i = 0; i < SR * 0.001; i++) env = followEnvelope(env, 1, atk, rel)
      expect(env).toBeGreaterThan(0.55)
      expect(env).toBeLessThan(0.75)
    })

    it('decays after the input drops (release slower than attack)', () => {
      const atk = envCoef(0.001, SR)
      const rel = envCoef(0.05, SR)
      let env = 1
      for (let i = 0; i < SR * 0.05; i++) env = followEnvelope(env, 0, atk, rel)
      expect(env).toBeGreaterThan(0.2)  // 50ms release: ~37% left after 1 τ
      expect(env).toBeLessThan(0.5)
    })

    it('never overshoots the target level', () => {
      const atk = envCoef(0.001, SR)
      let env = 0
      for (let i = 0; i < SR; i++) env = followEnvelope(env, 0.8, atk, atk)
      expect(env).toBeLessThanOrEqual(0.8 + 1e-9)
    })
  })

  describe('gain computer', () => {
    it('returns 0 reduction below threshold', () => {
      expect(gainReductionDb(-40, -30, 4)).toBe(0)
    })

    it('reduces by (over × (1−1/ratio)) above threshold', () => {
      // 10 dB over at 2:1 → output should rise only 5 dB → reduce 5 dB
      expect(gainReductionDb(-20, -30, 2)).toBeCloseTo(-5, 5)
      // 12 dB over at 4:1 → reduce 9 dB
      expect(gainReductionDb(-18, -30, 4)).toBeCloseTo(-9, 5)
    })

    it('ratio 1:1 means no reduction', () => {
      expect(gainReductionDb(-10, -30, 1)).toBe(0)
    })

    it('guards NaN / invalid ratio instead of corrupting audio', () => {
      expect(gainReductionDb(NaN, -30, 4)).toBe(0)
      expect(gainReductionDb(-10, NaN, 4)).toBe(0)
      expect(gainReductionDb(-10, -30, NaN)).toBe(0)
      expect(gainReductionDb(-10, -30, 0.5)).toBe(0)  // ratio < 1 treated as 1
    })
  })

  describe('M/S matrix', () => {
    it('encode→decode roundtrip is identity', () => {
      const [m, s] = msEncode(0.7, -0.3)
      const [l, r] = msDecode(m, s)
      expect(l).toBeCloseTo(0.7, 10)
      expect(r).toBeCloseTo(-0.3, 10)
    })

    it('mono content (L=R) has zero side signal', () => {
      const [, s] = msEncode(0.5, 0.5)
      expect(s).toBe(0)
    })

    it('width 0 (side muted) collapses to mono', () => {
      const [m, s] = msEncode(0.9, 0.1)
      const [l, r] = msDecode(m, s * 0)
      expect(l).toBeCloseTo(r, 10)
      expect(l).toBeCloseTo(0.5, 10)  // the mono sum
    })

    it('width 2 doubles the stereo difference without touching mid', () => {
      const [m, s] = msEncode(0.6, 0.2)
      const [l, r] = msDecode(m, s * 2)
      expect((l + r) / 2).toBeCloseTo(m, 10)       // mid preserved
      expect(l - r).toBeCloseTo(2 * (0.6 - 0.2), 10) // difference doubled
    })
  })

  // Parallel dynamic-band DynEQ: fixed bandpass + per-sample smoothed gain.
  // Mirrors src/js/audio/dynamics-worklet.js DynEQProcessor (rewritten to kill
  // the coefficient-swap click and per-block zipper the old version had).
  function bandpassCoeffs(freq, sr, q = 1.5) {
    const w = 2 * Math.PI * freq / sr
    const alpha = Math.sin(w) / (2 * q)
    const cosw = Math.cos(w)
    const a0 = 1 + alpha
    return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0 }
  }
  function gainReductionDb(levelDb, threshDb, ratio) {
    if (!Number.isFinite(levelDb) || !Number.isFinite(threshDb)) return 0
    const r = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
    if (levelDb <= threshDb || r === 1) return 0
    return (threshDb - levelDb) * (1 - 1 / r)
  }
  const toDb = lin => (lin <= 1e-7 ? -140 : 20 * Math.log10(lin))

  function dynEqParallel(samples, { freq, thresh, ratio, sr }) {
    const bp = bandpassCoeffs(freq, sr)
    const st = new Float64Array(4)
    const atk = Math.exp(-1 / (0.005 * sr))
    const rel = Math.exp(-1 / (0.12 * sr))
    const gK = 1 - Math.exp(-1 / (0.002 * sr)) // 2ms gain smoothing
    let env = 0, g = 1
    const out = new Float64Array(samples.length)
    let maxGainStep = 0
    for (let i = 0; i < samples.length; i++) {
      const band = biquadStep(samples[i], st, bp)
      const lvl = Math.abs(band)
      const c = lvl > env ? atk : rel
      env = c * env + (1 - c) * lvl
      const gr = gainReductionDb(toDb(env), thresh, ratio)
      const target = Math.pow(10, gr / 20)
      const prevG = g
      g += (target - g) * gK
      maxGainStep = Math.max(maxGainStep, Math.abs(g - prevG))
      out[i] = samples[i] + (g - 1) * band
    }
    return { out, maxGainStep }
  }

  function rms(a) { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s / a.length) }

  describe('Dynamic EQ (parallel band, per-sample smoothed gain)', () => {
    const SR2 = 48000
    it('leaves a sub-threshold tone essentially untouched', () => {
      const N = 4800, f = 2000
      const s = new Float64Array(N)
      for (let n = 0; n < N; n++) s[n] = 0.02 * Math.sin(2 * Math.PI * f * n / SR2) // ~-34 dB
      const { out } = dynEqParallel(s, { freq: 2000, thresh: -24, ratio: 4, sr: SR2 })
      expect(rms(out)).toBeCloseTo(rms(s), 2)
    })

    it('attenuates a loud in-band tone above threshold', () => {
      const N = 9600, f = 2000
      const s = new Float64Array(N)
      for (let n = 0; n < N; n++) s[n] = 0.6 * Math.sin(2 * Math.PI * f * n / SR2) // ~-4.4 dB
      const { out } = dynEqParallel(s, { freq: 2000, thresh: -24, ratio: 4, sr: SR2 })
      // measure steady-state second half (after envelope settles)
      const half = out.slice(N / 2)
      const halfIn = s.slice(N / 2)
      expect(rms(half)).toBeLessThan(rms(halfIn) * 0.85)
    })

    it('does not zipper: per-sample gain step stays tiny (no per-block jumps)', () => {
      const N = 9600, f = 2000
      const s = new Float64Array(N)
      for (let n = 0; n < N; n++) s[n] = 0.6 * Math.sin(2 * Math.PI * f * n / SR2)
      const { maxGainStep } = dynEqParallel(s, { freq: 2000, thresh: -24, ratio: 4, sr: SR2 })
      expect(maxGainStep).toBeLessThan(0.01) // smooth — old per-block impl jumped far more
    })

    it('is frequency-selective: a far-band loud tone is barely affected', () => {
      const N = 9600, f = 200            // far below the 2kHz band
      const s = new Float64Array(N)
      for (let n = 0; n < N; n++) s[n] = 0.6 * Math.sin(2 * Math.PI * f * n / SR2)
      const { out } = dynEqParallel(s, { freq: 2000, thresh: -24, ratio: 4, sr: SR2 })
      const half = out.slice(N / 2), halfIn = s.slice(N / 2)
      expect(rms(half)).toBeGreaterThan(rms(halfIn) * 0.97)
    })
  })

  // Worklet bypass crossfade: switching bypass must ramp, not snap (no click).
  // Mirrors the _bypassMix one-pole ramp added to both processors.
  function bypassRamp(fromMix, toMix, len, sr, ms = 0.01) {
    const k = 1 - Math.exp(-1 / (ms * sr))
    let mix = fromMix
    let maxStep = 0
    const traj = []
    for (let i = 0; i < len; i++) {
      const prev = mix
      mix += (toMix - mix) * k
      maxStep = Math.max(maxStep, Math.abs(mix - prev))
      traj.push(mix)
    }
    return { mix, maxStep, traj }
  }

  describe('worklet bypass crossfade (anti-click)', () => {
    const SR4 = 48000
    it('ramps smoothly from active(0) to bypassed(1) with tiny per-sample steps', () => {
      const { maxStep } = bypassRamp(0, 1, 480, SR4) // 10ms worth
      expect(maxStep).toBeLessThan(0.01) // smooth — a hard switch would step 1.0
    })

    it('approaches the target within ~30ms', () => {
      const { mix } = bypassRamp(0, 1, Math.round(SR4 * 0.03), SR4)
      expect(mix).toBeGreaterThan(0.9)
    })

    it('blended output equals dry when fully bypassed, wet when fully active', () => {
      const dry = 0.5, wet = -0.3
      const blendBypassed = 1 * dry + (1 - 1) * wet
      const blendActive   = 0 * dry + (1 - 0) * wet
      expect(blendBypassed).toBe(dry)
      expect(blendActive).toBe(wet)
    })
  })

  describe('de-esser band split (LP + residual high band)', () => {
    it('high band = input − lowpass reconstructs the input exactly', () => {
      const c = lowpassCoeffs(6000, SR)
      const st = new Float32Array(4)
      for (let i = 0; i < 1000; i++) {
        const x = Math.sin(2 * Math.PI * 3000 * i / SR)
        const low = biquadStep(x, st, c)
        const high = x - low
        expect(low + high).toBeCloseTo(x, 6)   // perfect reconstruction by construction
      }
    })

    it('lowpass passes 200 Hz nearly unity and attenuates 12 kHz', () => {
      const c = lowpassCoeffs(6000, SR)
      const stLo = new Float32Array(4), stHi = new Float32Array(4)
      let peakLo = 0, peakHi = 0
      for (let i = 0; i < SR * 0.1; i++) {
        const lo = biquadStep(Math.sin(2 * Math.PI * 200 * i / SR), stLo, c)
        const hi = biquadStep(Math.sin(2 * Math.PI * 12000 * i / SR), stHi, c)
        if (i > SR * 0.05) {        // steady state only
          peakLo = Math.max(peakLo, Math.abs(lo))
          peakHi = Math.max(peakHi, Math.abs(hi))
        }
      }
      expect(peakLo).toBeGreaterThan(0.95)
      expect(peakHi).toBeLessThan(0.25)
    })
  })
})
