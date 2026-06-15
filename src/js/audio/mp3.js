import lamejs from 'lamejs'

const VALID_SAMPLE_RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])

/**
 * Encode Float32 channel data to MP3 using lamejs.
 * @param {Float32Array[]} channels - [left, right] or [mono]
 * @param {number} sampleRate - must be one of lamejs' supported rates (not 96000)
 * @param {number} kbps - 128 | 192 | 256 | 320
 * @returns {Uint8Array}
 */
export function encodeMP3(channels, sampleRate, kbps = 192) {
  if (!VALID_SAMPLE_RATES.has(sampleRate)) {
    throw new Error(`MP3 不支援此採樣率：${sampleRate} Hz（僅支援最高 48000 Hz）`)
  }
  if (!channels[0]?.length) throw new Error('音訊緩衝區為空，無法編碼 MP3')
  const numChannels = Math.min(channels.length, 2)
  const encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, kbps)
  const sampleBlockSize = 1152 // lamejs requires multiples of 1152
  const chunks = []

  const toInt16 = (float32) => {
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]))
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
    }
    return int16
  }

  const left  = toInt16(channels[0])
  const right = numChannels > 1 ? toInt16(channels[1]) : left

  for (let i = 0; i < left.length; i += sampleBlockSize) {
    const leftChunk  = left.subarray(i, i + sampleBlockSize)
    const rightChunk = right.subarray(i, i + sampleBlockSize)
    const encoded = numChannels > 1
      ? encoder.encodeBuffer(leftChunk, rightChunk)
      : encoder.encodeBuffer(leftChunk)
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded))
  }

  const flushed = encoder.flush()
  if (flushed.length > 0) chunks.push(new Uint8Array(flushed))

  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { out.set(c, offset); offset += c.length }
  return out
}
