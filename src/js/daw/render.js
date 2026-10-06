import { DAW_LIMITS, validateProject, getProjectDuration, getDecodedBytes, getClipEnvelope, getClipVolumeAutomation } from './project.js'
import { measurePeaks } from '../audio/measure.js'

const dbToGain = db => 10 ** (db / 20)
let activeContext = false, pendingNativeBytes = 0
// Native offline work can outlive cancellation. Count its source/output buffers
// in panel budgets until the actual native promise settles.
export const getPendingNativeRenderBytes = () => pendingNativeBytes
export function abortError(message = 'DAW rendering cancelled or superseded') {
  const error = new Error(message); error.name = 'AbortError'; return error
}
function checkCurrent(signal, isCurrent) {
  if (signal?.aborted || (isCurrent && !isCurrent())) throw abortError()
}
/** Pure render recipe shared by preview and export. Tempo does not change timing. */
export function buildRenderPlan(project) {
  validateProject(project)
  const durationSeconds = getProjectDuration(project)
  const frames = Math.ceil(durationSeconds * project.sampleRate)
  const renderBytes = frames * 2 * 4
  const decodedBytes = getDecodedBytes(project)
  if (!frames) throw new Error('DAW: add an audio clip before rendering')
  if (renderBytes > DAW_LIMITS.maxRenderBytes || decodedBytes + renderBytes > DAW_LIMITS.maxCombinedBytes) {
    throw new Error('DAW: mix exceeds the memory limit; shorten the project or use 44100/48000 Hz')
  }
  const hasSolo = project.tracks.some(track => track.solo)
  return {
    schema: project.schema, projectId: project.id, revision: project.revision,
    sampleRate: project.sampleRate, channels: 2, durationSeconds, frames, renderBytes, decodedBytes,
    masterGain: dbToGain(project.masterGainDb),
    tracks: project.tracks.filter(track => !track.mute && (!hasSolo || track.solo)).map(track => ({
      id: track.id, gain: dbToGain(track.gainDb), pan: track.pan,
      clips: track.clips.map(clip => ({
        id: clip.id, assetId: clip.assetId, atSeconds: clip.atSeconds, offsetSeconds: clip.offsetSeconds,
        durationSeconds: clip.durationSeconds, gain: dbToGain(clip.gainDb), envelope: getClipEnvelope(clip),
        automation: getClipVolumeAutomation(clip),
      })),
    })),
  }
}
function assertBuffers(project, buffers) {
  if (!(buffers instanceof Map)) throw new Error('DAW: runtime buffers must be a Map')
  // Validate every referenced source, including currently muted clips, before claiming readiness.
  const referenced = new Set(project.tracks.flatMap(track => track.clips.map(clip => clip.assetId)))
  for (const asset of project.assets) {
    if (!referenced.has(asset.id)) continue
    const buffer = buffers.get(asset.id)
    if (!buffer || typeof buffer.getChannelData !== 'function') throw new Error(`DAW: missing audio source ${asset.name}`)
    if (buffer.sampleRate !== asset.sampleRate || buffer.numberOfChannels !== asset.channels ||
      (asset.length !== undefined && buffer.length !== asset.length) ||
      Math.abs(buffer.length / buffer.sampleRate - asset.duration) > 1 / asset.sampleRate + 1e-9) {
      throw new Error(`DAW: source metadata mismatch for ${asset.name}; reload the original file`)
    }
  }
}
/**
 * OfflineAudioContext performs actual sample-rate conversion, pan and mixing.
 * All preview/export consumers must use this exact rendered buffer. There is no
 * hidden normalization, mastering chain, time stretch, or monitor gain here.
 * Browsers cannot reliably cancel native offline work: a cancelled result is
 * discarded immediately; no second render starts until its native job settles.
 */
export async function renderProject(project, buffers, {
  signal, isCurrent, OfflineAudioContextClass = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext,
  timeoutMs = 120000,
} = {}) {
  checkCurrent(signal, isCurrent)
  const plan = buildRenderPlan(project)
  assertBuffers(project, buffers)
  if (typeof OfflineAudioContextClass !== 'function') throw new Error('DAW: offline Web Audio rendering is unavailable in this browser')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw new Error('DAW: render timeout must be 1–180000 ms')
  if (activeContext) throw new Error('DAW: previous native render is still finishing; retry shortly')
  activeContext = true
  const nodes = []
  let context, nativePromise, timer, abortHandler, disposed = false, nativeSettled = false, operationFinished = false
  const startedAt = Date.now()
  const checkJob = () => {
    checkCurrent(signal, isCurrent)
    if (Date.now() - startedAt > timeoutMs) throw new Error('DAW: render timed out; try a shorter project')
  }
  const cleanup = () => {
    if (disposed) return
    disposed = true
    for (const node of nodes) { try { node.disconnect() } catch { /* Already disconnected. */ } }
  }
  try {
    context = new OfflineAudioContextClass(2, plan.frames, plan.sampleRate)
    const master = context.createGain(); nodes.push(master)
    master.gain.setValueAtTime(plan.masterGain, 0); master.connect(context.destination)
    for (const track of plan.tracks) {
      const gain = context.createGain(), pan = context.createStereoPanner(); nodes.push(gain, pan)
      gain.gain.setValueAtTime(track.gain, 0)
      pan.pan.setValueAtTime(track.pan, 0)
      // Preserve stereo sources; the panner uses the Web Audio equal-power law.
      gain.connect(pan); pan.connect(master)
      for (const clip of track.clips) {
        checkCurrent(signal, isCurrent)
        const source = context.createBufferSource(), clipGain = context.createGain(), automationGain = context.createGain(); nodes.push(source, clipGain, automationGain)
        source.buffer = buffers.get(clip.assetId)
        for (let index = 0; index < clip.envelope.length; index++) {
          const point = clip.envelope[index], at = clip.atSeconds + point.timeSeconds
          if (index === 0) clipGain.gain.setValueAtTime(point.value * clip.gain, at)
          else clipGain.gain.linearRampToValueAtTime(point.value * clip.gain, at)
        }
        // Multiply curves in separate nodes: merging their points would replace
        // the product of two ramps with an incorrect straight interpolation.
        for (let index = 0; index < clip.automation.length; index++) {
          const point = clip.automation[index], at = clip.atSeconds + point.timeSeconds
          if (index === 0) automationGain.gain.setValueAtTime(point.value, at)
          else automationGain.gain.linearRampToValueAtTime(point.value, at)
        }
        source.connect(clipGain); clipGain.connect(automationGain); automationGain.connect(gain)
        source.start(clip.atSeconds, clip.offsetSeconds, clip.durationSeconds)
      }
    }
    pendingNativeBytes = plan.renderBytes + plan.decodedBytes
    nativePromise = Promise.resolve(context.startRendering()).finally(() => {
      nativeSettled = true
      if (operationFinished) { activeContext = false; pendingNativeBytes = 0 }
      cleanup()
    })
    const interrupted = new Promise((_, reject) => {
      abortHandler = () => { cleanup(); reject(abortError()) }
      signal?.addEventListener('abort', abortHandler, { once: true })
      if (signal?.aborted) abortHandler()
      timer = setTimeout(() => {
        cleanup(); reject(new Error('DAW: render timed out; try a shorter project'))
      }, timeoutMs)
    })
    const buffer = await Promise.race([nativePromise, interrupted])
    checkJob()
    if (!buffer || buffer.sampleRate !== plan.sampleRate || buffer.numberOfChannels !== 2 || buffer.length !== plan.frames) {
      throw new Error('DAW: browser returned an invalid mix buffer')
    }
    const channels = Array.from({ length: 2 }, (_, channel) => buffer.getChannelData(channel))
    let peak = 0, clippedSamples = 0
    // Yield while scanning PCM so cancellation/new edits can be observed.
    for (let base = 0; base < buffer.length; base += 262144) {
      checkJob()
      for (const data of channels) {
        for (let index = base; index < Math.min(base + 262144, data.length); index++) {
          const value = data[index]
          if (!Number.isFinite(value)) throw new Error('DAW: render contains non-finite samples')
          const absolute = Math.abs(value)
          peak = Math.max(peak, absolute)
          if (absolute > 1) clippedSamples++
        }
      }
      if (base + 262144 < buffer.length) await new Promise(resolve => setTimeout(resolve, 0))
    }
    checkJob()
    // Reuse the application's documented finite-buffer 4x true-peak estimate.
    const peaks = measurePeaks(channels)
    // Give queued Cancel/edit events a turn before accepting a synchronous peak scan.
    await new Promise(resolve => setTimeout(resolve, 0))
    checkJob()
    return { buffer, plan, revision: plan.revision, peak, clippedSamples, peaks }
  } finally {
    clearTimeout(timer)
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    operationFinished = true
    if (!nativePromise || nativeSettled) { pendingNativeBytes = 0; activeContext = false; cleanup() }
  }
}
