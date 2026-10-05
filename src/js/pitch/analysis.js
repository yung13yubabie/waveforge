/**
 * Original, dependency-free, conservative monophonic F0 estimator.
 * Algorithm reference: de Cheveigné & Kawahara, JASA 111 (2002),
 * https://doi.org/10.1121/1.1458024 (YIN's difference, cumulative normalization,
 * first threshold minimum, and parabolic refinement). This is not a copy of an
 * implementation or a complete reproduction of the paper's temporal search.
 *
 * `voiced` means a sufficiently periodic frame, NOT identification of a voice.
 * Confidence is 1 - normalized difference, not a calibrated probability.
 * No source separation, polyphonic transcription, key, or correctness judgement.
 */
export const PITCH_ANALYSIS_INFO = Object.freeze({
  engine: 'waveforge-monophonic-yin', version: 1, maxDuration: 60,
  minFrequencyHz: 50, maxFrequencyHz: 1200,
  frameDuration: 0.064, hopDuration: 0.02,
  limitations: Object.freeze([
    'For one isolated voice or monophonic instrument; overlapping notes and accompaniment can produce misleading estimates.',
    'Voiced means periodic audio, not a detected human voice. Confidence is a periodicity score, not a probability.',
    'Octave errors, vibrato, consonants, fast transitions, reverb and noise remain possible. Gaps are intentionally left unknown.',
    'Estimates near the 50–1200 Hz range limits can be left unknown rather than clamped to a boundary.',
    'Nearest equal-tempered note (A4 = 440 Hz) is a reference, not a judgement of whether a performance is musically correct.',
    'Synthetic tests verify known-signal behavior; real-singing accuracy has not been calibrated.',
  ]),
})

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
export const frequencyToMidi = frequencyHz => Number.isFinite(frequencyHz) && frequencyHz > 0 ? 69 + 12 * (Math.log2(frequencyHz) - Math.log2(440)) : null
export const midiToFrequency = midi => Number.isFinite(midi) && midi >= -128 && midi <= 255 ? 440 * 2 ** ((midi - 69) / 12) : null
export function midiToNote(midi) {
  if (!Number.isFinite(midi)) return null
  const rounded = Math.round(midi)
  return `${NOTES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`
}
/** cents is relative to the nearest note; referenceCents is optional and signed. */
export function describePitch(frequencyHz, referenceMidi = null) {
  const midi = frequencyToMidi(frequencyHz)
  if (midi === null) return { frequencyHz: null, midi: null, note: null, cents: null, referenceCents: null }
  return {
    frequencyHz, midi, note: midiToNote(midi), cents: 100 * (midi - Math.round(midi)),
    referenceCents: Number.isFinite(referenceMidi) ? 100 * (midi - referenceMidi) : null,
  }
}

export function pitchAbortError(message = 'Pitch analysis cancelled') {
  return Object.assign(new Error(message), { name: 'AbortError' })
}
const yieldThread = () => new Promise(resolve => setTimeout(resolve, 0))
const checkAbort = signal => { if (signal?.aborted) throw pitchAbortError() }
const notify = (callback, progress) => { try { callback?.(progress) } catch { /* A UI observer cannot stop analysis/cancellation. */ } }

/** Validate an already selected, mono PCM window before allocating DSP memory. */
export function validatePitchInput(samples, sampleRate, { start = 0 } = {}) {
  if (!(samples instanceof Float32Array)) throw new TypeError('Pitch analysis requires Float32Array PCM')
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Pitch analysis sample rate must be 8000–192000 Hz')
  if (!Number.isFinite(start) || start < 0) throw new RangeError('Pitch analysis start must be a non-negative finite number')
  if (samples.length > Math.floor(sampleRate * PITCH_ANALYSIS_INFO.maxDuration)) throw new RangeError('Select no more than 60 seconds for pitch analysis')
  return samples.length / sampleRate
}

/**
 * Integer decimation uses its actual resulting rate (44.1k -> 11025, not 12000).
 * A symmetric windowed-sinc FIR is evaluated at retained samples, so it introduces
 * no timestamp shift. Stopband suppression avoids simply aliasing high harmonics.
 * Input samples are never changed. The analysis PCM is < 4.32 MB for a 60-second window at supported rates.
 */
async function prepareSamples(samples, sampleRate, signal, onProgress) {
  const factor = Math.max(1, Math.round(sampleRate / 12000))
  const rate = sampleRate / factor
  const output = new Float32Array(Math.ceil(samples.length / factor))
  const radius = 12 * factor
  const cutoff = Math.min(3000, rate * 0.35) / sampleRate
  const kernel = new Float64Array(radius * 2 + 1)
  let sum = 0
  for (let k = -radius; k <= radius; k++) {
    const sinc = k === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * k) / (Math.PI * k)
    const weight = 0.42 + 0.5 * Math.cos(Math.PI * k / radius) + 0.08 * Math.cos(2 * Math.PI * k / radius)
    kernel[k + radius] = sinc * weight
    sum += kernel[k + radius]
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum
  // Validate every source sample, including ones omitted by decimation.
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new TypeError('Pitch PCM contains a non-finite sample')
    if (i % 262144 === 0) { checkAbort(signal); await yieldThread() }
  }
  for (let i = 0; i < output.length; i++) {
    const center = i * factor
    let value = 0
    for (let tap = 0; tap < kernel.length; tap++) {
      const index = center + tap - radius
      if (index >= 0 && index < samples.length) value += samples[index] * kernel[tap]
    }
    output[i] = value
    if (i % 16384 === 0) {
      checkAbort(signal)
      notify(onProgress, { phase: 'preparing', progress: output.length ? 0.2 * i / output.length : 0 })
      await yieldThread()
    }
  }
  return { samples: output, sampleRate: rate }
}

const unknown = (time, state, confidence, rms, reason) => ({
  time, state, frequencyHz: null, midi: null, note: null, cents: null,
  referenceCents: null, confidence, rms, reason,
})

function estimateFrame(samples, offset, length, sampleRate, time, difference, rawDifference) {
  let total = 0
  for (let i = 0; i < length; i++) total += samples[offset + i]
  const mean = total / length
  let power = 0
  let peak = 0
  const blockPower = [0, 0, 0, 0]
  for (let i = 0; i < length; i++) {
    const value = samples[offset + i] - mean
    const squared = value * value
    power += squared
    peak = Math.max(peak, Math.abs(value))
    blockPower[Math.min(3, Math.floor(i * 4 / length))] += squared
  }
  const rms = Math.sqrt(power / length)
  if (rms < 0.001) return unknown(time, 'unvoiced', 0, rms, 'below-level')
  // Isolated impulses and very uneven onset/offset frames are not stable notes.
  const minBlock = Math.min(...blockPower)
  const maxBlock = Math.max(...blockPower)
  if (peak / rms > 8 || minBlock < maxBlock * 0.025) return unknown(time, 'uncertain', 0, rms, 'transient')

  const maxLag = Math.ceil(sampleRate / PITCH_ANALYSIS_INFO.minFrequencyHz)
  const window = length - maxLag - 2
  let running = 0
  difference[0] = 1
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let energy = 0
    // Keep each comparison centered in the same frame, including on a glide.
    const begin = offset + Math.floor((maxLag + 1 - lag) / 2)
    for (let i = 0; i < window; i++) {
      const delta = samples[begin + i] - samples[begin + i + lag]
      energy += delta * delta
    }
    rawDifference[lag] = energy
    running += energy
    difference[lag] = running > 0 ? energy * lag / running : 1
  }
  let candidate = -1
  let best = 1
  // Search shorter lags too, so a strong out-of-range high tone is not simply
  // relabelled as an in-range subharmonic. This cannot eliminate all octave errors.
  for (let lag = 2; lag <= maxLag; lag++) {
    best = Math.min(best, difference[lag])
    if (difference[lag] < 0.1 && difference[lag] <= difference[lag - 1] && difference[lag] < difference[lag + 1]) {
      candidate = lag
      break
    }
  }
  if (candidate < 0) return unknown(time, best < 0.3 ? 'uncertain' : 'unvoiced', Math.max(0, 1 - best), rms, 'low-periodicity')
  // Refine the raw difference minimum; normalizing it introduces a lag bias.
  const left = rawDifference[candidate - 1]
  const center = rawDifference[candidate]
  const right = rawDifference[candidate + 1]
  const curve = left - 2 * center + right
  const refinement = curve > 0 ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curve))) : 0
  const frequencyHz = sampleRate / (candidate + refinement)
  const confidence = Math.max(0, Math.min(1, 1 - difference[candidate]))
  if (frequencyHz < PITCH_ANALYSIS_INFO.minFrequencyHz || frequencyHz > PITCH_ANALYSIS_INFO.maxFrequencyHz) {
    return unknown(time, 'uncertain', confidence, rms, 'outside-range')
  }
  return { time, state: 'voiced', ...describePitch(frequencyHz), confidence, rms, reason: null }
}

/**
 * Analyze one isolated mono PCM window, asynchronously yielding between bounded
 * batches. options.start is the absolute source-buffer origin, not a crop command.
 * Returns source-time centered frames; uncertain/unvoiced frames have null pitch.
 * The client below performs selection and worker isolation for browser use.
 */
export async function analyzePitch(samples, sampleRate, { start = 0, signal, onProgress } = {}) {
  const duration = validatePitchInput(samples, sampleRate, { start })
  checkAbort(signal)
  const prepared = await prepareSamples(samples, sampleRate, signal, onProgress)
  const rate = prepared.sampleRate
  const length = Math.round(PITCH_ANALYSIS_INFO.frameDuration * rate)
  const hop = Math.round(PITCH_ANALYSIS_INFO.hopDuration * rate)
  const frameCount = Math.max(0, Math.floor((prepared.samples.length - length) / hop) + 1)
  const difference = new Float64Array(Math.ceil(rate / PITCH_ANALYSIS_INFO.minFrequencyHz) + 2)
  const rawDifference = new Float64Array(difference.length)
  const frames = []
  for (let frame = 0; frame < frameCount; frame++) {
    checkAbort(signal)
    const offset = frame * hop
    frames.push(estimateFrame(prepared.samples, offset, length, rate, start + (offset + length / 2) / rate, difference, rawDifference))
    if (frame % 16 === 0) {
      notify(onProgress, { phase: 'analyzing', progress: 0.2 + 0.8 * (frame + 1) / frameCount })
      await yieldThread()
    }
  }
  // A lone periodic frame surrounded by unknown audio is not a robust contour.
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]
    if (frame.state === 'voiced' && frames.length > 1 && frames[i - 1]?.state !== 'voiced' && frames[i + 1]?.state !== 'voiced') {
      frames[i] = unknown(frame.time, 'uncertain', frame.confidence, frame.rms, 'isolated-estimate')
    }
  }
  checkAbort(signal)
  const voiced = frames.filter(frame => frame.state === 'voiced')
  const sortedMidi = voiced.map(frame => frame.midi).sort((a, b) => a - b)
  const mid = Math.floor(sortedMidi.length / 2)
  const medianMidi = sortedMidi.length ? (sortedMidi[mid] + sortedMidi[Math.floor((sortedMidi.length - 1) / 2)]) / 2 : null
  const result = {
    engine: PITCH_ANALYSIS_INFO.engine, version: PITCH_ANALYSIS_INFO.version,
    sampleRate, analysisSampleRate: rate, start, duration, frameDuration: length / rate,
    hopDuration: hop / rate, timestampOrigin: 'source-buffer', frames,
    summary: {
      frameCount, voicedFrames: voiced.length,
      uncertainFrames: frames.filter(frame => frame.state === 'uncertain').length,
      unvoicedFrames: frames.filter(frame => frame.state === 'unvoiced').length,
      voicedFraction: frameCount ? voiced.length / frameCount : 0,
      medianMidi, medianFrequencyHz: medianMidi === null ? null : midiToFrequency(medianMidi),
      reason: frameCount ? (voiced.length ? null : 'no-reliable-pitch') : 'too-short',
    },
    limitations: [...PITCH_ANALYSIS_INFO.limitations],
  }
  notify(onProgress, { phase: 'complete', progress: 1 })
  return result
}
