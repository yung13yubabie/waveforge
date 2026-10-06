// Bounded, local-only Signalsmith integration candidate. The wrapper's scheduling
// API is intentionally not used. No playback-rate shortcut or endpoint patch.

export const SIGNALSMITH_LIMITS = Object.freeze({
  engine: 'signalsmith-stretch-1.3.2', maxSemitones: 2, maxFormantSemitones: 2,
  maxDurationSeconds: 30, maxChannels: 2, maxInputPeak: 8,
  sampleRates: Object.freeze([44100, 48000, 96000]),
  releaseReadiness: 'integration-candidate', perceptuallyValidated: false,
})
const CHUNK = 2048
const SCAN_CHUNK = 16384
const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0))
export function signalsmithAbortError(message = 'Pitch render cancelled') {
  return Object.assign(new Error(message), { name: 'AbortError' })
}
function checkAbort(signal) { if (signal?.aborted) throw signalsmithAbortError() }

// Shape validation is cheap and happens before any allocation or worker copy.
export function validateSignalsmithInput(channels, sampleRate, options = {}) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 2) throw new RangeError('Pitch render requires one or two channels')
  if (!SIGNALSMITH_LIMITS.sampleRates.includes(sampleRate)) throw new RangeError('Pitch render supports 44100, 48000, or 96000 Hz')
  if (options.signal != null && (typeof options.signal.aborted !== 'boolean' || typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal')
  const length = channels[0]?.length
  for (let c = 0; c < channels.length; c++) {
    const x = channels[c]
    if (!(x instanceof Float32Array) || x.length !== length || (x.buffer.byteLength === 0 && x.length !== 0)) throw new TypeError('Pitch render requires equal-length Float32Array channels')
  }
  if (channels.some(x => typeof SharedArrayBuffer !== 'undefined' && x.buffer instanceof SharedArrayBuffer)) throw new TypeError('Shared audio buffers are not supported')
  if (length > sampleRate * SIGNALSMITH_LIMITS.maxDurationSeconds) throw new RangeError('Pitch render is limited to 30 seconds')
  const { semitones = 0, cents = 0, formantSemitones = 0, formantCompensation = false, formantBaseHz = 0 } = options
  if (![semitones, cents, formantSemitones, formantBaseHz].every(Number.isFinite)) throw new TypeError('Pitch and formant controls must be finite')
  const amount = semitones + cents / 100
  if (Math.abs(amount) > 2) throw new RangeError('Pitch render is limited to ±2 semitones total')
  if (Math.abs(formantSemitones) > 2) throw new RangeError('Formant shift is limited to ±2 semitones')
  if (typeof formantCompensation !== 'boolean') throw new TypeError('Formant compensation must be a boolean')
  if (formantBaseHz !== 0 && (formantBaseHz < 50 || formantBaseHz > 1000)) throw new RangeError('Formant base must be 0 (automatic) or 50–1000 Hz')
  const bypassed = amount === 0 && formantSemitones === 0
  if (!bypassed && length > 0 && length < Math.ceil(sampleRate * 0.12)) throw new RangeError('Nonzero pitch/formant render requires at least 120 ms')
  if (options.yieldControl != null && typeof options.yieldControl !== 'function') throw new TypeError('yieldControl must be a function')
  if (options.onProgress != null && typeof options.onProgress !== 'function') throw new TypeError('onProgress must be a function')
  return { length, amount, formantSemitones, formantCompensation, formantBaseHz, bypassed }
}

/**
 * Constant independent pitch/formant render, exact length/rate, fresh output.
 * Input is borrowed read-only until settlement. No normalization/clipping is
 * performed: metadata reports sample peaks; caller's export safety still applies.
 * Use the dedicated client in browser UI. This pure path also runs in Node tests.
 */
export async function renderSignalsmithPitch(channels, sampleRate, options = {}) {
  const settings = validateSignalsmithInput(channels, sampleRate, options)
  const { length, amount, formantSemitones, formantCompensation, formantBaseHz, bypassed } = settings
  const { signal, onProgress, yieldControl = defaultYield } = options
  const notify = value => { try { onProgress?.(value) } catch { /* observer only */ } }
  const progress = value => { checkAbort(signal); notify(value); checkAbort(signal) }
  const checkpoint = async value => { progress(value); await yieldControl(); checkAbort(signal) }
  checkAbort(signal)
  const output = channels.map(() => new Float32Array(length))
  let inputPeak = 0
  for (let at = 0; at < length; at += SCAN_CHUNK) {
    const end = Math.min(length, at + SCAN_CHUNK)
    for (let c = 0; c < channels.length; c++) {
      for (let i = at; i < end; i++) {
        const x = channels[c][i]
        if (!Number.isFinite(x) || Math.abs(x) > 8) throw new RangeError('Pitch input must be finite with absolute samples ≤8')
        inputPeak = Math.max(inputPeak, Math.abs(x))
        if (bypassed) output[c][i] = x
      }
    }
    if (at % (SCAN_CHUNK * 4) === 0) await checkpoint(0.08 * end / length)
  }
  const metadata = {
    ...SIGNALSMITH_LIMITS, semitones: amount, ratio: 2 ** (amount / 12),
    formantSemitones, formantCompensation, formantBaseHz,
    formantPreservationClaimed: false, inputSamples: length, outputSamples: length,
    bypassed: bypassed || length === 0, inputPeak, outputGain: 1,
    timeRatio: 1, boundaryPolicy: 'zero-context-full-latency-drain',
  }
  if (bypassed || length === 0) {
    checkAbort(signal)
    notify(1)
    return { channels: output, sampleRate, metadata: { ...metadata, outputPeak: inputPeak, inputLatency: 0, outputLatency: 0, wasmMemoryBytes: 0 } }
  }
  await checkpoint(0.08)
  // A fresh instance owns its C++ globals. No shared mutable DSP state or audio
  // retained across jobs. The module and WASM have no external data requests.
  const { createSignalsmithModule } = await import('./vendor/signalsmith-stretch/SignalsmithStretch.mjs')
  checkAbort(signal)
  const wasm = await createSignalsmithModule()
  checkAbort(signal)
  wasm._presetDefault(channels.length, sampleRate)
  wasm._reset()
  wasm._setTransposeSemitones(amount, 0) // Linear pitch map; no tonality warp.
  wasm._setFormantSemitones(formantSemitones, formantCompensation)
  wasm._setFormantBase(formantBaseHz / sampleRate)
  const inputLatency = wasm._inputLatency(), outputLatency = wasm._outputLatency()
  const blockSamples = wasm._blockSamples(), intervalSamples = wasm._intervalSamples()
  const bufferLength = Math.max(CHUNK, inputLatency, outputLatency)
  const pointer = wasm._setBuffers(channels.length, bufferLength)
  // Obtain fresh views each time: configure/process may grow WASM memory.
  const fill = (at, count) => {
    for (let c = 0; c < channels.length; c++) {
      const target = new Float32Array(wasm.HEAP8.buffer, pointer + c * bufferLength * 4, count)
      target.fill(0)
      if (at < length) target.set(channels[c].subarray(at, Math.min(length, at + count)))
    }
  }
  fill(0, inputLatency)
  wasm._seek(inputLatency, 1)
  // Seek advances the input look-ahead only. Discard outputLatency pre-roll.
  // Continue PROCESS through the entire output latency at EOF. Calling flush
  // directly after input exhaustion caused measured 11+ dB EOF impulse loss in
  // upstream 1.3.2. Fully draining first avoids that unfinished-window loss.
  const generatedLength = length + outputLatency
  let outputPeak = 0
  for (let at = 0; at < generatedLength; at += CHUNK) {
    checkAbort(signal)
    const count = Math.min(CHUNK, generatedLength - at)
    fill(at + inputLatency, count)
    wasm._process(count, count)
    const from = Math.max(0, outputLatency - at)
    const to = Math.min(count, outputLatency + length - at)
    for (let c = 0; c < channels.length; c++) {
      const source = new Float32Array(wasm.HEAP8.buffer, pointer + (c + channels.length) * bufferLength * 4, count)
      for (let i = from; i < to; i++) {
        const value = source[i]
        if (!Number.isFinite(value)) throw new Error('Pitch render produced nonfinite audio')
        output[c][at + i - outputLatency] = value
        outputPeak = Math.max(outputPeak, Math.abs(value))
      }
    }
    if ((at / CHUNK) % 8 === 0) await checkpoint(0.08 + 0.91 * (at + count) / generatedLength)
  }
  // Drain/reset only after all requested output has been computed. Never splice
  // unshifted source at clip edges and never fold future samples into the clip.
  wasm._flush(outputLatency)
  checkAbort(signal)
  // Calculation is complete before terminal notification. A late cancellation
  // is handled by the client/source owner before adoption, not by undoing DSP.
  notify(1)
  return { channels: output, sampleRate, metadata: { ...metadata, outputPeak, inputLatency, outputLatency, blockSamples, intervalSamples, wasmMemoryBytes: wasm.HEAP8.buffer.byteLength } }
}
