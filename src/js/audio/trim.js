// Extract a time range from an AudioBuffer.

/**
 * @param {AudioBuffer} buffer
 * @param {number} startSec
 * @param {number} endSec
 * @param {{fadeMs?: number}} [opts]
 * @returns {AudioBuffer}
 */
export function trimBuffer(buffer, startSec, endSec, { fadeMs = 5 } = {}) {
  const sr = buffer.sampleRate
  const duration = buffer.length / sr
  const s = Math.max(0, Math.min(startSec, duration))
  const e = Math.max(0, Math.min(endSec, duration))

  if (!(e > s)) {
    throw new Error(`裁剪範圍無效：起點 ${s.toFixed(2)}s 需早於終點 ${e.toFixed(2)}s`)
  }

  const startSample = Math.round(s * sr)
  const endSample = Math.round(e * sr)
  const outLen = endSample - startSample

  // Cap the fade to half the output so fade-in and fade-out on a very short
  // selection can't overlap and double-attenuate the middle samples.
  const fadeSamples = Math.min(Math.round((fadeMs / 1000) * sr), Math.floor(outLen / 2))

  const numCh = buffer.numberOfChannels
  const out = new OfflineAudioContext(numCh, outLen, sr).createBuffer(numCh, outLen, sr)

  for (let ch = 0; ch < numCh; ch++) {
    const dst = buffer.getChannelData(ch).slice(startSample, endSample)
    for (let i = 0; i < fadeSamples; i++) {
      const g = i / fadeSamples
      dst[i] *= g
      dst[outLen - 1 - i] *= g
    }
    out.copyToChannel(dst, ch)
  }
  return out
}
