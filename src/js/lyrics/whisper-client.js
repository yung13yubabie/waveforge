import { WHISPER_CACHE_NAME, WHISPER_INFO, validateWhisperInput, validateWhisperChunks, isExactDigitalSilence } from './whisper-config.js'

const abortError = message => Object.assign(new Error(message), { name: 'AbortError' })
const defaultWorkerFactory = () => new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' })

/** No worker, import, download or cache access until an approved transcribe call. */
export function createWhisperClient({
  modelSourceApproved = false,
  workerFactory = defaultWorkerFactory,
  timeoutMs = 300000,
  cacheStorage = globalThis.caches,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('A positive finite timeout is required')
  let worker = null
  let active = null
  let nextId = 0
  let disposed = false
  let clearingCache = null
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
        // A UI observer must not prevent cancellation or completion.
        try { active.onProgress?.(data.progress) } catch { /* observer failure only */ }
      } else if (data.type === 'error') {
        finish(Object.assign(new Error(data.error?.message || 'Whisper worker failed'), { name: data.error?.name || 'Error' }), null, true)
      } else if (data.type === 'result') {
        try {
          const chunks = validateWhisperChunks(data.result?.chunks, active.duration)
          finish(null, {
            chunks, engine: WHISPER_INFO.engine, engineVersion: WHISPER_INFO.engineVersion,
            model: WHISPER_INFO.model, revision: WHISPER_INFO.revision,
            language: active.language, sampleRate: 16000, duration: active.duration,
            timestampOrigin: 'window-relative', timingMethod: 'audio-cross-attention-dtw',
            modelValidation: WHISPER_INFO.modelValidation,
          })
        } catch (error) { finish(error, null, true) }
      } else {
        finish(new Error('Unexpected Whisper worker response'), null, true)
      }
    }
    worker.onerror = event => {
      if (worker !== instance) return
      event.preventDefault?.()
      finish(new Error(event.message || 'Whisper worker crashed'), null, true)
      stopWorker()
    }
    worker.onmessageerror = () => {
      if (worker !== instance) return
      finish(new Error('Whisper worker response could not be decoded'), null, true)
      stopWorker()
    }
    return worker
  }
  return {
    info: WHISPER_INFO,
    async transcribe({ samples, sampleRate, language, signal, onProgress } = {}) {
      if (disposed) throw new Error('Whisper client has been disposed')
      if (modelSourceApproved !== true) throw Object.assign(new Error('Approve the pinned model source and download before transcription'), { name: 'ModelSourceApprovalError' })
      if (clearingCache) throw Object.assign(new Error('Whisper model cache is being cleared'), { name: 'BusyError' })
      if (active) throw Object.assign(new Error('Whisper client is already transcribing a window'), { name: 'BusyError' })
      if (signal?.aborted) throw abortError('Whisper transcription cancelled')
      const duration = validateWhisperInput({ samples, sampleRate, language })
      // Real pinned-model testing found a plausible word on exact zero PCM.
      // Digital silence contains no sung words. Do not invoke/download a model
      // or invent timestamps; do not apply this shortcut to merely quiet audio.
      if (isExactDigitalSilence(samples)) {
        try { onProgress?.({ phase: 'complete' }) } catch { /* observer failure only */ }
        return {
          chunks: [], engine: WHISPER_INFO.engine, engineVersion: WHISPER_INFO.engineVersion,
          model: WHISPER_INFO.model, revision: WHISPER_INFO.revision,
          language, sampleRate: 16000, duration,
          timestampOrigin: 'window-relative', timingMethod: 'exact-digital-silence',
          modelValidation: WHISPER_INFO.modelValidation, modelExecuted: false,
        }
      }
      // Transfer a copy. The original waveform is still needed by playback/matcher.
      const copy = new Float32Array(samples)
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const onAbort = () => finish(abortError('Whisper transcription cancelled'), null, true)
        active = { id, resolve, reject, duration, language, onProgress, signal, onAbort }
        active.timer = setTimeout(() => finish(Object.assign(new Error('Whisper transcription timed out'), { name: 'TimeoutError' }), null, true), timeoutMs)
        signal?.addEventListener('abort', onAbort, { once: true })
        // Cover aborts between the initial check and listener installation.
        if (signal?.aborted) return onAbort()
        try {
          ensureWorker().postMessage({ type: 'transcribe', id, samples: copy, sampleRate, language, modelSourceApproved: true }, [copy.buffer])
        } catch (error) { finish(error, null, true) }
      })
    },
    /** Explicit user action only. Deletes this exact model cache, never other caches. */
    async clearCache() {
      if (clearingCache) return clearingCache
      finish(abortError('Whisper transcription cancelled to clear model cache'), null, true)
      stopWorker()
      clearingCache = (async () => {
        const deleted = cacheStorage ? await cacheStorage.delete(WHISPER_CACHE_NAME) : false
        return { deleted, cacheName: WHISPER_CACHE_NAME, persistentCacheAvailable: Boolean(cacheStorage) }
      })()
      try { return await clearingCache } finally { clearingCache = null }
    },
    dispose() {
      disposed = true
      finish(abortError('Whisper client disposed'), null, true)
      stopWorker()
    },
  }
}
