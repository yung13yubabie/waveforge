// ITU-R BS.1770-4 compliant LUFS processor
// Runs in AudioWorklet scope — no imports allowed
class LUFSProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._initFilters(sampleRate) // sampleRate is global in AudioWorklet
    const sr = sampleRate
    // Ring buffers sized to window lengths
    this._mBuf = new Float32Array(Math.ceil(sr * 0.4)) // 400ms momentary
    this._sBuf = new Float32Array(Math.ceil(sr * 3.0)) // 3s short-term
    this._mPos = 0
    this._sPos = 0
    // Integrated: 400ms gating blocks @75% overlap (one per 100ms report tick)
    this._blocks = []
    // True peak: ITU-R BS.1770-4 Annex 2 — 4× oversample then inter-sample peak.
    // Polyphase windowed-sinc bank + per-channel delay lines (verified in
    // tests/audio/truepeak.test.js).
    this._tpTaps = 12
    this._tpBanks = this._makePolyphase(this._tpTaps, 4)
    this._tpDL = [new Float32Array(this._tpTaps), new Float32Array(this._tpTaps)]
    this._truePeak = 0
    // Report every 100ms
    this._reportEvery = Math.ceil(sr * 0.1)
    this._reportCtr = 0
    // Reset gate
    this.port.onmessage = e => { if (e.data === 'reset') this._reset() }
  }

  // Windowed-sinc 4-phase fractional-delay bank for 4× true-peak oversampling.
  _makePolyphase(taps, phases) {
    const center = (taps - 1) / 2
    const banks = []
    for (let p = 0; p < phases; p++) {
      const frac = p / phases
      const h = new Float32Array(taps)
      let sum = 0
      for (let k = 0; k < taps; k++) {
        const x = k - center - frac
        const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / taps)
        h[k] = s * w
        sum += h[k]
      }
      for (let k = 0; k < taps; k++) h[k] /= sum  // unity DC gain
      banks.push(h)
    }
    return banks
  }

  // Push one sample through a channel's oversampler; update running true peak.
  _trackTruePeak(ch, x) {
    const dl = this._tpDL[ch]
    const taps = this._tpTaps
    for (let k = taps - 1; k > 0; k--) dl[k] = dl[k - 1]
    dl[0] = x
    for (let p = 0; p < this._tpBanks.length; p++) {
      const h = this._tpBanks[p]
      let acc = 0
      for (let k = 0; k < taps; k++) acc += h[k] * dl[k]
      const a = Math.abs(acc)
      if (a > this._truePeak) this._truePeak = a
    }
  }

  _reset() {
    this._mBuf.fill(0); this._sBuf.fill(0)
    this._mPos = 0; this._sPos = 0
    this._blocks = []
    this._tpDL[0].fill(0); this._tpDL[1].fill(0)
    this._truePeak = 0; this._reportCtr = 0
  }

  // Build K-weighting biquad coefficients for given sample rate
  _initFilters(sr) {
    // Stage 1: Pre-filter — High shelf +4 dB shelf at 1681.97 Hz
    // Coefficients derived via bilinear transform (ITU-R BS.1770 Annex 1)
    const f0 = 1681.974450955533
    const G  = 3.999843853973347
    const Q  = 0.7071752369554196
    const K  = Math.tan(Math.PI * f0 / sr)
    const Vh = Math.pow(10, G / 20)
    const Vb = Math.pow(Vh, 0.4996667741545416)
    const d  = 1 + K / Q + K * K
    this._preB = [
      (Vh + Vb * K / Q + K * K) / d,
      2 * (K * K - Vh) / d,
      (Vh - Vb * K / Q + K * K) / d
    ]
    this._preA = [
      2 * (K * K - 1) / d,
      (1 - K / Q + K * K) / d
    ]

    // Stage 2: RLB filter — 2nd-order Butterworth high-pass at 38.13 Hz
    const f1 = 38.13547087613982
    const K2 = Math.tan(Math.PI * f1 / sr)
    const n  = 1 / (1 + K2 * Math.SQRT2 + K2 * K2)
    this._rlbB = [n, -2 * n, n]
    this._rlbA = [
      2 * (K2 * K2 - 1) * n,
      (1 - K2 * Math.SQRT2 + K2 * K2) * n
    ]

    // Per-channel filter states [x(n-1), x(n-2), y(n-1), y(n-2)]
    this._preS = [new Float32Array(4), new Float32Array(4)]
    this._rlbS = [new Float32Array(4), new Float32Array(4)]
  }

  _biquad(x, s, b, a) {
    const y = b[0]*x + b[1]*s[0] + b[2]*s[1] - a[0]*s[2] - a[1]*s[3]
    s[1] = s[0]; s[0] = x
    s[3] = s[2]; s[2] = y
    return y
  }

  process(inputs, outputs) {
    const inp = inputs[0]
    if (!inp || inp.length === 0) return true
    const nCh = Math.min(inp.length, 2)
    const len = inp[0] ? inp[0].length : 0
    if (len === 0) return true

    // Pass audio through (this node is for measurement only)
    for (let ch = 0; ch < outputs[0].length; ch++) {
      if (inp[ch]) outputs[0][ch].set(inp[ch])
    }

    for (let i = 0; i < len; i++) {
      let ms = 0
      for (let ch = 0; ch < nCh; ch++) {
        const x = inp[ch] ? inp[ch][i] : 0
        const pre = this._biquad(x, this._preS[ch], this._preB, this._preA)
        const rlb = this._biquad(pre, this._rlbS[ch], this._rlbB, this._rlbA)
        ms += rlb * rlb
        // True peak from the un-weighted signal, 4× oversampled (BS.1770-4 A2)
        this._trackTruePeak(ch, x)
      }
      ms /= nCh

      this._mBuf[this._mPos % this._mBuf.length] = ms
      this._mPos++
      this._sBuf[this._sPos % this._sBuf.length] = ms
      this._sPos++
    }

    this._reportCtr += len
    if (this._reportCtr >= this._reportEvery) {
      this._reportCtr = 0
      // Collect one 400ms gating block per 100ms tick (75% overlap, BS.1770-4)
      // — only once a full 400ms window has accumulated
      if (this._mPos >= this._mBuf.length) {
        this._blocks.push(this._bufMean(this._mBuf, this._mPos))
      }
      this._report()
    }
    return true
  }

  // BS.1770-4 two-stage gated integrated loudness:
  // stage 1: drop blocks below -70 LUFS (absolute gate)
  // stage 2: drop blocks below (stage-1 mean - 10 LU) (relative gate)
  _integratedMS() {
    const blocks = this._blocks
    if (blocks.length === 0) return 0

    const ABS_GATE_MS = Math.pow(10, (-70 + 0.691) / 10)
    let sum1 = 0, n1 = 0
    for (const b of blocks) {
      if (b > ABS_GATE_MS) { sum1 += b; n1++ }
    }
    if (n1 === 0) return 0

    const relGateMS = (sum1 / n1) * Math.pow(10, -10 / 10)  // -10 LU below stage-1 mean
    let sum2 = 0, n2 = 0
    for (const b of blocks) {
      if (b > ABS_GATE_MS && b > relGateMS) { sum2 += b; n2++ }
    }
    return n2 === 0 ? 0 : sum2 / n2
  }

  _bufMean(buf, filled) {
    const n = Math.min(filled, buf.length)
    if (n === 0) return 0
    let s = 0
    for (let i = 0; i < n; i++) s += buf[i]
    return s / n
  }

  _toLUFS(ms) {
    return ms <= 1e-10 ? -Infinity : -0.691 + 10 * Math.log10(ms)
  }

  _report() {
    const m  = this._toLUFS(this._bufMean(this._mBuf, this._mPos))
    const sh = this._toLUFS(this._bufMean(this._sBuf, this._sPos))
    const it = this._toLUFS(this._integratedMS())
    const tp = this._truePeak > 0
      ? 20 * Math.log10(this._truePeak) : -Infinity
    this.port.postMessage({ type: 'lufs', m, s: sh, i: it, tp })
  }
}

registerProcessor('lufs-processor', LUFSProcessor)
