import { DAW_LIMITS } from './project.js'

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
const finite = (value, label, min = -Infinity, max = Infinity) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`DAW: invalid ${label}`)
  }
  return value
}
const clamp = (seconds, maximum) => Math.max(0, Math.min(maximum, seconds))

/** Legacy projects omit this field. An inherited value is never saved metadata.
 * The origin is independent of clip duration so deleting audio keeps its phase. */
export function getDawGridOrigin(project) {
  return own(project, 'gridOriginSeconds')
    ? finite(project.gridOriginSeconds, 'grid origin', 0, DAW_LIMITS.maxDurationSeconds) : 0
}

/** BPM and grid divisions are quarter-note units, regardless of time signature.
 * This is timeline geometry only: it never quantizes source samples or audio. */
export function dawGridStepSeconds(tempo, beats = 1) {
  finite(tempo, 'grid tempo', 20, 300)
  finite(beats, 'grid division', Number.MIN_VALUE)
  return finite(60 / tempo * beats, 'grid step', Number.MIN_VALUE)
}

function bounds(seconds, originSeconds, maxSeconds) {
  finite(seconds, 'grid time')
  finite(originSeconds, 'grid origin', 0, DAW_LIMITS.maxDurationSeconds)
  finite(maxSeconds, 'grid maximum', 0, DAW_LIMITS.maxDurationSeconds)
  return seconds
}

function gridIndex(time, origin, step) {
  return finite((time - origin) / step, 'grid resolution', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
}

/** Nearest boundary on origin + n * step, including boundaries before origin.
 * Disabled snapping preserves the existing absolute 1 ms placement behavior.
 * A caller can bound clip starts by 600 - clip duration, or cursors by duration. */
export function snapDawGridTime(seconds, tempo, beats = 1, enabled = true, originSeconds = 0, maxSeconds = DAW_LIMITS.maxDurationSeconds) {
  const time = bounds(seconds, originSeconds, maxSeconds)
  const step = enabled ? dawGridStepSeconds(tempo, beats) : .001
  const origin = enabled ? originSeconds : 0
  // Dragging against/beyond the project start must stay at zero, even if the
  // first positive grid line happens to be closer than a negative grid line.
  if (time <= 0) return 0
  return clamp(origin + Math.round(gridIndex(time, origin, step)) * step, maxSeconds)
}

/** Move strictly to the next boundary in direction -1 or +1, then clamp.
 * Off-grid positions go to the immediate boundary; on-grid positions advance
 * one division. Only floating-point roundoff is treated as already on-grid. */
export function nextDawGridTime(seconds, direction, tempo, beats = 1, originSeconds = 0, maxSeconds = DAW_LIMITS.maxDurationSeconds) {
  const time = clamp(bounds(seconds, originSeconds, maxSeconds), maxSeconds)
  if (direction !== -1 && direction !== 1) throw new Error('DAW: grid direction must be -1 or 1')
  const step = dawGridStepSeconds(tempo, beats)
  const index = gridIndex(time, originSeconds, step)
  const nearest = Math.round(index)
  const nearestTime = originSeconds + nearest * step
  const tolerance = 8 * Number.EPSILON * Math.max(1, time, originSeconds, Math.abs(nearest * step))
  const onGrid = Math.abs(time - nearestTime) <= tolerance
  const next = onGrid ? nearest + direction : direction > 0 ? Math.floor(index) + 1 : Math.ceil(index) - 1
  return clamp(originSeconds + next * step, maxSeconds)
}
