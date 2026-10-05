import { analyzePitch } from './analysis.js'

/** Separate export lets lifecycle tests exercise the real DSP without a browser. */
export function createPitchWorkerHandler(postMessage) {
  let current = null
  return async ({ data }) => {
    if (data?.type === 'cancel') {
      if (current?.id === data.id) current.controller.abort()
      return
    }
    if (data?.type !== 'analyze' || !Number.isSafeInteger(data.id) || data.id < 1) return
    current?.controller.abort()
    const job = { id: data.id, controller: new AbortController() }
    current = job
    try {
      const result = await analyzePitch(data.samples, data.sampleRate, {
        start: data.start, signal: job.controller.signal,
        onProgress: progress => { if (current === job) postMessage({ type: 'progress', id: job.id, progress }) },
      })
      if (current === job && !job.controller.signal.aborted) postMessage({ type: 'result', id: job.id, result })
    } catch (error) {
      if (current === job) postMessage({ type: 'error', id: job.id, error: { name: error.name || 'Error', message: error.message || 'Pitch analysis failed' } })
    } finally {
      if (current === job) current = null
    }
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = createPitchWorkerHandler(message => globalThis.postMessage(message))
}
