import { renderSignalsmithPitch } from './signalsmith-render.js'

// Exported for lifecycle tests; browser messages transfer only owned copies.
export function createSignalsmithWorkerHandler(postMessage) {
  let current = null
  return async ({ data }) => {
    if (data?.type === 'cancel') {
      if (current?.id === data.id) current.controller.abort()
      return
    }
    if (data?.type !== 'render' || !Number.isSafeInteger(data.id) || data.id < 1) return
    current?.controller.abort()
    const job = { id: data.id, controller: new AbortController() }
    current = job
    try {
      const result = await renderSignalsmithPitch(data.channels, data.sampleRate, {
        semitones: data.options?.semitones, cents: data.options?.cents,
        formantSemitones: data.options?.formantSemitones,
        formantCompensation: data.options?.formantCompensation,
        formantBaseHz: data.options?.formantBaseHz,
        signal: job.controller.signal,
        onProgress: progress => { if (current === job) postMessage({ type: 'progress', id: job.id, progress }) },
      })
      if (current === job && !job.controller.signal.aborted) postMessage({ type: 'result', id: job.id, result }, result.channels.map(x => x.buffer))
    } catch (error) {
      if (current === job) postMessage({ type: 'error', id: job.id, error: { name: error.name || 'Error', message: error.message || 'Pitch render failed' } })
    } finally {
      if (current === job) current = null
    }
  }
}
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = createSignalsmithWorkerHandler((message, transfer = []) => globalThis.postMessage(message, transfer))
}
