import { validateProject, validateTimelineSelection, getProjectDuration, DAW_LIMITS } from './project.js'
import { sourceFrameBounds } from './sample-bounds.js'
import { buildRenderPlan, abortError } from './render.js'
import { measurePeaks } from '../audio/measure.js'

const fail = message => { throw new Error(`DAW: ${message}`) }
function checkCurrent(signal, isCurrent) {
  if (signal?.aborted || (isCurrent && !isCurrent())) throw abortError('DAW selected range cancelled or superseded')
}

/** Output-frame coverage of the saved half-open [startSeconds,endSeconds).
 * Exact frame edges survive floating-point roundoff; genuine fractional edges
 * cover [floor(start * rate), ceil(end * rate)). No clip/source timing changes.
 * Silent timeline gaps are valid. There must be at least one covered frame. */
export function timelineSelectionFrameBounds(project) {
  validateProject(project)
  if (!project.timelineSelection) fail('select a timeline range first')
  const { startSeconds, endSeconds } = project.timelineSelection
  const { first, last } = sourceFrameBounds(startSeconds, endSeconds - startSeconds, project.sampleRate)
  return { firstFrame: first, lastFrame: last, length: last - first, sampleRate: project.sampleRate,
    startSeconds: first / project.sampleRate, endSeconds: last / project.sampleRate,
    durationSeconds: (last - first) / project.sampleRate }
}

/** Reuse the actual full mix; no second renderer, PCM copy or resampling.
 *
 * `buffer` is STILL the full AudioBuffer. Audition must start it at startSeconds
 * for durationSeconds, or loop at startSeconds/endSeconds. WAV must use channels
 * and length, not buffer.length. Both paths refer to exactly [firstFrame,lastFrame).
 * The typed arrays are read-only shared views by convention: callers must not
 * mutate them or retain them after releasing the full mix cache.
 *
 * peak/clippedSamples/peaks describe ONLY this range, with the same finite-buffer
 * 4x true-peak estimate as full rendering, including its new cut/EOF edges. Full
 * mix overload elsewhere does not block a quiet range. This measurement never
 * normalizes, clips, applies fades, or hides an overload inside the selection.
 *
 * The project ID, revision, complete render recipe and buffer dimensions must
 * match. isCurrent remains required at integration sites to reject navigation
 * and replacement jobs; checks bracket every yield and synchronous peak scan.
 * Full native render/decoded budgets are enforced even for a tiny selection.
 * Callers separately budget WAV allocation; shared views allocate no PCM. */
export async function selectedRenderView(project, rendered, { signal, isCurrent } = {}) {
  checkCurrent(signal, isCurrent)
  const bounds = timelineSelectionFrameBounds(project)
  const expectedPlan = buildRenderPlan(project)
  const projectId = project.id, revision = project.revision
  const selection = { ...project.timelineSelection }
  const planJson = JSON.stringify(expectedPlan)
  const buffer = rendered?.buffer
  if (!rendered || rendered.revision !== revision || JSON.stringify(rendered.plan) !== planJson) {
    fail('selected range requires the current full project render')
  }
  if (!buffer || typeof buffer.getChannelData !== 'function' || buffer.sampleRate !== expectedPlan.sampleRate ||
      buffer.numberOfChannels !== expectedPlan.channels || buffer.length !== expectedPlan.frames ||
      !Number.isFinite(buffer.duration) || Math.abs(buffer.duration - buffer.length / buffer.sampleRate) > Number.EPSILON * Math.max(1, buffer.duration) * 4) {
    fail('selected range requires a valid full mix buffer')
  }
  if (bounds.firstFrame < 0 || bounds.lastFrame > buffer.length || bounds.length < 1 ||
      bounds.length * buffer.numberOfChannels * 4 > DAW_LIMITS.maxRenderBytes) fail('selected range exceeds the rendered mix bounds')

  const check = () => {
    checkCurrent(signal, isCurrent)
    if (project.id !== projectId || project.revision !== revision ||
        project.timelineSelection?.startSeconds !== selection.startSeconds || project.timelineSelection?.endSeconds !== selection.endSeconds) throw abortError()
  }
  // Check cancellation before reading source channels or creating any views.
  check()
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => {
    check()
    const data = buffer.getChannelData(index)
    if (!(data instanceof Float32Array) || data.length !== buffer.length) fail('selected range received an invalid mix channel')
    check()
    return data.subarray(bounds.firstFrame, bounds.lastFrame)
  })
  let peak = 0, clippedSamples = 0
  for (let base = 0; base < bounds.length; base += 262144) {
    check()
    const end = Math.min(base + 262144, bounds.length)
    for (const data of channels) for (let index = base; index < end; index++) {
      const value = data[index]
      if (!Number.isFinite(value)) fail('selected range contains non-finite samples')
      const absolute = Math.abs(value)
      peak = Math.max(peak, absolute)
      if (absolute > 1) clippedSamples++
    }
    if (end < bounds.length) await new Promise(resolve => setTimeout(resolve, 0))
  }
  check()
  const peaks = measurePeaks(channels)
  // A queued Cancel/edit must win even when it arrived during peak measurement.
  await new Promise(resolve => setTimeout(resolve, 0))
  check()
  // Also catch in-place edits and same-revision undo branches while measuring.
  validateTimelineSelection(selection, getProjectDuration(project), project.sampleRate)
  if (JSON.stringify(buildRenderPlan(project)) !== planJson) throw abortError()
  return { buffer, channels, projectId, revision, selection, ...bounds, peak, clippedSamples, peaks }
}
