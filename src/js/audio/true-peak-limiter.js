import { scanTruePeak, assertMeasuredTruePeak } from './true-peak.js'

// Offline linked-channel limiting against a 4x finite-buffer peak estimate.
// A time-varying gain changes the reconstructed waveform: an envelope alone
// cannot prove a ceiling. Re-measure the result and apply a linked safety trim
// when necessary. This verifies this PCM estimator, not a codec/DAC guarantee.
export function truePeakLimit(channels, sampleRate, ceilingDb, opt = {}) {
  if (!(Number.isFinite(sampleRate) && sampleRate > 0 && Number.isFinite(ceilingDb))) {
    throw new Error('True-Peak 限幅設定無效')
  }
  const ceiling = Math.pow(10, ceilingDb / 20)
  if (!(Number.isFinite(ceiling) && ceiling > 0)) throw new Error('True-Peak 天花板設定無效')
  const { envelope } = scanTruePeak(channels, { envelope: true })
  const length = envelope.length
  if (!length) return channels.map(ch => new Float32Array(ch))
  const releaseMs = opt.releaseMs ?? 60
  const lookaheadMs = opt.lookaheadMs ?? 2
  if (![releaseMs, lookaheadMs].every(v => Number.isFinite(v) && v >= 0)) {
    throw new Error('True-Peak 時間設定無效')
  }
  const release = Math.exp(-1 / (Math.max(1e-4, releaseMs / 1000) * sampleRate))
  const attack = Math.exp(-1 / (Math.max(1e-4, lookaheadMs / 1000) * sampleRate))
  const gain = new Float64Array(length)
  let current = 1
  for (let n = 0; n < length; n++) {
    const required = envelope[n] > ceiling ? ceiling / envelope[n] : 1
    current = Math.min(release * current + 1 - release, required)
    gain[n] = current
  }
  let back = gain[length - 1]
  for (let n = length - 1; n >= 0; n--) {
    back = Math.min(attack * back + 1 - attack, gain[n])
    gain[n] = Math.min(gain[n], back)
  }
  const result = channels.map(ch => Float32Array.from(ch, (value, i) => value * gain[i]))
  // Fixed linear attenuation scales every interpolated peak by the same amount.
  // A tiny margin absorbs Float32 rounding. Never boost/normalize a quiet signal.
  let { peak } = scanTruePeak(result)
  for (let attempt = 0; attempt < 2 && peak > ceiling; attempt++) {
    const safetyGain = (ceiling / peak) * (1 - 1e-6)
    for (const ch of result) for (let i = 0; i < ch.length; i++) ch[i] *= safetyGain
    peak = scanTruePeak(result).peak
  }
  assertMeasuredTruePeak(peak > 0 ? 20 * Math.log10(peak) : -Infinity, ceilingDb)
  return result
}
