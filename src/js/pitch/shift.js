import { fft, nextPow2 } from '../audio/fft.js'

// INTERNAL RESEARCH ONLY. Do not import this module from shipping application
// code or enable preview/export controls. Known transient/boundary and stereo
// failures are documented below; unit-test success does not open this gate.
// Experimental offline DSP, deliberately not connected to the editor. The
// time-scale stage changes duration without changing pitch; the band-limited
// resampling stage changes pitch and restores the exact input sample count.
// Original implementation; technical references and quality limits are in
// docs/validation/PITCH_SHIFT_DSP_LIMITS.md.
export const PITCH_SHIFT_LIMITS = Object.freeze({
  maxSemitones: 2,
  maxDurationSeconds: 30,
  maxChannels: 2,
  sampleRates: Object.freeze([44100, 48000, 96000]),
  maxInputPeak: 8,
  outputPeakCeiling: 0.999,
  experimental: true,
  releaseReadiness: 'internal-only',
})

const TAU = 2 * Math.PI
const RESAMPLE_RADIUS = 24
const RESAMPLE_PHASES = 1024
const BLOCK = 16384
const wrap = angle => angle - TAU * Math.round(angle / TAU)
const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0))

function abortIfNeeded(signal) {
  if (!signal?.aborted) return
  const error = new Error('Pitch shift cancelled')
  error.name = 'AbortError'
  throw error
}

function validate(channels, sampleRate, options) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) {
    throw new RangeError('Pitch shift requires one or two channels')
  }
  if (!PITCH_SHIFT_LIMITS.sampleRates.includes(sampleRate)) {
    throw new RangeError('Pitch shift supports 44100, 48000, or 96000 Hz')
  }
  const length = channels[0]?.length
  if (channels.some(channel => !(channel instanceof Float32Array) || channel.length !== length)) {
    throw new TypeError('Pitch shift requires equal-length Float32Array channels')
  }
  const { semitones = 0, cents = 0, yieldControl = defaultYield, onProgress } = options
  if (!Number.isFinite(semitones) || !Number.isFinite(cents)) {
    throw new TypeError('Pitch amount must be finite')
  }
  const amount = semitones + cents / 100
  if (Math.abs(amount) > PITCH_SHIFT_LIMITS.maxSemitones) {
    throw new RangeError('Pitch shift is limited to ±2 semitones (±200 cents) total')
  }
  if (length > sampleRate * PITCH_SHIFT_LIMITS.maxDurationSeconds) {
    throw new RangeError('Pitch shift is limited to 30 seconds')
  }
  if (typeof yieldControl !== 'function' || (onProgress != null && typeof onProgress !== 'function')) {
    throw new TypeError('Pitch callbacks must be functions')
  }
  const fftSize = nextPow2(sampleRate * 0.04)
  if (amount !== 0 && length > 0 && length < fftSize * 2) {
    throw new RangeError(`Nonzero pitch shift requires at least ${fftSize * 2} samples`)
  }
  return { length, amount, fftSize, yieldControl, onProgress }
}

// A finite, low-pass windowed-sinc kernel. Table interpolation avoids evaluating
// trigonometric functions per audio sample. The same kernel is used for both
// channels. The passband margin trades some top-octave loss for alias rejection.
function makeResamplingTable(ratio) {
  const taps = RESAMPLE_RADIUS * 2
  const table = new Float64Array((RESAMPLE_PHASES + 1) * taps)
  const cutoff = 0.94 / Math.max(1, ratio)
  for (let p = 0; p <= RESAMPLE_PHASES; p++) {
    const fraction = p / RESAMPLE_PHASES
    let sum = 0
    for (let tap = 0; tap < taps; tap++) {
      const distance = tap - RESAMPLE_RADIUS + 1 - fraction
      const x = Math.PI * cutoff * distance
      const sinc = Math.abs(x) < 1e-12 ? cutoff : cutoff * Math.sin(x) / x
      const window = 0.42 + 0.5 * Math.cos(Math.PI * distance / RESAMPLE_RADIUS)
        + 0.08 * Math.cos(TAU * distance / RESAMPLE_RADIUS)
      const value = sinc * window
      table[p * taps + tap] = value
      sum += value
    }
    for (let tap = 0; tap < taps; tap++) table[p * taps + tap] /= sum
  }
  return table
}

/**
 * Genuine fixed-duration, constant pitch shift for a bounded selected clip.
 * Input is borrowed read-only and must remain unchanged until the promise ends.
 * Output owns fresh Float32Array channels. Zero amount is a bit-exact copy,
 * including signed zero; empty input is a no-op for any supported amount.
 *
 * `yieldControl` may be supplied by a worker wrapper; its default yields to the
 * event loop. Cancellation is checked between FFT frames and sample blocks.
 * Progress is monotonically increasing in [0, 1], and 1 means success only.
 * Rejecting/aborting never mutates input or returns a partially processed clip.
 * `metadata.outputGain` is a shared attenuation if output sample peaks exceeded
 * 0.999. It is NOT true-peak limiting. Zero bypass never changes headroom.
 */
export async function shiftPitch(channels, sampleRate, options = {}) {
  const { length, amount, fftSize, yieldControl, onProgress } = validate(channels, sampleRate, options)
  const { signal } = options
  const checkpoint = async progress => {
    abortIfNeeded(signal)
    onProgress?.(progress)
    await yieldControl()
    abortIfNeeded(signal)
  }
  abortIfNeeded(signal)
  const output = channels.map(() => new Float32Array(length))
  // Scan before DSP and copy only into private output. Work is bounded even for
  // invalid long inputs, and callers can cancel the validation/bypass phase.
  for (let start = 0; start < length; start += BLOCK) {
    const end = Math.min(length, start + BLOCK)
    for (let ch = 0; ch < channels.length; ch++) {
      for (let i = start; i < end; i++) {
        const value = channels[ch][i]
        if (!Number.isFinite(value) || Math.abs(value) > PITCH_SHIFT_LIMITS.maxInputPeak) {
          throw new RangeError('Pitch input must be finite with absolute samples ≤8')
        }
        output[ch][i] = value
      }
    }
    if (start % (BLOCK * 4) === 0) await checkpoint(0.04 * end / Math.max(1, length))
  }
  const ratio = 2 ** (amount / 12)
  const baseMetadata = {
    algorithm: 'linked-phase-vocoder-windowed-sinc-v1',
    experimental: true, releaseReadiness: 'internal-only', semitones: amount, ratio, inputSamples: length,
    outputSamples: length, fftSize, hopSize: fftSize / 4,
    windowSeconds: fftSize / sampleRate, formantPreserved: false,
  }
  if (amount === 0 || length === 0) {
    abortIfNeeded(signal)
    onProgress?.(1)
    return { channels: output, sampleRate, metadata: { ...baseMetadata, bypassed: true, outputGain: 1 } }
  }

  const half = fftSize / 2
  const bins = half + 1
  const hop = fftSize / 4
  // Padding is retained through resampling so the sinc filter never reads an
  // artificially cropped time-stretch boundary at t=0 or at the clip end.
  const padding = fftSize
  const stretchedLength = Math.ceil((length - 1) * ratio) + 1
  const storageLength = stretchedLength + 2 * padding
  const stretched = channels.map(() => new Float64Array(storageLength))
  const re = channels.map(() => new Float64Array(fftSize))
  const im = channels.map(() => new Float64Array(fftSize))
  const previousRe = channels.map(() => new Float64Array(bins))
  const previousIm = channels.map(() => new Float64Array(bins))
  const power = new Float64Array(bins)
  const previousPower = new Float64Array(bins)
  const correction = new Float64Array(bins)
  const nextCorrection = new Float64Array(bins)
  const peakForBin = new Int32Array(bins)
  const peaks = new Int32Array(bins)
  const window = Float64Array.from({ length: fftSize }, (_, i) => 0.5 - 0.5 * Math.cos(TAU * i / fftSize))
  const firstCenter = -padding - half
  const frameCount = Math.ceil((stretchedLength + 2 * padding + fftSize) / hop) + 1
  let previousCenter = null
  for (let frame = 0; frame < frameCount; frame++) {
    abortIfNeeded(signal)
    const synthesisCenter = firstCenter + frame * hop
    const analysisCenter = Math.round(synthesisCenter / ratio)
    const analysisHop = previousCenter === null ? hop / ratio : analysisCenter - previousCenter
    power.fill(0)
    for (let ch = 0; ch < channels.length; ch++) {
      for (let i = 0; i < fftSize; i++) {
        const index = analysisCenter + i - half
        re[ch][i] = index >= 0 && index < length ? channels[ch][index] * window[i] : 0
        im[ch][i] = 0
      }
      fft(re[ch], im[ch])
      for (let k = 0; k < bins; k++) power[k] += re[ch][k] ** 2 + im[ch][k] ** 2
    }

    for (let k = 0; k < bins; k++) {
      let crossRe = 0, crossIm = 0
      for (let ch = 0; ch < channels.length; ch++) {
        const r = re[ch][k], j = im[ch][k]
        crossRe += r * previousRe[ch][k] + j * previousIm[ch][k]
        crossIm += j * previousRe[ch][k] - r * previousIm[ch][k]
        previousRe[ch][k] = r
        previousIm[ch][k] = j
      }
      const centerOmega = TAU * k / fftSize
      const delta = Math.atan2(crossIm, crossRe)
      const omega = centerOmega + wrap(delta - centerOmega * analysisHop) / analysisHop
      // Sum channel cross-spectra rather than downmix audio: antiphase stereo
      // remains measurable. A single shared phase rotation retains the current
      // interchannel phase difference, including polarity inversion.
      nextCorrection[k] = previousCenter === null || previousPower[k] < 1e-18
        ? 0 : wrap(correction[k] + omega * (hop - analysisHop))
    }

    // Shared magnitude peaks and identity phase locking. Use each peak's
    // correction throughout its nearest-bin region of influence. Previous
    // corrections were also locked, reducing jumps when a peak changes bin.
    let peakCount = 0
    peaks[peakCount++] = 0
    for (let k = 1; k < half; k++) {
      if (power[k] > power[k - 1] && power[k] >= power[k + 1]) peaks[peakCount++] = k
    }
    peaks[peakCount++] = half
    let region = 0
    for (let k = 0; k < bins; k++) {
      while (region + 1 < peakCount && k > (peaks[region] + peaks[region + 1]) / 2) region++
      peakForBin[k] = peaks[region]
    }
    for (let k = 0; k < bins; k++) correction[k] = nextCorrection[peakForBin[k]]
    for (let ch = 0; ch < channels.length; ch++) {
      for (let k = 1; k < half; k++) {
        const c = Math.cos(correction[k]), s = Math.sin(correction[k])
        const r = re[ch][k], j = im[ch][k]
        re[ch][k] = r * c - j * s
        im[ch][k] = r * s + j * c
        re[ch][fftSize - k] = re[ch][k]
        im[ch][fftSize - k] = -im[ch][k]
      }
      // DC/Nyquist must remain real for a real-valued inverse transform.
      im[ch][0] = 0
      im[ch][half] = 0
      fft(re[ch], im[ch], true)
      for (let i = 0; i < fftSize; i++) {
        const index = synthesisCenter + i - half + padding
        if (index >= 0 && index < storageLength) {
          // Periodic Hann, H=N/4: overlapping window squares sum to 1.5.
          stretched[ch][index] += re[ch][i] * window[i] / 1.5
        }
      }
    }
    previousPower.set(power)
    previousCenter = analysisCenter
    if (frame % 8 === 0) await checkpoint(0.04 + 0.60 * (frame + 1) / frameCount)
  }

  const table = makeResamplingTable(ratio)
  const taps = RESAMPLE_RADIUS * 2
  let outputPeak = 0
  for (let start = 0; start < length; start += BLOCK) {
    const end = Math.min(length, start + BLOCK)
    for (let i = start; i < end; i++) {
      const position = i * ratio + padding
      const integer = Math.floor(position)
      const phase = (position - integer) * RESAMPLE_PHASES
      const phaseIndex = Math.floor(phase)
      const mix = phase - phaseIndex
      const offset = phaseIndex * taps
      for (let ch = 0; ch < channels.length; ch++) {
        let sum = 0
        for (let tap = 0; tap < taps; tap++) {
          const a = table[offset + tap]
          const b = table[offset + taps + tap]
          sum += stretched[ch][integer - RESAMPLE_RADIUS + 1 + tap] * (a + mix * (b - a))
        }
        if (!Number.isFinite(sum)) throw new Error('Pitch processing produced non-finite audio')
        output[ch][i] = sum
        outputPeak = Math.max(outputPeak, Math.abs(output[ch][i]))
      }
    }
    await checkpoint(0.64 + 0.30 * end / length)
  }
  const outputGain = outputPeak > PITCH_SHIFT_LIMITS.outputPeakCeiling
    ? PITCH_SHIFT_LIMITS.outputPeakCeiling / outputPeak : 1
  for (let start = 0; start < length; start += BLOCK) {
    const end = Math.min(length, start + BLOCK)
    if (outputGain < 1) {
      for (const channel of output) for (let i = start; i < end; i++) channel[i] *= outputGain
    }
    if (start % (BLOCK * 4) === 0) await checkpoint(0.94 + 0.059 * end / length)
  }
  abortIfNeeded(signal)
  onProgress?.(1)
  return { channels: output, sampleRate, metadata: { ...baseMetadata, bypassed: false, outputGain } }
}
