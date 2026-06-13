// Album assembly: concatenate per-track rendered audio into one CD-DA image
// with frame-aligned track starts and pre-gaps. A CD frame (sector) is 1/75 s =
// 588 stereo samples at 44.1kHz; every track must begin on a frame boundary.
// Pure + fully testable (byte-exact layout).

export const FRAME_SAMPLES = 588   // 44100 / 75

/**
 * @param {{ left: Float32Array, right: Float32Array, gapBeforeSec?: number, isrc?: string, title?: string }[]} tracks
 * @param {number} sampleRate  must be 44100 for CD-DA
 * @returns {{ left: Float32Array, right: Float32Array, totalFrames: number,
 *   totalSamples: number, markers: {index,startFrame,lengthFrames,startSec,isrc,title}[], sampleRate: number }}
 */
export function assembleAlbum(tracks, sampleRate = 44100) {
  const framesPerSec = sampleRate / FRAME_SAMPLES   // 75 at 44.1k

  // Lay out frame positions first (every track starts on a frame boundary).
  let runningFrames = 0
  const layout = tracks.map(t => {
    const gapFrames = Math.max(0, Math.round((t.gapBeforeSec || 0) * framesPerSec))
    const len = t.left.length
    const trackFrames = Math.ceil(len / FRAME_SAMPLES)   // pad track to whole frames
    const startFrame = runningFrames + gapFrames
    runningFrames = startFrame + trackFrames
    return { startFrame, trackFrames, len }
  })

  const totalFrames = runningFrames
  const totalSamples = totalFrames * FRAME_SAMPLES
  const left = new Float32Array(totalSamples)
  const right = new Float32Array(totalSamples)
  const markers = []

  tracks.forEach((t, i) => {
    const { startFrame, trackFrames, len } = layout[i]
    const off = startFrame * FRAME_SAMPLES
    left.set(t.left.subarray(0, len), off)
    right.set(t.right.subarray(0, len), off)
    markers.push({
      index: i + 1,
      startFrame,
      lengthFrames: trackFrames,
      startSec: startFrame / framesPerSec,
      isrc: t.isrc || '',
      title: t.title || `Track ${i + 1}`,
    })
  })

  return { left, right, totalFrames, totalSamples, markers, sampleRate }
}
