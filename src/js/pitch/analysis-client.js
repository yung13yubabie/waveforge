import { PITCH_ANALYSIS_INFO, pitchAbortError, validatePitchInput } from './analysis.js'

const defaultWorkerFactory = () => new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' })

/**
 * Crop a copy before transfer; playback's AudioBuffer is never detached/mutated.
 * The source copy is bounded to 60 seconds × 192000 Hz × 4 bytes (46.08 MB).
 * Analyze channel 0 by default, avoiding anti-phase cancellation when downmixing.
 * A caller may explicitly select another channel. No voice isolation is implied.
 */
function copyWindow(audioBuffer, { start = 0, duration, channel = 0 } = {}) {
  const rate = audioBuffer?.sampleRate
  if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function' || !Number.isFinite(rate) || rate < 8000 || rate > 192000 || !Number.isSafeInteger(audioBuffer.length) || audioBuffer.length < 0) {
    throw new TypeError('A decoded AudioBuffer at 8000–192000 Hz is required')
  }
  if (!Number.isInteger(channel) || channel < 0 || channel >= audioBuffer.numberOfChannels) throw new RangeError('Invalid analysis channel')
  if (!Number.isFinite(start) || start < 0 || start > audioBuffer.length / rate) throw new RangeError('Invalid pitch selection start')
  const first = Math.round(start * rate)
  const available = (audioBuffer.length - first) / rate
  const selectedDuration = duration === undefined ? Math.min(PITCH_ANALYSIS_INFO.maxDuration, available) : duration
  if (!Number.isFinite(selectedDuration) || selectedDuration < 0 || selectedDuration > PITCH_ANALYSIS_INFO.maxDuration || selectedDuration > available + 1 / rate) throw new RangeError('Select up to 60 seconds within this audio buffer')
  const last = Math.min(audioBuffer.length, first + Math.floor(selectedDuration * rate))
  const source = audioBuffer.getChannelData(channel)
  if (!(source instanceof Float32Array) || source.length !== audioBuffer.length) throw new TypeError('Invalid audio channel PCM')
  const samples = source.slice(first, last)
  validatePitchInput(samples, rate, { start: first / rate })
  return { samples, sampleRate: rate, start: first / rate, duration: samples.length / rate, channel }
}

function validateResult(result, job) {
  if (!result || result.engine !== PITCH_ANALYSIS_INFO.engine || !Array.isArray(result.frames) || result.frames.length > 3001 || result.sampleRate !== job.sampleRate || result.start !== job.start || result.duration !== job.duration) throw new Error('Invalid pitch worker response')
  let previous = -Infinity
  for (const frame of result.frames) {
    if (!Number.isFinite(frame.time) || frame.time < job.start || frame.time > job.start + job.duration || frame.time <= previous || !['voiced', 'uncertain', 'unvoiced'].includes(frame.state) || !Number.isFinite(frame.confidence) || frame.confidence < 0 || frame.confidence > 1) throw new Error('Invalid pitch contour')
    if (frame.state === 'voiced') {
      if (!Number.isFinite(frame.frequencyHz) || frame.frequencyHz < PITCH_ANALYSIS_INFO.minFrequencyHz || frame.frequencyHz > PITCH_ANALYSIS_INFO.maxFrequencyHz || !Number.isFinite(frame.midi) || !Number.isFinite(frame.cents) || typeof frame.note !== 'string') throw new Error('Invalid voiced pitch estimate')
    } else if (frame.frequencyHz !== null || frame.midi !== null || frame.note !== null || frame.cents !== null) throw new Error('Unknown pitch must remain unknown')
    previous = frame.time
  }
  return { ...result, channel: job.channel, analyzedChannel: job.channel }
}

/** Lazy worker, latest request wins, bounded timeout, explicit cancel/dispose. */
export function createPitchAnalysisClient({ workerFactory = defaultWorkerFactory, timeoutMs = 30000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('A positive finite timeout is required')
  let worker = null
  let active = null
  let nextId = 0
  let disposed = false
  const stopWorker = () => { worker?.terminate(); worker = null }
  function finish(error, result, terminate = false) {
    const job = active
    if (!job) return
    active = null
    clearTimeout(job.timer)
    job.signal?.removeEventListener('abort', job.onAbort)
    if (terminate) stopWorker()
    if (error) job.reject(error)
    else job.resolve(result)
  }
  function ensureWorker() {
    if (worker) return worker
    worker = workerFactory()
    const instance = worker
    worker.onmessage = ({ data }) => {
      if (worker !== instance || !active || data?.id !== active.id) return
      if (data.type === 'progress') {
        try { active.onProgress?.(data.progress) } catch { /* observer only */ }
      } else if (data.type === 'result') {
        try { finish(null, validateResult(data.result, active)) } catch (error) { finish(error, null, true) }
      } else if (data.type === 'error') {
        finish(Object.assign(new Error(data.error?.message || 'Pitch analysis failed'), { name: data.error?.name || 'Error' }), null, true)
      } else finish(new Error('Unexpected pitch worker response'), null, true)
    }
    worker.onerror = event => {
      if (worker !== instance) return
      event.preventDefault?.()
      finish(new Error(event.message || 'Pitch worker crashed'), null, true)
      stopWorker()
    }
    worker.onmessageerror = () => {
      if (worker !== instance) return
      finish(new Error('Pitch worker message could not be decoded'), null, true)
      stopWorker()
    }
    return worker
  }
  return {
    info: PITCH_ANALYSIS_INFO,
    async analyze(audioBuffer, { start = 0, duration, channel = 0, signal, onProgress } = {}) {
      if (disposed) throw new Error('Pitch analysis client has been disposed')
      if (signal?.aborted) throw pitchAbortError()
      const input = copyWindow(audioBuffer, { start, duration, channel })
      finish(pitchAbortError('Pitch analysis replaced by a newer request'), null, true)
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const onAbort = () => { if (active?.id === id) finish(pitchAbortError(), null, true) }
        active = { id, resolve, reject, ...input, signal, onAbort, onProgress }
        // The copied PCM belongs to the worker; do not retain it in active state.
        delete active.samples
        active.timer = setTimeout(() => {
          if (active?.id === id) finish(Object.assign(new Error('Pitch analysis timed out; try a shorter selection'), { name: 'TimeoutError' }), null, true)
        }, timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) return onAbort()
        try {
          ensureWorker().postMessage({ type: 'analyze', id, samples: input.samples, sampleRate: input.sampleRate, start: input.start }, [input.samples.buffer])
        } catch (error) { finish(error, null, true) }
      })
    },
    cancel() { finish(pitchAbortError(), null, true) },
    dispose() {
      disposed = true
      finish(pitchAbortError('Pitch analysis client disposed'), null, true)
      stopWorker()
    },
  }
}
