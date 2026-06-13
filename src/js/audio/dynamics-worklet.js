// Phase-2 dynamics processors: de-esser + single-band dynamic EQ.
// Runs in AudioWorklet scope — must stay self-contained (no imports: the file
// is emitted as an unbundled asset). Math is mirrored in tests/audio/dynamics.test.js.

// ── Shared DSP helpers ──────────────────────────────────────
function envCoef(timeSec, sr) {
  return Math.exp(-1 / (Math.max(1e-4, timeSec) * sr))
}

function gainReductionDb(levelDb, threshDb, ratio) {
  if (!Number.isFinite(levelDb) || !Number.isFinite(threshDb)) return 0
  const r = Number.isFinite(ratio) && ratio >= 1 ? ratio : 1
  if (levelDb <= threshDb || r === 1) return 0
  return (threshDb - levelDb) * (1 - 1 / r)
}

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

function bandpassCoeffs(freq, sr, q = 1.5) {
  const w = 2 * Math.PI * freq / sr
  const alpha = Math.sin(w) / (2 * q)
  const cosw = Math.cos(w)
  const a0 = 1 + alpha
  return {
    b0: alpha / a0, b1: 0, b2: -alpha / a0,
    a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0,
  }
}

function biquadStep(x, st, c) {
  const y = c.b0 * x + c.b1 * st[0] + c.b2 * st[1] - c.a1 * st[2] - c.a2 * st[3]
  st[1] = st[0]; st[0] = x
  st[3] = st[2]; st[2] = y
  return y
}

function toDb(lin) { return lin <= 1e-7 ? -140 : 20 * Math.log10(lin) }

function passthrough(inp, out) {
  for (let ch = 0; ch < out.length; ch++) {
    if (inp[ch]) out[ch].set(inp[ch])
    else out[ch].fill(0)
  }
}

function clampParam(v, min, max, dflt) {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt
}

// ── De-esser: split-band sibilance compressor ───────────────
// Low band passes untouched; high band (input − lowpass residual, exact
// reconstruction) is gain-reduced when its envelope exceeds threshold.
class DeesserProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq',      defaultValue: 6000, minValue: 2000, maxValue: 10000, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -30,  minValue: -60,  maxValue: 0,     automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 1,    minValue: 0,    maxValue: 1,     automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this._lpState = [new Float32Array(4), new Float32Array(4)]
    this._env = [0, 0]
    this._atk = envCoef(0.001, sampleRate)   // 1 ms
    this._rel = envCoef(0.05, sampleRate)    // 50 ms
    this._coeffFreq = 0
    this._lpCoeffs = null
    // GR metering: report most reduction over each ~100ms window to the UI
    this._grWorst = 0
    this._grReportEvery = Math.ceil(sampleRate * 0.1)
    this._grCtr = 0
    // Bypass crossfade (1 = bypassed, 0 = active) — ramps to avoid toggle clicks
    this._bypassMix = 1
    this._bypK = 1 - envCoef(0.01, sampleRate)  // ~10 ms
    this._mixArr = new Float32Array(128)
  }

  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0]
    if (!inp || inp.length === 0 || !inp[0]) {
      for (const ch of out) ch.fill(0)
      return true
    }
    const targetMix = params.bypass[0] >= 0.5 ? 1 : 0
    // Fully settled in bypass → cheap passthrough (skip processing entirely)
    if (this._bypassMix === 1 && targetMix === 1) {
      passthrough(inp, out)
      this._reportGR(inp[0].length, true)
      return true
    }

    const freq   = clampParam(params.freq[0], 2000, 10000, 6000)
    const thresh = clampParam(params.threshold[0], -60, 0, -30)
    if (freq !== this._coeffFreq) {
      this._lpCoeffs = lowpassCoeffs(freq, sampleRate)
      this._coeffFreq = freq
    }

    const len = inp[0].length
    // Precompute the mix ramp so both channels crossfade in lock-step
    let mix = this._bypassMix
    for (let i = 0; i < len; i++) {
      mix += (targetMix - mix) * this._bypK
      this._mixArr[i] = mix
    }
    if (Math.abs(mix - targetMix) < 1e-4) mix = targetMix
    this._bypassMix = mix

    const nCh = Math.min(inp.length, 2)
    const RATIO = 4   // fixed de-essing ratio
    for (let ch = 0; ch < nCh; ch++) {
      const x = inp[ch], y = out[ch]
      const st = this._lpState[ch]
      for (let i = 0; i < x.length; i++) {
        const low  = biquadStep(x[i], st, this._lpCoeffs)
        const high = x[i] - low
        const lvl  = Math.abs(high)
        const c = lvl > this._env[ch] ? this._atk : this._rel
        this._env[ch] = c * this._env[ch] + (1 - c) * lvl
        const gr = gainReductionDb(toDb(this._env[ch]), thresh, RATIO)
        if (gr < this._grWorst) this._grWorst = gr   // most negative = most reduction
        const wet = low + high * Math.pow(10, gr / 20)
        const m = this._mixArr[i]
        y[i] = m * x[i] + (1 - m) * wet
      }
    }
    // Extra output channels (if any) mirror channel 0
    for (let ch = nCh; ch < out.length; ch++) out[ch].set(out[0])
    this._reportGR(inp[0].length, false)
    return true
  }

  _reportGR(len, idle) {
    this._grCtr += len
    if (this._grCtr >= this._grReportEvery) {
      this._grCtr = 0
      this.port.postMessage({ type: 'gr', value: idle ? 0 : this._grWorst })
      this._grWorst = 0
    }
  }
}

// ── Dynamic EQ: single band, cuts only when band exceeds threshold ──
// Detector: bandpass envelope at `freq`. Above threshold → negative peaking
// gain proportional to overshoot. Coefficients update per 128-sample block.
class DynEQProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq',      defaultValue: 2000, minValue: 200, maxValue: 8000, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -24,  minValue: -60, maxValue: 0,    automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 3,    minValue: 1,   maxValue: 10,   automationRate: 'k-rate' },
      { name: 'bypass',    defaultValue: 1,    minValue: 0,   maxValue: 1,    automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    // Parallel dynamic band: y = x + (g−1)·bandpass(x), with g smoothed per
    // sample. Fixed bandpass coeffs (no mid-stream swap → no click) and a
    // per-sample gain smoother (no per-block step → no zipper). Stereo-linked
    // gain (max envelope across channels) preserves the stereo image.
    this._bpState = [new Float32Array(4), new Float32Array(4)]
    this._env = [0, 0]
    this._g = 1
    this._atk = envCoef(0.005, sampleRate)   // 5 ms
    this._rel = envCoef(0.12, sampleRate)    // 120 ms
    this._gK = 1 - envCoef(0.002, sampleRate) // 2 ms gain smoothing
    this._bpFreq = 0
    this._bpCoeffs = bandpassCoeffs(2000, sampleRate)
    this._band = [0, 0]
    // GR metering (most reduction per ~100ms window)
    this._grWorst = 0
    this._grReportEvery = Math.ceil(sampleRate * 0.1)
    this._grCtr = 0
    // Bypass crossfade (1 = bypassed, 0 = active) — ramps to avoid toggle clicks
    this._bypassMix = 1
    this._bypK = 1 - envCoef(0.01, sampleRate)  // ~10 ms
  }

  process(inputs, outputs, params) {
    const inp = inputs[0], out = outputs[0]
    if (!inp || inp.length === 0 || !inp[0]) {
      for (const ch of out) ch.fill(0)
      return true
    }
    const targetMix = params.bypass[0] >= 0.5 ? 1 : 0
    if (this._bypassMix === 1 && targetMix === 1) {
      passthrough(inp, out)
      this._reportGR(inp[0].length, true)
      return true
    }

    const freq   = clampParam(params.freq[0], 200, 8000, 2000)
    const thresh = clampParam(params.threshold[0], -60, 0, -24)
    const ratio  = clampParam(params.ratio[0], 1, 10, 3)
    if (freq !== this._bpFreq) {
      this._bpCoeffs = bandpassCoeffs(freq, sampleRate)
      this._bpFreq = freq
    }

    const nCh = Math.min(inp.length, 2)
    const len = inp[0].length
    let mix = this._bypassMix

    for (let i = 0; i < len; i++) {
      // Bandpass + envelope per channel; link the gain to the max envelope
      let maxEnv = 0
      for (let ch = 0; ch < nCh; ch++) {
        const band = biquadStep(inp[ch][i], this._bpState[ch], this._bpCoeffs)
        this._band[ch] = band
        const lvl = Math.abs(band)
        const c = lvl > this._env[ch] ? this._atk : this._rel
        this._env[ch] = c * this._env[ch] + (1 - c) * lvl
        if (this._env[ch] > maxEnv) maxEnv = this._env[ch]
      }
      const gr = gainReductionDb(toDb(maxEnv), thresh, ratio)
      const target = Math.pow(10, gr / 20)
      this._g += (target - this._g) * this._gK
      mix += (targetMix - mix) * this._bypK
      const gm1 = (this._g - 1) * (1 - mix)   // fade the effect in/out
      for (let ch = 0; ch < nCh; ch++) {
        out[ch][i] = inp[ch][i] + gm1 * this._band[ch]
      }
      // Applied reduction in dB (smoothed gain, scaled by active mix)
      const effG = 1 + (this._g - 1) * (1 - mix)
      const grApplied = effG < 1 ? 20 * Math.log10(effG) : 0
      if (grApplied < this._grWorst) this._grWorst = grApplied
    }
    if (Math.abs(mix - targetMix) < 1e-4) mix = targetMix
    this._bypassMix = mix
    for (let ch = nCh; ch < out.length; ch++) out[ch].set(out[0])
    this._reportGR(len, false)
    return true
  }

  _reportGR(len, idle) {
    this._grCtr += len
    if (this._grCtr >= this._grReportEvery) {
      this._grCtr = 0
      this.port.postMessage({ type: 'gr', value: idle ? 0 : this._grWorst })
      this._grWorst = 0
    }
  }
}

registerProcessor('deesser-processor', DeesserProcessor)
registerProcessor('dyneq-processor', DynEQProcessor)
