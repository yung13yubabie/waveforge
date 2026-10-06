import { SIGNALSMITH_LIMITS, signalsmithAbortError, validateSignalsmithInput } from './signalsmith-render.js'
const defaultWorkerFactory = () => new Worker(new URL('./signalsmith-worker.js', import.meta.url), { type: 'module' })

function validateResult(result, job) {
  if (!result || result.sampleRate !== job.sampleRate || !Array.isArray(result.channels) || result.channels.length !== job.channelCount || result.channels.some(x => !(x instanceof Float32Array) || x.length !== job.length)) throw new Error('Invalid Signalsmith worker audio response')
  const m = result.metadata
  if (!m || m.engine !== SIGNALSMITH_LIMITS.engine || m.inputSamples !== job.length || m.outputSamples !== job.length || m.semitones !== job.settings.amount || m.formantSemitones !== job.settings.formantSemitones || m.formantCompensation !== job.settings.formantCompensation || m.formantBaseHz !== job.settings.formantBaseHz || !Number.isFinite(m.outputPeak) || m.outputPeak < 0 || m.outputGain !== 1) throw new Error('Invalid Signalsmith worker metadata')
  // Finite scan belongs in the worker; this contract prevents unexpected sizes,
  // channels, settings or stale source responses from becoming a replacement.
  return { ...result, sourceToken: job.sourceToken, requestId: job.id }
}

/**
 * One in-flight render; newest request wins. Input is copied before transfer,
 * never detaching a playback/source buffer. Call cancel() when source/edit state
 * changes, and compare returned sourceToken before applying a result. One-shot
 * workers are terminated after success/error/abort to release WASM memory.
 */
export function createSignalsmithPitchClient({ workerFactory = defaultWorkerFactory, timeoutMs = 60000 } = {}) {
  if (typeof workerFactory !== 'function') throw new TypeError('A worker factory is required')
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) throw new RangeError('Worker timeout must be positive and at most five minutes')
  let active = null, worker = null, nextId = 0, disposed = false
  const stopWorker = () => { worker?.terminate(); worker = null }
  function finish(error, result) {
    const job = active
    if (!job) return
    active = null
    clearTimeout(job.timer)
    try { job.signal?.removeEventListener('abort', job.onAbort) } catch { /* cleanup must still settle the job */ }
    stopWorker()
    if (error) job.reject(error)
    else job.resolve(result)
  }
  return {
    info: SIGNALSMITH_LIMITS,
    async render(channels, sampleRate, options = {}) {
      if (disposed) throw new Error('Pitch render client has been disposed')
      if (options.signal?.aborted) throw signalsmithAbortError()
      const settings = validateSignalsmithInput(channels, sampleRate, options)
      const { sourceToken = null, signal, onProgress } = options
      if (sourceToken !== null && typeof sourceToken !== 'string' && !(Number.isSafeInteger(sourceToken))) throw new TypeError('sourceToken must be a string, safe integer, or null')
      finish(signalsmithAbortError('Pitch render replaced by a newer request'))
      // Maximum stereo copy: 23,040,000 bytes. Source remains caller-owned.
      const copy = channels.map(x => x.slice())
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const onAbort = () => { if (active?.id === id) finish(signalsmithAbortError()) }
        const job = { id, resolve, reject, signal, onAbort, onProgress, sourceToken, settings, sampleRate, length: settings.length, channelCount: channels.length, progress: 0 }
        active = job
        job.timer = setTimeout(() => {
          if (active === job) finish(Object.assign(new Error('Pitch render timed out; try a shorter selection'), { name: 'TimeoutError' }))
        }, timeoutMs)
        try {
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) return onAbort()
          if (active !== job) return
          worker = workerFactory()
          const instance = worker
          worker.onmessage = ({ data }) => {
            if (worker !== instance || active !== job || data?.id !== id) return
            if (data.type === 'progress') {
              if (!Number.isFinite(data.progress) || data.progress < job.progress || data.progress > 1) return finish(new Error('Invalid pitch render progress'))
              job.progress = data.progress
              try { onProgress?.(data.progress) } catch { /* observer cannot invalidate rendered audio */ }
            } else if (data.type === 'result') {
              try { finish(null, validateResult(data.result, job)) } catch (error) { finish(error) }
            } else if (data.type === 'error') {
              finish(Object.assign(new Error(data.error?.message || 'Pitch render failed'), { name: data.error?.name || 'Error' }))
            } else finish(new Error('Unexpected pitch worker response'))
          }
          worker.onerror = event => {
            if (worker !== instance || active !== job) return
            event.preventDefault?.()
            finish(new Error(event.message || 'Pitch render worker crashed'))
          }
          worker.onmessageerror = () => { if (worker === instance && active === job) finish(new Error('Pitch render response could not be decoded')) }
          worker.postMessage({ type: 'render', id, channels: copy, sampleRate, options: { semitones: settings.amount, formantSemitones: settings.formantSemitones, formantCompensation: settings.formantCompensation, formantBaseHz: settings.formantBaseHz } }, copy.map(x => x.buffer))
        } catch (error) { finish(error) }
      })
    },
    cancel() { finish(signalsmithAbortError()) },
    dispose() { disposed = true; finish(signalsmithAbortError('Pitch render client disposed')); stopWorker() },
  }
}
