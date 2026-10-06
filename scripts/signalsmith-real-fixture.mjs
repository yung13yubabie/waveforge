// Run: node scripts/signalsmith-real-fixture.mjs
// Local CC0 fixture + installed ffmpeg only. No model/download/audio upload.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { renderSignalsmithPitch as shiftPitch } from '../src/js/pitch/signalsmith-render.js'
import { rms, peak, centsError } from '../tests/audio/pitch-shift-fixtures.js'

const fixture = fileURLToPath(new URL('../tests/fixtures/lyrics-alignment/cc0-twinkle/first-20s-mono-16k.wav', import.meta.url))
const provenance = JSON.parse(readFileSync(new URL('../tests/fixtures/lyrics-alignment/cc0-twinkle/provenance.json', import.meta.url)))
const hash = createHash('sha256').update(readFileSync(fixture)).digest('hex')
if (hash !== provenance.sha256) throw new Error('CC0 singing fixture hash mismatch')

function convert(sampleRate) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fixture, '-map_metadata', '-1', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Local ffmpeg failed: ${result.stderr?.toString() || result.error}`)
  // Explicit little-endian decode rather than depending on host endianness.
  return Float32Array.from({ length: result.stdout.length / 4 }, (_, i) => result.stdout.readFloatLE(i * 4))
}

// Independent, non-model normalized-square-difference periodicity estimate.
// It is used only as an objective measurement, never as vocal correction gold.
// Independent ffmpeg low-pass resampling prepares 8k measurement PCM; NSDF
// peak interpolation scans a broad 70–700 Hz range.
function forMeasurement(x, sampleRate) {
  const bytes = Buffer.allocUnsafe(x.length * 4)
  for (let i = 0; i < x.length; i++) bytes.writeFloatLE(x[i], i * 4)
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { input: bytes, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`Measurement resampling failed: ${result.stderr?.toString() || result.error}`)
  return Float32Array.from({ length: result.stdout.length / 4 }, (_, i) => result.stdout.readFloatLE(i * 4))
}
function measureF0(x, sampleRate, center) {
  const measureRate = 8000, count = 640
  const frame = new Float64Array(count)
  let mean = 0
  for (let i = 0; i < count; i++) {
    const at = (center - 0.04 + i / measureRate) * sampleRate
    const j = Math.floor(at), fraction = at - j
    frame[i] = (x[j] ?? 0) * (1 - fraction) + (x[j + 1] ?? 0) * fraction
    mean += frame[i] / count
  }
  let energy = 0
  for (let i = 0; i < count; i++) { frame[i] -= mean; energy += frame[i] ** 2 }
  const frameRms = Math.sqrt(energy / count)
  const minimum = Math.floor(measureRate / 700), maximum = Math.ceil(measureRate / 70)
  const nsdf = new Float64Array(maximum + 2)
  let negativeSeen = false
  const maxima = []
  for (let lag = 0; lag <= maximum + 1; lag++) {
    let dot = 0, denominator = 0
    for (let i = 0; i < count - lag; i++) {
      dot += frame[i] * frame[i + lag]
      denominator += frame[i] ** 2 + frame[i + lag] ** 2
    }
    nsdf[lag] = 2 * dot / (denominator + 1e-30)
    if (nsdf[lag] < 0) negativeSeen = true
    const previous = lag - 1
    if (negativeSeen && previous >= minimum && previous <= maximum && nsdf[previous] > 0
      && nsdf[previous] > nsdf[previous - 1] && nsdf[previous] >= nsdf[lag]) maxima.push(previous)
  }
  if (!maxima.length) return { frequency: 0, confidence: 0, rms: frameRms }
  const strongest = Math.max(...maxima.map(index => nsdf[index]))
  const lag = maxima.find(index => nsdf[index] >= strongest * 0.93)
  const offset = 0.5 * (nsdf[lag - 1] - nsdf[lag + 1]) / (nsdf[lag - 1] - 2 * nsdf[lag] + nsdf[lag + 1])
  return { frequency: measureRate / (lag + offset), confidence: nsdf[lag], rms: frameRms }
}

function quantile(values, fraction) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) * fraction)]
}

// Compare 5ms amplitude-envelope bins. Real recording has no annotated gold
// transients, so the lag/error is descriptive, not an attack-preservation pass.
function envelopes(x, sampleRate) {
  const block = Math.round(sampleRate * 0.005), envelope = []
  for (let i = 0; i + block <= x.length; i += block) envelope.push(rms(x, i, i + block))
  return envelope
}
function envelopeMetrics(a, b) {
  let bestLag = 0, bestCorrelation = -1
  for (let lag = -6; lag <= 6; lag++) {
    let dot = 0, aa = 0, bb = 0
    for (let i = 6; i < a.length - 6; i++) { dot += a[i] * b[i + lag]; aa += a[i] ** 2; bb += b[i + lag] ** 2 }
    const correlation = dot / Math.sqrt(aa * bb)
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag }
  }
  let squaredError = 0, referenceEnergy = 0
  const risingChangeRatios = []
  const rises = a.slice(1).map((value, i) => value - a[i])
  const threshold = quantile(rises.filter(value => value > 0), 0.9)
  for (let i = 0; i < a.length; i++) {
    squaredError += (b[i] - a[i]) ** 2; referenceEnergy += a[i] ** 2
    if (i > 0 && a[i] - a[i - 1] >= threshold) risingChangeRatios.push((b[i] - b[i - 1]) / (a[i] - a[i - 1]))
  }
  return { bestLagMs: bestLag * 5, bestCosineSimilarity: bestCorrelation, sameTimeNormalizedRmsError: Math.sqrt(squaredError / referenceEnergy), medianStrongRiseRatio: quantile(risingChangeRatios, 0.5), strongRiseP10Ratio: quantile(risingChangeRatios, 0.1) }
}

const report = {
  generatedAt: new Date().toISOString(), fixture: 'CC0 Twinkle first20s, original derivative16k mono', fixtureSha256: hash,
  caveats: ['No perceptual listening', 'Upsampling does not restore above-8k source bandwidth', 'F0 estimates are not human-annotated gold', 'Stereo here is duplicated/scaled mono, not real stereo recording'],
  sampleFilter: 'All 0.12s-spaced centers; paired NSDF confidence≥0.92 and RMS≥0.01, with no rejection based on measured error. Stable subset additionally needs source F0 within25cents at±0.04s.', results: [],
}
for (const sr of [44100, 48000]) {
  const input = convert(sr)
  if (input.length !== sr * 20) throw new Error('Converted fixture duration changed')
  const centers = Array.from({ length: 164 }, (_, i) => 0.16 + i * 0.12)
  const measurementInput = forMeasurement(input, sr)
  const baseline = centers.map(center => measureF0(measurementInput, 8000, center))
  const stable = centers.map((center, i) => {
    const side = [-0.04, 0.04].map(delta => measureF0(measurementInput, 8000, center + delta))
    return side.every(value => value.confidence >= 0.92 && Math.abs(centsError(value.frequency, baseline[i].frequency)) < 25)
  })
  const beforeEnvelope = envelopes(input, sr)
  for (const semitones of [-2, -1, 1, 2]) {
    const started = performance.now()
    const result = await shiftPitch([input, input.map(value => -0.5 * value)], sr, { semitones, yieldControl: async () => {} })
    const output = result.channels[0], measurementOutput = forMeasurement(output, sr)
    const shifted = centers.map(center => measureF0(measurementOutput, 8000, center))
    const errors = [], stableErrors = []
    for (let i = 0; i < centers.length; i++) {
      if (baseline[i].confidence < 0.92 || shifted[i].confidence < 0.92 || baseline[i].rms < 0.01 || shifted[i].rms < 0.01) continue
      const error = centsError(shifted[i].frequency, baseline[i].frequency * 2 ** (semitones / 12))
      errors.push(error)
      if (stable[i]) stableErrors.push(error)
    }
    let finite = true, stereoExact = true, stereoMaxAbsError = 0, stereoDifferentSamples = 0
    for (let i = 0; i < output.length; i++) {
      finite &&= Number.isFinite(output[i]) && Number.isFinite(result.channels[1][i])
      stereoExact &&= result.channels[1][i] === output[i] * -0.5
      const error = Math.abs(result.channels[1][i] - output[i] * -0.5)
      stereoMaxAbsError = Math.max(stereoMaxAbsError, error)
      if (error !== 0) stereoDifferentSamples++
    }
    const stats = values => ({ count: values.length, medianCents: quantile(values, 0.5), p95AbsCents: quantile(values.map(Math.abs), 0.95), maxAbsCents: values.length ? Math.max(...values.map(Math.abs)) : null, fractionOver50Cents: values.filter(value => Math.abs(value) > 50).length / Math.max(1, values.length) })
    report.results.push({ sr, semitones, durationSeconds: output.length / sr, sampleCount: output.length, finite, stereoExact, stereoMaxAbsError, stereoDifferentSamples, stereoLinkedWithin1eMinus7: stereoMaxAbsError < 1e-7, outputPeak: peak(output), outputGain: result.metadata.outputGain, rmsDb: 20 * Math.log10(rms(output) / rms(input)), pairedVoiced: stats(errors), stableVoiced: stats(stableErrors), envelope: envelopeMetrics(beforeEnvelope, envelopes(output, sr)), wallMillisecondsIncludingMeasurements: performance.now() - started })
  }
}
console.log(JSON.stringify(report, null, 2))
