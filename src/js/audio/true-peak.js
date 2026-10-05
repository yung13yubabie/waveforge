// Finite-buffer 4x windowed-sinc peak ESTIMATE, shared by offline limiting and
// the PCM export report. This is not an independent/certified codec or DAC oracle.
// Flush the FIR with zeros at EOF and include sample peaks, including short clips.
const TAPS = 12
const PHASES = 4
const CENTER = (TAPS - 1) / 2
const BANKS = Array.from({ length: PHASES }, (_, phase) => {
  const h = new Float64Array(TAPS)
  let sum = 0
  for (let k = 0; k < TAPS; k++) {
    const x = k - CENTER - phase / PHASES
    const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    h[k] = sinc * (0.5 - 0.5 * Math.cos(2 * Math.PI * (k + 0.5) / TAPS))
    sum += h[k]
  }
  for (let k = 0; k < TAPS; k++) h[k] /= sum
  return h
})

export function scanTruePeak(channels, { envelope = false } = {}) {
  const length = channels[0]?.length ?? 0
  if (channels.some(ch => ch.length !== length)) throw new Error('音訊聲道長度不一致')
  const env = envelope ? new Float64Array(length) : null
  let samplePeak = 0, peak = 0
  for (const x of channels) {
    const delay = new Float64Array(TAPS)
    // The final TAPS-1 zero samples flush all contributions of the last sample.
    for (let n = 0; n < length + TAPS - 1; n++) {
      const input = n < length ? x[n] : 0
      if (!Number.isFinite(input)) throw new Error('音訊包含非有限數值，無法量測或輸出')
      const a = Math.abs(input)
      samplePeak = Math.max(samplePeak, a)
      peak = Math.max(peak, a)
      if (env && n < length) env[n] = Math.max(env[n], a)
      for (let k = TAPS - 1; k > 0; k--) delay[k] = delay[k - 1]
      delay[0] = input
      let framePeak = 0
      for (let phase = 0; phase < PHASES; phase++) {
        let value = 0
        for (let k = 0; k < TAPS; k++) value += BANKS[phase][k] * delay[k]
        const magnitude = Math.abs(value)
        peak = Math.max(peak, magnitude)
        framePeak = Math.max(framePeak, magnitude)
      }
      if (env && length) {
        // The four fractional positions span n-6.25 through n-5.5. Conservatively
        // associate their largest peak with the adjacent source samples n-7..n-5.
        // Grouping phases avoids eight round/clamp operations per input sample.
        for (let offset = 5; offset <= 7; offset++) {
          const index = Math.max(0, Math.min(length - 1, n - offset))
          env[index] = Math.max(env[index], framePeak)
        }
      }
    }
  }
  return { samplePeak, peak, envelope: env }
}

// Used after the complete optional watermark/limiter chain, before delivery.
export function assertTruePeakCeiling(channels, ceilingDb) {
  const { peak } = scanTruePeak(channels)
  assertMeasuredTruePeak(peak > 0 ? 20 * Math.log10(peak) : -Infinity, ceilingDb)
  return peak
}

// Check an already-measured final report without scanning the same PCM twice.
export function assertMeasuredTruePeak(peakDb, ceilingDb) {
  if (!Number.isFinite(ceilingDb) || !(Number.isFinite(peakDb) || peakDb === -Infinity)) {
    throw new Error('True-Peak 天花板設定或量測無效')
  }
  const ceiling = Math.pow(10, ceilingDb / 20)
  if (!(Number.isFinite(ceiling) && ceiling > 0)) throw new Error('True-Peak 天花板設定無效')
  if (peakDb > ceilingDb + 1e-6) {
    throw new Error(`True-Peak 輸出校驗失敗：4× 估測超過 ${ceilingDb.toFixed(2)} dBTP，未輸出檔案`)
  }
}
