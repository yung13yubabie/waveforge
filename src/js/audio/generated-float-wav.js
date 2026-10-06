// INTERNAL generated-asset persistence, not the user's delivery/export encoder.
// RIFF/WAVE IEEE_FLOAT (tag 3), 32-bit little-endian, fmt/WAVEFORMATEX + fact.
// Keeps finite Float32 samples exactly, including signed zero and headroom >1.
// No dither, normalization, clipping, resampling, external codec or network.
export const GENERATED_FLOAT_WAV_LIMITS = Object.freeze({
  sampleRates: Object.freeze([44100, 48000, 96000]), maxChannels: 2,
  maxDurationSeconds: 30, headerBytes: 58,
  maxEncodedBytes: 30 * 96000 * 2 * 4 + 58,
})
const CHUNK = 16384
const defaultYield = () => new Promise(resolve => setTimeout(resolve, 0))
const abortError = () => Object.assign(new Error('Generated audio serialization cancelled'), { name: 'AbortError' })
function checkAbort(signal) { if (signal?.aborted) throw abortError() }

export function validateGeneratedFloatWavInput(channels, sampleRate, options = {}) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > GENERATED_FLOAT_WAV_LIMITS.maxChannels) throw new RangeError('Generated WAV requires one or two channels')
  if (!GENERATED_FLOAT_WAV_LIMITS.sampleRates.includes(sampleRate)) throw new RangeError('Generated WAV supports 44100, 48000, or 96000 Hz')
  const length = channels[0]?.length
  for (let c = 0; c < channels.length; c++) {
    if (!(channels[c] instanceof Float32Array) || channels[c].length !== length) throw new TypeError('Generated WAV requires equal-length Float32Array channels')
  }
  if (channels.some(x => typeof SharedArrayBuffer !== 'undefined' && x.buffer instanceof SharedArrayBuffer)) throw new TypeError('Shared audio buffers are not supported')
  if (!length || length > sampleRate * GENERATED_FLOAT_WAV_LIMITS.maxDurationSeconds) throw new RangeError('Generated WAV must contain 1 sample to 30 seconds')
  const { signal, onProgress, yieldControl } = options
  if (signal != null && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new TypeError('signal must be an AbortSignal')
  if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function')
  if (yieldControl != null && typeof yieldControl !== 'function') throw new TypeError('yieldControl must be a function')
  const encodedBytes = GENERATED_FLOAT_WAV_LIMITS.headerBytes + length * channels.length * 4
  if (!Number.isSafeInteger(encodedBytes) || encodedBytes > GENERATED_FLOAT_WAV_LIMITS.maxEncodedBytes) throw new RangeError('Generated WAV exceeds its memory limit')
  return { length, channelCount: channels.length, encodedBytes }
}

/**
 * Return one owned ArrayBuffer suitable for a retained audio/wav Blob/hash.
 * The caller owns immutable input until settlement. Cancellation/nonfinite PCM
 * rejects without returning partial bytes or changing input. Yields are bounded
 * by CHUNK frames. Serialization is lossless; browser decode parity must still
 * be verified in each supported engine at the same native sample rate.
 */
export async function encodeGeneratedFloatWav(channels, sampleRate, options = {}) {
  const { length, channelCount, encodedBytes } = validateGeneratedFloatWavInput(channels, sampleRate, options)
  const { signal, onProgress, yieldControl = defaultYield } = options
  checkAbort(signal)
  const report = value => { try { onProgress?.(value) } catch { /* progress observers do not invalidate audio */ } }
  const bytes = new ArrayBuffer(encodedBytes), view = new DataView(bytes)
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, encodedBytes - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 18, true)
  view.setUint16(20, 3, true); view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * channelCount * 4, true)
  view.setUint16(32, channelCount * 4, true); view.setUint16(34, 32, true); view.setUint16(36, 0, true)
  text(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, length, true)
  text(50, 'data'); view.setUint32(54, length * channelCount * 4, true)
  for (let at = 0; at < length; at += CHUNK) {
    checkAbort(signal)
    const end = Math.min(length, at + CHUNK)
    for (let i = at; i < end; i++) for (let c = 0; c < channelCount; c++) {
      const value = channels[c][i]
      if (!Number.isFinite(value)) throw new RangeError('Generated WAV input must contain only finite samples')
      view.setFloat32(58 + (i * channelCount + c) * 4, value, true)
    }
    // Reserve completion 1 until after the final yield/abort check.
    report(0.99 * end / length)
    checkAbort(signal)
    await yieldControl()
    checkAbort(signal)
  }
  // Commit the completed calculation before notifying its terminal observer.
  // Cancellation at progress=1 is too late to undo serialization; the caller
  // still checks current job/source ownership before adopting this result.
  report(1)
  return bytes
}
