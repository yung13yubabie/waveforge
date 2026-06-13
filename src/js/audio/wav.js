// PCM WAV encoder. 24-bit (default) or 16-bit with TPDF dither.
// Pure + testable (the old encoder was an untestable closure in main.js).

// Triangular-PDF dither, ±1 LSB peak (sum of two uniform randoms → triangular).
// Only applied at 16-bit, where quantisation distortion is audible; at 24-bit
// the noise floor (~−144 dBFS) is already below any source, so dither is moot.
function tpdf(lsb) { return (Math.random() - Math.random()) * lsb }

/**
 * @param {Float32Array[]} channels  per-channel sample data
 * @param {number} sampleRate
 * @param {16|24} bitDepth
 * @returns {ArrayBuffer} a complete WAV file
 */
export function encodeWAV(channels, sampleRate, bitDepth = 24) {
  const numChannels = channels.length
  const numSamples = channels[0]?.length ?? 0
  const bytesPerSample = bitDepth / 8           // 2 or 3
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = numSamples * blockAlign
  const wavSize = 44 + dataSize

  const wav = new ArrayBuffer(wavSize)
  const view = new DataView(wav)
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)) }

  writeStr(0, 'RIFF'); view.setUint32(4, wavSize - 8, true)
  writeStr(8, 'WAVE'); writeStr(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true)   // PCM
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeStr(36, 'data'); view.setUint32(40, dataSize, true)

  const dither = bitDepth === 16
  const MAX = bitDepth === 16 ? 0x7FFF : 0x7FFFFF
  const lsb = 1 / MAX
  let offset = 44
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      let s = channels[ch][i]
      if (dither) s += tpdf(lsb)
      s = Math.max(-1, Math.min(1, s))
      const v = Math.round(s < 0 ? s * (MAX + 1) : s * MAX)
      if (bitDepth === 16) {
        view.setInt16(offset, v, true)
        offset += 2
      } else {
        view.setUint8(offset, v & 0xFF)
        view.setUint8(offset + 1, (v >> 8) & 0xFF)
        view.setUint8(offset + 2, (v >> 16) & 0xFF)
        offset += 3
      }
    }
  }
  return wav
}
