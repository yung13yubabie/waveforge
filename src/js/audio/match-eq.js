// Reference matching: analyse the average magnitude spectrum of a reference
// track and the source, then derive a per-band EQ curve that nudges the source
// toward the reference's tonal balance. Output maps onto the 10-band EQ, so it
// works with the existing EQ knobs, canvas, and linear-phase export.
import { fft } from './fft.js'

function monoMix(channels, len) {
  const n = channels.length
  const out = new Float64Array(len)
  for (let ch = 0; ch < n; ch++) {
    const d = channels[ch]
    for (let i = 0; i < len; i++) out[i] += d[i] / n
  }
  return out
}

/**
 * Average magnitude spectrum aggregated into the given band centres.
 * @param {Float32Array[]} channels
 * @param {number} sr
 * @param {number[]} bandCenters  e.g. EQ band frequencies (Hz)
 * @param {number} fftSize  power of two (default 4096)
 * @param {number} maxFrames  cap analysed frames for long files (default 400)
 * @returns {Float64Array} average magnitude per band
 */
export function averageSpectrum(channels, sr, bandCenters, fftSize = 4096, maxFrames = 400) {
  const len = channels[0]?.length ?? 0
  const mono = monoMix(channels, len)
  const hop = fftSize >> 1

  const totalFrames = Math.max(1, Math.floor((len - fftSize) / hop) + 1)
  const stride = Math.max(1, Math.floor(totalFrames / maxFrames))

  const binMag = new Float64Array(fftSize / 2 + 1)
  let frames = 0
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize)
  for (let f = 0; f * hop + fftSize <= len; f += stride) {
    const start = f * hop
    re.fill(0); im.fill(0)
    for (let i = 0; i < fftSize; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize)  // Hann
      re[i] = mono[start + i] * w
    }
    fft(re, im)
    for (let k = 0; k <= fftSize / 2; k++) binMag[k] += Math.hypot(re[k], im[k])
    frames++
  }
  // Clip shorter than one FFT frame (~85ms @48k) yields no frames — signal
  // that to the caller instead of silently returning an all-zero spectrum.
  if (frames === 0) return null
  for (let k = 0; k < binMag.length; k++) binMag[k] /= frames

  // Aggregate bins into bands (edges = geometric means between centres)
  const edges = []
  for (let i = 0; i < bandCenters.length - 1; i++) {
    edges.push(Math.sqrt(bandCenters[i] * bandCenters[i + 1]))
  }
  const bandMag = new Float64Array(bandCenters.length)
  const bandCnt = new Float64Array(bandCenters.length)
  const binHz = sr / fftSize
  for (let k = 1; k <= fftSize / 2; k++) {
    const hz = k * binHz
    let b = 0
    while (b < edges.length && hz >= edges[b]) b++
    bandMag[b] += binMag[k]
    bandCnt[b]++
  }
  for (let b = 0; b < bandMag.length; b++) if (bandCnt[b] > 0) bandMag[b] /= bandCnt[b]
  return bandMag
}

/**
 * Per-band gain (dB) to move source toward reference's tonal balance.
 * Zero-mean (matches SHAPE, not overall level — loudness is handled separately),
 * clamped to ±maxDb, scaled by strength (0..1).
 */
export function computeMatchCurve(srcBands, refBands, maxDb = 12, strength = 1) {
  const eps = 1e-9
  // Skip bands with negligible energy in either track: the ratio there is just
  // noise and would otherwise clamp to a spurious ±maxDb on near-empty bands.
  const srcFloor = Math.max(...srcBands) * 1e-3
  const refFloor = Math.max(...refBands) * 1e-3
  const valid = srcBands.map((s, i) => s > srcFloor && refBands[i] > refFloor)

  const raw = srcBands.map((s, i) => 20 * Math.log10((refBands[i] + eps) / (s + eps)))
  let sum = 0, n = 0
  raw.forEach((g, i) => { if (valid[i]) { sum += g; n++ } })
  const mean = n > 0 ? sum / n : 0   // zero-mean over MEANINGFUL bands only

  return raw.map((g, i) => {
    if (!valid[i]) return 0
    return Math.max(-maxDb, Math.min(maxDb, (g - mean) * strength))
  })
}
