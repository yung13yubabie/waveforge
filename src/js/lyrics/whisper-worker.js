import { assertCrossAttentionOutputs, installWhisperFrameCorrection } from './whisper-timestamps.js'
export { assertCrossAttentionOutputs, installWhisperFrameCorrection } from './whisper-timestamps.js'
import {
  WHISPER_FILES, WHISPER_INFO, WHISPER_CACHE_NAME,
  WHISPER_MODEL_ID, WHISPER_REVISION, WHISPER_VERSION,
  validateWhisperInput, validateWhisperChunks, isExactDigitalSilence,
} from './whisper-config.js'
// Explicit same-origin Vite assets from the exact installed npm runtime. The
// package export map does not expose these files, hence package-relative paths.
import ortWasmAsset from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url'
import ortModuleAsset from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url'

const assetBase = globalThis.location?.href || import.meta.url
const runtimePaths = Object.freeze({
  wasm: new URL(ortWasmAsset, assetBase).href,
  mjs: new URL(ortModuleAsset, assetBase).href,
})

export async function verifyModelBytes(bytes, file, cryptoImpl = globalThis.crypto) {
  if (bytes.byteLength !== file.bytes) throw new Error(`Model size mismatch: ${file.path}`)
  if (!cryptoImpl?.subtle) throw new Error('Secure SHA-256 verification is unavailable')
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('')
  if (hex !== file.sha256) throw new Error(`Model integrity mismatch: ${file.path}; clear the model cache before retrying`)
  return bytes
}

/** Used by mocked tests too; no call to this function occurs merely on import. */
export async function prepareVerifiedModelCache({
  fetchImpl = globalThis.fetch.bind(globalThis), cacheStorage = globalThis.caches,
  cryptoImpl = globalThis.crypto, onProgress = () => {}, files = WHISPER_FILES,
} = {}) {
  let persistent = null
  try { persistent = await cacheStorage?.open(WHISPER_CACHE_NAME) } catch {
    onProgress({ phase: 'cache-unavailable' })
  }
  const verified = new Map()
  let aggregateLoaded = 0
  const aggregateTotal = files.reduce((sum, file) => sum + file.bytes, 0)
  for (const file of files) {
    let response = null
    try { response = await persistent?.match(file.url) } catch { onProgress({ phase: 'cache-unavailable' }) }
    const fromCache = Boolean(response)
    if (!response) {
      // URL/method are fixed by the manifest. Audio and lyrics are never fetch data.
      response = await fetchImpl(file.url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    }
    if (!response.ok) throw new Error(`Model download failed (${response.status}): ${file.path}`)
    const bytes = new Uint8Array(file.bytes)
    let loaded = 0
    const progress = () => onProgress({
      phase: fromCache ? 'reading-cache' : 'downloading', file: file.path, loaded,
      total: file.bytes, aggregateLoaded: aggregateLoaded + loaded, aggregateTotal,
    })
    progress()
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (loaded + value.byteLength > file.bytes) throw new Error(`Model size mismatch: ${file.path}`)
          bytes.set(value, loaded); loaded += value.byteLength; progress()
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error }
      finally { reader.releaseLock() }
    } else {
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength !== file.bytes) throw new Error(`Model size mismatch: ${file.path}`)
      bytes.set(body); loaded = body.byteLength; progress()
    }
    if (loaded !== file.bytes) throw new Error(`Model size mismatch: ${file.path}`)
    onProgress({ phase: 'verifying', file: file.path })
    await verifyModelBytes(bytes, file, cryptoImpl)
    verified.set(file.url, bytes)
    aggregateLoaded += loaded
    if (!fromCache && persistent) {
      try { await persistent.put(file.url, new Response(bytes)) } catch { onProgress({ phase: 'cache-unavailable' }) }
    }
  }
  return {
    async match(key) {
      const url = typeof key === 'string' ? key : key?.url
      const bytes = verified.get(url)
      return bytes ? new Response(bytes) : undefined
    },
    async put() { throw new Error('Only manifest-verified model bytes may enter this cache') },
  }
}

/** The library may fetch only its explicit same-origin runtime assets. */
export function isAllowedRuntimeRequest(input, init = {}, allowedUrls = Object.values(runtimePaths)) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url
  const method = (init.method || input?.method || 'GET').toUpperCase()
  if (method !== 'GET' || init.body != null || input?.body != null || typeof url !== 'string') return false
  return allowedUrls.includes(url)
}

let pipelinePromise = null
let busy = false
const nativeFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null

async function loadPipeline(onProgress) {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const cache = await prepareVerifiedModelCache({ fetchImpl: nativeFetch, onProgress })
      onProgress({ phase: 'loading' })
      // Lazy import; default tests/CI never call this real runtime path.
      const { env, pipeline } = await import('@huggingface/transformers')
      if (env.version !== WHISPER_VERSION) throw new Error(`Expected Transformers.js ${WHISPER_VERSION}; refusing an unvalidated runtime`)
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = '/__waveforge_verified_model_cache__/'
      env.remoteHost = 'https://huggingface.co/'
      env.remotePathTemplate = '{model}/resolve/{revision}/'
      env.useFS = false
      env.useFSCache = false
      env.useBrowserCache = false
      env.useCustomCache = true
      env.customCache = cache
      env.backends.onnx.wasm.numThreads = 1
      env.backends.onnx.wasm.proxy = false
      env.backends.onnx.wasm.wasmPaths = runtimePaths
      // A private worker-scoped network fence prevents library cache misses from
      // escaping to another model or turning local audio into an HTTP payload.
      globalThis.fetch = (input, init) => {
        if (!isAllowedRuntimeRequest(input, init)) return Promise.reject(new Error('Unexpected network request blocked in local Whisper worker'))
        return nativeFetch(input, { ...init, method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer' })
      }
      const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
        revision: WHISPER_REVISION, device: 'wasm', dtype: { ...WHISPER_INFO.dtype },
        local_files_only: true,
      })
      assertCrossAttentionOutputs(asr)
      installWhisperFrameCorrection(asr.model, env.version)
      return asr
    })().catch(error => { pipelinePromise = null; throw error })
  }
  return pipelinePromise
}

// Importable for pure/mock tests; only an actual dedicated worker installs this.
if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = async ({ data }) => {
    const id = data?.id
    const send = message => globalThis.postMessage({ id, ...message })
    if (busy) { send({ type: 'error', error: { name: 'BusyError', message: 'Whisper worker is busy' } }); return }
    busy = true
    try {
      if (data?.type !== 'transcribe' || data.modelSourceApproved !== true) throw new Error('An explicitly approved transcription request is required')
      const duration = validateWhisperInput(data)
      const onProgress = progress => send({ type: 'progress', progress })
      if (isExactDigitalSilence(data.samples)) {
        onProgress({ phase: 'complete' })
        send({ type: 'result', result: { chunks: [], model: WHISPER_MODEL_ID, revision: WHISPER_REVISION, modelExecuted: false } })
        return
      }
      const asr = await loadPipeline(onProgress)
      onProgress({ phase: 'transcribing' })
      const result = await asr(data.samples, {
        language: data.language, task: 'transcribe', return_timestamps: 'word',
        chunk_length_s: 0, force_full_sequences: false,
      })
      const chunks = validateWhisperChunks(result?.chunks, duration)
      onProgress({ phase: 'complete' })
      send({ type: 'result', result: { chunks, model: WHISPER_MODEL_ID, revision: WHISPER_REVISION } })
    } catch (error) {
      send({ type: 'error', error: { name: error?.name || 'Error', message: error?.message || 'Whisper failed' } })
    } finally { busy = false }
  }
}
