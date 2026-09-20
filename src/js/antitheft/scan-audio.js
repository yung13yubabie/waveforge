// Decode at 16 kHz to determine the full source duration.
export async function getAudioDuration(file) {
  const arr = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(1, 1, 16000)
  const decoded = await ctx.decodeAudioData(arr.slice(0))
  return decoded.duration || 15
}

/**
 * Extract the first N seconds as a base64 WAV data URL for ACRCloud.
 * MONO @ 16 kHz — ACRCloud fingerprints at ~8 kHz internally, so this is
 * plenty for matching while keeping the upload tiny. The old 30s stereo 48kHz
 * sample was ~5.76 MB and tripped ACRCloud code 3016 ("file too large").
 * 15s mono 16kHz ≈ 480 KB.
 */
export async function extractAudioSample(file, durationSec, offsetSec = 0) {
  const SR = 16000
  const arr = await file.arrayBuffer()
  // Decode at the sample rate first so we can clamp the render length to the real
  // track duration (no trailing silence padding for short tracks).
  const probe = new OfflineAudioContext(1, 1, SR)
  const decoded = await probe.decodeAudioData(arr.slice(0))
  const dur   = decoded.duration || durationSec
  const start = Math.max(0, Math.min(offsetSec, Math.max(0, dur - 1)))
  const secs  = Math.min(durationSec, Math.max(0.5, dur - start))
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(SR * secs)), SR)
  const src = ctx.createBufferSource()
  src.buffer = decoded
  src.connect(ctx.destination)
  src.start(0, start, secs)
  const rendered = await ctx.startRendering()

  // Encode to WAV
  const numCh = rendered.numberOfChannels
  const len   = rendered.length
  const sr    = rendered.sampleRate
  const byteRate = sr * numCh * 2
  const dataBytes = len * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv  = new DataView(buf)
  const w   = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }

  w(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE')
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true)
  dv.setUint32(28, byteRate, true); dv.setUint16(32, numCh * 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, rendered.getChannelData(c)[i]))
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }

  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(bin)}`
}

