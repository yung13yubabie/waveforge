// Offline mastering measurements for the export report: integrated LUFS,
// true peak (4× oversampled), sample peak, clip detection.
// Mirrors the DSP in lufs-worklet.js so the export receipt matches the live
// meter, but runs synchronously over a finished AudioBuffer.

// ── K-weighting biquad coefficients (ITU-R BS.1770-4) ───────
function kWeightCoeffs(sr) {
  const f0 = 1681.974450955533
  const G  = 3.999843853973347
  const Q  = 0.7071752369554196
  const K  = Math.tan(Math.PI * f0 / sr)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const d  = 1 + K / Q + K * K
  const preB = [(Vh + Vb * K / Q + K * K) / d, 2 * (K * K - Vh) / d, (Vh - Vb * K / Q + K * K) / d]
  const preA = [2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]
  const f1 = 38.13547087613982
  const K2 = Math.tan(Math.PI * f1 / sr)
  const n  = 1 / (1 + K2 * Math.SQRT2 + K2 * K2)
  const rlbB = [n, -2 * n, n]
  const rlbA = [2 * (K2 * K2 - 1) * n, (1 - K2 * Math.SQRT2 + K2 * K2) * n]
  return { preB, preA, rlbB, rlbA }
}

function biquad(x, s, b, a) {
  const y = b[0] * x + b[1] * s[0] + b[2] * s[1] - a[0] * s[2] - a[1] * s[3]
  s[1] = s[0]; s[0] = x
  s[3] = s[2]; s[2] = y
  return y
}

// channels: array of Float32Array (1 or 2). Returns integrated LUFS or -Infinity.
export function measureIntegratedLUFS(channels, sr) {
  const nCh = Math.min(channels.length, 2)
  const len = channels[0]?.length ?? 0
  if (len === 0) return -Infinity
  const c = kWeightCoeffs(sr)
  const preS = [new Float64Array(4), new Float64Array(4)]
  const rlbS = [new Float64Array(4), new Float64Array(4)]

  const blockLen = Math.round(sr * 0.4)        // 400ms
  const hop      = Math.round(sr * 0.1)        // 100ms (75% overlap)
  const msBuf    = new Float64Array(len)
  for (let i = 0; i < len; i++) {
    let ms = 0
    for (let ch = 0; ch < nCh; ch++) {
      const x = channels[ch][i]
      const pre = biquad(x, preS[ch], c.preB, c.preA)
      const rlb = biquad(pre, rlbS[ch], c.rlbB, c.rlbA)
      ms += rlb * rlb
    }
    msBuf[i] = ms / nCh
  }

  // 400ms block mean-squares
  const blocks = []
  for (let start = 0; start + blockLen <= len; start += hop) {
    let s = 0
    for (let i = start; i < start + blockLen; i++) s += msBuf[i]
    blocks.push(s / blockLen)
  }
  if (blocks.length === 0) {           // shorter than 400ms: one block of all
    let s = 0
    for (let i = 0; i < len; i++) s += msBuf[i]
    blocks.push(s / len)
  }

  // BS.1770-4 two-stage gating
  const ABS = Math.pow(10, (-70 + 0.691) / 10)
  let sum1 = 0, n1 = 0
  for (const b of blocks) if (b > ABS) { sum1 += b; n1++ }
  if (n1 === 0) return -Infinity
  const rel = (sum1 / n1) * Math.pow(10, -1)
  let sum2 = 0, n2 = 0
  for (const b of blocks) if (b > ABS && b > rel) { sum2 += b; n2++ }
  const meanMs = n2 === 0 ? 0 : sum2 / n2
  return meanMs <= 1e-10 ? -Infinity : -0.691 + 10 * Math.log10(meanMs)
}

// ── True peak (4× oversampled) — same polyphase bank as the worklet ──
function polyphase(taps, phases) {
  const center = (taps - 1) / 2
  const banks = []
  for (let p = 0; p < phases; p++) {
    const frac = p / phases
    const h = new Float64Array(taps)
    let sum = 0
    for (let k = 0; k < taps; k++) {
      const x = k - center - frac
      const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / taps)
      h[k] = s * w
      sum += h[k]
    }
    for (let k = 0; k < taps; k++) h[k] /= sum
    banks.push(h)
  }
  return banks
}

// Returns { samplePeakDb, truePeakDb, clipped } for the buffer.
export function measurePeaks(channels) {
  const taps = 12
  const banks = polyphase(taps, 4)
  let samplePeak = 0, truePeak = 0
  for (const x of channels) {
    const dl = new Float64Array(taps)
    for (let n = 0; n < x.length; n++) {
      const a = Math.abs(x[n])
      if (a > samplePeak) samplePeak = a
      for (let k = taps - 1; k > 0; k--) dl[k] = dl[k - 1]
      dl[0] = x[n]
      for (let p = 0; p < banks.length; p++) {
        const h = banks[p]
        let acc = 0
        for (let k = 0; k < taps; k++) acc += h[k] * dl[k]
        const av = Math.abs(acc)
        if (av > truePeak) truePeak = av
      }
    }
  }
  const toDb = v => (v <= 1e-7 ? -Infinity : 20 * Math.log10(v))
  return {
    samplePeakDb: toDb(samplePeak),
    truePeakDb: toDb(truePeak),
    clipped: samplePeak >= 0.9999,   // 16/24-bit full scale → clip on re-quantise
  }
}

// Stereo phase correlation: +1 = mono/in-phase, 0 = uncorrelated (wide),
// −1 = anti-phase (mono-incompatible). The safety net for M/S width work.
export function correlation(left, right) {
  const n = Math.min(left.length, right.length)
  if (n === 0) return 0
  let sumLR = 0, sumL2 = 0, sumR2 = 0
  for (let i = 0; i < n; i++) {
    const l = left[i], r = right[i]
    sumLR += l * r
    sumL2 += l * l
    sumR2 += r * r
  }
  const denom = Math.sqrt(sumL2 * sumR2)
  if (denom < 1e-12) return 0   // silence → no meaningful correlation
  return Math.max(-1, Math.min(1, sumLR / denom))
}

// Build the export report from a rendered AudioBuffer.
// targetLUFS / ceilingDb come from the active preset / limiter setting.
export function buildExportReport(channels, sr, { targetLUFS = null, ceilingDb = -1 } = {}) {
  const lufs = measureIntegratedLUFS(channels, sr)
  const { samplePeakDb, truePeakDb, clipped } = measurePeaks(channels)
  const warnings = []
  if (clipped) warnings.push('數位削波：有樣本達滿刻度（0 dBFS）')
  if (truePeakDb > ceilingDb + 0.05) {
    warnings.push(`True Peak ${truePeakDb.toFixed(1)} dBTP 超過天花板 ${ceilingDb.toFixed(1)} dB`)
  }
  let lufsNote = null
  if (targetLUFS != null && Number.isFinite(lufs)) {
    const delta = lufs - targetLUFS
    lufsNote = Math.abs(delta) <= 1
      ? `達標（目標 ${targetLUFS} LUFS）`
      : `${delta > 0 ? '高' : '低'}於目標 ${Math.abs(delta).toFixed(1)} LU（目標 ${targetLUFS}）`
  }
  return { lufs, samplePeakDb, truePeakDb, clipped, warnings, lufsNote }
}
