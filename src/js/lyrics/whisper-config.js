/** Pinned, consent-gated source contract. Importing this file performs no I/O. */
export const WHISPER_MODEL_ID = 'Xenova/whisper-tiny'
export const WHISPER_REVISION = '5332fcc35e32a33b86612b9a57a89be7906102b1'
export const WHISPER_VERSION = '3.8.1'
export const WHISPER_CACHE_NAME = `waveforge-lyrics-whisper-tiny-${WHISPER_REVISION}-fp32-q8-v1`
export const WHISPER_SOURCE_BASE = `https://huggingface.co/${WHISPER_MODEL_ID}/resolve/${WHISPER_REVISION}/`
export const WHISPER_ORT_VERSION = '1.22.0-dev.20250409-89f8206ba4'

// Weight hashes are the Hub's LFS SHA-256 values. JSON hashes were calculated
// from read-only metadata requests at the SAME immutable revision, 2026-10-05.
export const WHISPER_FILES = Object.freeze([
  ['onnx/encoder_model.onnx', 32909539, '39e81b6c86a5b2b4beda1bb3145486a769d594801f780a66cad1ae72c7ad2c5e'],
  ['onnx/decoder_model_merged_quantized.onnx', 30727765, '6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0'],
  ['config.json', 2248, '2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94'],
  ['generation_config.json', 3716, '68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c'],
  ['preprocessor_config.json', 339, 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d'],
  ['tokenizer.json', 2480466, '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566'],
  ['tokenizer_config.json', 282683, '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce'],
].map(([path, bytes, sha256]) => Object.freeze({ path, bytes, sha256, url: WHISPER_SOURCE_BASE + path })))

// Actual language tokens in this pinned tiny checkpoint; Cantonese/yue is absent.
export const WHISPER_LANGUAGES = Object.freeze('af am ar as az ba be bg bn bo br bs ca cs cy da de el en es et eu fa fi fo fr gl gu haw ha he hi hr ht hu hy id is it ja jw ka kk km kn ko la lb ln lo lt lv mg mi mk ml mn mr ms mt my ne nl nn no oc pa pl ps pt ro ru sa sd si sk sl sn so sq sr su sv sw ta te tg th tk tl tr tt uk ur uz vi yi yo zh'.split(' '))

export const WHISPER_INFO = Object.freeze({
  name: 'Whisper Tiny（本機）', backend: 'wasm',
  engine: 'transformers.js-whisper', engineVersion: WHISPER_VERSION,
  timestampAdapter: 'transformers.js-3.8.1-mel-to-encoder-frames-v1',
  model: WHISPER_MODEL_ID, modelId: WHISPER_MODEL_ID, revision: WHISPER_REVISION,
  license: 'Apache-2.0',
  sourceUrl: `https://huggingface.co/${WHISPER_MODEL_ID}/tree/${WHISPER_REVISION}`,
  modelUrl: `https://huggingface.co/${WHISPER_MODEL_ID}/tree/${WHISPER_REVISION}`,
  licenseUrl: `https://huggingface.co/${WHISPER_MODEL_ID}/blob/${WHISPER_REVISION}/README.md`,
  totalBytes: WHISPER_FILES.reduce((sum, file) => sum + file.bytes, 0),
  downloadBytes: WHISPER_FILES.reduce((sum, file) => sum + file.bytes, 0),
  runtimeDownloadIncluded: false,
  runtimeSourceUrl: `https://www.npmjs.com/package/onnxruntime-web/v/${WHISPER_ORT_VERSION}`,
  runtimeDelivery: 'same-origin bundled assets', runtimeAssetBytes: 21640503,
  files: WHISPER_FILES, cacheName: WHISPER_CACHE_NAME,
  device: 'wasm', dtype: Object.freeze({ encoder_model: 'fp32', decoder_model_merged: 'q8' }),
  sampleRate: 16000, minWindowSeconds: 0.02, maxWindowSeconds: 20, languages: WHISPER_LANGUAGES,
  automaticLanguageDetection: false, modelValidation: 'pending-model-backed-validation',
})
export const WHISPER_MODEL_INFO = WHISPER_INFO

/** Exact digital zero only. This is not VAD or a low-volume/music classifier. */
export function isExactDigitalSilence(samples) {
  return samples instanceof Float32Array && samples.length > 0 && samples.every(sample => sample === 0)
}

export function validateWhisperInput({ samples, sampleRate, language } = {}) {
  if (!(samples instanceof Float32Array) || !samples.length) throw new TypeError('A non-empty mono Float32Array is required')
  if (sampleRate !== 16000) throw new RangeError('Whisper input must already be resampled to 16000 Hz')
  if (samples.length < 320) throw new RangeError('Whisper requires at least one complete 20 ms encoder frame')
  if (samples.length > 20 * sampleRate) throw new RangeError('Each Whisper window must be at most 20 seconds')
  if (!WHISPER_LANGUAGES.includes(language)) throw new RangeError('An explicit supported language code is required')
  for (const sample of samples) {
    if (!Number.isFinite(sample)) throw new TypeError('Audio samples must be finite')
  }
  return samples.length / sampleRate
}

/** No repair, interpolation, clipping, or fabricated confidence on invalid output. */
export function validateWhisperChunks(chunks, duration) {
  if (!Array.isArray(chunks) || !Number.isFinite(duration) || duration <= 0) throw new TypeError('Invalid Whisper timestamp result')
  let previousEnd = 0
  return chunks.map(chunk => {
    const timestamp = chunk?.timestamp
    if (typeof chunk?.text !== 'string' || !chunk.text.trim() || !Array.isArray(timestamp) || timestamp.length !== 2) {
      throw new TypeError('Invalid Whisper word chunk')
    }
    const [start, end] = timestamp
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration || start < previousEnd) {
      throw new RangeError('Whisper word timestamps are invalid, overlapping, or outside this audio window')
    }
    previousEnd = end
    return { text: chunk.text, timestamp: [start, end] }
  })
}
