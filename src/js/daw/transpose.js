import { sourceFrameBounds } from './sample-bounds.js'
import { SIGNALSMITH_LIMITS, validateSignalsmithInput } from '../pitch/signalsmith-render.js'
import { encodeGeneratedFloatWav } from '../audio/generated-float-wav.js'
import { sha256Hex } from '../audio/sha256.js'

/** Plan before allocation. Views below borrow source PCM; the worker client
 * makes the sole owned input copy. Cropping covers fractional boundary samples. */
export function planClipTranspose(buffer, clip, settings = {}) {
  if (!buffer || !Number.isSafeInteger(buffer.length) || buffer.length < 1 ||
      ![1, 2].includes(buffer.numberOfChannels) || !SIGNALSMITH_LIMITS.sampleRates.includes(buffer.sampleRate)) {
    throw new Error('片段移調支援 44.1／48／96 kHz 的單聲道或立體聲錄音')
  }
  if (!Number.isFinite(clip?.offsetSeconds) || clip.offsetSeconds < 0 ||
      !Number.isFinite(clip?.durationSeconds) || clip.durationSeconds <= 0) throw new Error('請選取有效的音訊片段')
  const { first, last, offsetSeconds } = sourceFrameBounds(clip.offsetSeconds, clip.durationSeconds, buffer.sampleRate)
  const length = last - first
  if (first < 0 || last > buffer.length || length < 1) throw new Error('片段範圍超出原錄音')
  if (length > buffer.sampleRate * SIGNALSMITH_LIMITS.maxDurationSeconds) throw new Error('移調片段含邊界樣本最多 30 秒，請先裁短一點')
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => {
    const data = buffer.getChannelData(c)
    if (!(data instanceof Float32Array) || data.length !== buffer.length) throw new Error('原錄音資料不完整')
    return data.subarray(first, last)
  })
  const validated = validateSignalsmithInput(channels, buffer.sampleRate, settings)
  const pcmBytes = length * buffer.numberOfChannels * 4, fileBytes = pcmBytes + 58
  // Owned input, worker output/transfer, native candidate, serializer, Blob,
  // WebCrypto input copy. Native/WASM/allocator + metadata slack are additional.
  // The source, history, files and full-mix caches are counted by the panel.
  const sourceBytes = buffer.length * buffer.numberOfChannels * 4
  const reservedBytes = sourceBytes + pcmBytes * 3 + fileBytes * 3 + 16 * 1024 * 1024
  return { first, last, length, channels, sampleRate: buffer.sampleRate,
    offsetSeconds,
    pcmBytes, fileBytes, reservedBytes, settings: validated }
}

/** One worker result is adopted once and serialized exactly once. No rerender on
 * audition/Accept/save. check() must validate the panel owner at every boundary. */
export async function renderClipTranspose(plan, { client, settings, sourceToken, signal, check,
  createBuffer, onProgress, encode = encodeGeneratedFloatWav, hash = sha256Hex } = {}) {
  check()
  const result = await client.render(plan.channels, plan.sampleRate, { ...settings, signal, sourceToken, onProgress })
  check()
  if (result.sourceToken !== sourceToken) throw new Error('移調來源已變更，請重新產生')
  const buffer = createBuffer(result.channels.length, plan.length, plan.sampleRate)
  if (!buffer || buffer.length !== plan.length || buffer.sampleRate !== plan.sampleRate || buffer.numberOfChannels !== result.channels.length) throw new Error('瀏覽器未保留移調音訊的原始取樣率或聲道')
  for (let c = 0; c < result.channels.length; c++) buffer.copyToChannel(result.channels[c], c)
  check()
  // Serialize the native candidate itself, which is also the accepted buffer.
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const bytes = await encode(channels, plan.sampleRate, { signal })
  check()
  const digest = await hash(bytes)
  check()
  return { buffer, bytes, hash: digest, metadata: result.metadata, offsetSeconds: plan.offsetSeconds }
}
