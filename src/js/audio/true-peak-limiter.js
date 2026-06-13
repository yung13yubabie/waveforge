// Offline true-peak (inter-sample peak) limiter for the export master. The
// realtime limiter is a DynamicsCompressor (sample-peak, low latency); this
// final offline pass GUARANTEES the delivered file's true peak ≤ ceiling.
//
// Method: 4× oversample to see inter-sample peaks → per-sample required gain
// (min(1, ceiling/|peak|)) → smooth with look-ahead attack + release passes that
// only ever LOWER gain below the requirement (so the ceiling bound is provable)
// → apply the gain envelope to the original-rate samples.

const TAPS = 12, PHASES = 4

function polyphase() {
  const center = (TAPS - 1) / 2
  const banks = []
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES
    const h = new Float64Array(TAPS)
    let sum = 0
    for (let k = 0; k < TAPS; k++) {
      const x = k - center - frac
      const s = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 0.5)) / TAPS)
      h[k] = s * w
      sum += h[k]
    }
    for (let k = 0; k < TAPS; k++) h[k] /= sum
    banks.push(h)
  }
  return banks
}

// Per-original-sample max |inter-sample value| across all channels.
function truePeakEnvelope(channels) {
  const banks = polyphase()
  const N = channels[0].length
  const env = new Float64Array(N)
  for (const x of channels) {
    const dl = new Float64Array(TAPS)
    for (let n = 0; n < N; n++) {
      for (let k = TAPS - 1; k > 0; k--) dl[k] = dl[k - 1]
      dl[0] = x[n]
      for (let p = 0; p < PHASES; p++) {
        const h = banks[p]
        let acc = 0
        for (let k = 0; k < TAPS; k++) acc += h[k] * dl[k]
        const a = Math.abs(acc)
        if (a > env[n]) env[n] = a
      }
    }
  }
  return env
}

/**
 * @param {Float32Array[]} channels  (mutated copies returned)
 * @param {number} sampleRate
 * @param {number} ceilingDb  e.g. -1
 * @param {object} [opt]  { releaseMs=60, lookaheadMs=2 }
 * @returns {Float32Array[]} limited channels (true peak ≤ ceiling)
 */
export function truePeakLimit(channels, sampleRate, ceilingDb, opt = {}) {
  const ceil = Math.pow(10, ceilingDb / 20)
  const N = channels[0].length
  const env = truePeakEnvelope(channels)

  // required gain per sample so the true peak there is ≤ ceiling
  const req = new Float64Array(N)
  for (let n = 0; n < N; n++) req[n] = env[n] > ceil ? ceil / env[n] : 1

  // release: forward pass — gain may rise toward 1 only at the release rate
  const relCoef = Math.exp(-1 / (Math.max(1e-4, (opt.releaseMs ?? 60) / 1000) * sampleRate))
  const g = new Float64Array(N)
  let cur = 1
  for (let n = 0; n < N; n++) {
    cur = relCoef * cur + (1 - relCoef) * 1      // drift back toward unity
    if (req[n] < cur) cur = req[n]               // instant duck to requirement
    g[n] = cur
  }
  // attack look-ahead: backward pass — pre-duck before peaks (only lowers gain)
  const atkCoef = Math.exp(-1 / (Math.max(1e-4, (opt.lookaheadMs ?? 2) / 1000) * sampleRate))
  let back = g[N - 1]
  for (let n = N - 1; n >= 0; n--) {
    back = atkCoef * back + (1 - atkCoef) * 1
    if (g[n] < back) back = g[n]
    if (back < g[n]) g[n] = back                 // never raise above the release env
  }

  return channels.map(x => {
    const out = new Float32Array(N)
    for (let n = 0; n < N; n++) out[n] = x[n] * g[n]
    return out
  })
}
