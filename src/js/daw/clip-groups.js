import { DAW_LIMITS, describeClipGroup, getProjectDuration } from './project.js'
import { getDawGridOrigin, snapDawGridTime, nextDawGridTime } from './grid.js'

export { describeClipGroup, getClipGroupOverlaps } from './project.js'

/** Place the entire group after all existing audio. The earliest selected
 * start is the anchor; every member receives exactly the same delta. With
 * snapping enabled, use the first shifted grid line at/after project end.
 * Without snapping, keep the exact endpoint (never round backwards to 1 ms).
 * Planning allocates neither clip IDs nor media and never changes the project. */
export function planClipGroupDuplicate(project, refs, options = {}) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype ||
      Reflect.ownKeys(options).some(key => !['snapEnabled', 'gridBeats'].includes(key) ||
        !Object.getOwnPropertyDescriptor(options, key).enumerable || !('value' in Object.getOwnPropertyDescriptor(options, key)))) {
    throw new Error('DAW: invalid clip group duplicate options')
  }
  const { snapEnabled = false, gridBeats = 1 } = options
  if (typeof snapEnabled !== 'boolean' || typeof gridBeats !== 'number' || !Number.isFinite(gridBeats) || gridBeats <= 0) {
    throw new Error('DAW: invalid clip group snapping')
  }
  const group = describeClipGroup(project, refs), projectEnd = getProjectDuration(project)
  if (project.tracks.reduce((count, track) => count + track.clips.length, 0) + group.count > DAW_LIMITS.maxClips) {
    throw new Error('DAW: project exceeds 256 clips')
  }
  let atSeconds = projectEnd
  if (snapEnabled) {
    const origin = getDawGridOrigin(project)
    atSeconds = snapDawGridTime(projectEnd, project.tempo, gridBeats, true, origin)
    const tolerance = 8 * Number.EPSILON * Math.max(1, projectEnd, origin)
    if (atSeconds < projectEnd - tolerance) atSeconds = nextDawGridTime(projectEnd, 1, project.tempo, gridBeats, origin)
    // A boundary represented just below the endpoint must not place audio
    // before it. This adjusts only arithmetic roundoff, never a real gap.
    atSeconds = Math.max(projectEnd, atSeconds)
  }
  let deltaSeconds = atSeconds - group.startSeconds
  // Subtracting the group start and then adding it back can land one ULP
  // before the requested boundary. Advance the one shared delta by bounded
  // arithmetic roundoff; never adjust individual clip positions or sources.
  if (group.startSeconds + deltaSeconds < atSeconds) {
    deltaSeconds += Number.EPSILON * Math.max(1, atSeconds, deltaSeconds)
  }
  atSeconds = group.startSeconds + deltaSeconds
  if (!Number.isFinite(deltaSeconds) || deltaSeconds > group.maxDeltaSeconds) {
    throw new Error('DAW: copied clip group would exceed 600 seconds')
  }
  return { ...group, atSeconds, deltaSeconds }
}
