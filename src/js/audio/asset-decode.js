// RIFF/WAVE chunks may include metadata before fmt; never assume offset 24.
export function wavSampleRate(bytes) {
  const view = new DataView(bytes)
  const tag = offset => String.fromCharCode(...new Uint8Array(bytes, offset, 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const length = view.getUint32(offset + 4, true)
    if (offset + 8 + length > bytes.byteLength) throw new Error('WAV 區塊損毀或不完整')
    if (tag(offset) === 'fmt ') {
      if (length < 16) throw new Error('WAV 格式區塊不完整')
      const rate = view.getUint32(offset + 12, true)
      if (rate < 8000 || rate > 192000) throw new Error('WAV 採樣率超出支援範圍')
      return rate
    }
    offset += 8 + length + (length & 1)
  }
  throw new Error('WAV 缺少格式區塊')
}

export async function decodeSourceAsset(bytes, monitorContext) {
  const nativeRate = wavSampleRate(bytes)
  // WAV master PCM is decoded at its native rate, independently of the device.
  const decoder = nativeRate && nativeRate !== monitorContext.sampleRate
    ? new OfflineAudioContext(2, 1, nativeRate) : monitorContext
  const buffer = await decoder.decodeAudioData(bytes)
  return { buffer, sourceSampleRate: nativeRate, monitorSampleRate: monitorContext.sampleRate,
    decodeBackend: nativeRate ? 'native-rate-wav' : 'browser-rate-fallback' }
}
