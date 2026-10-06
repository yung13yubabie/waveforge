/** Tap timing only: no audio detection, resampling, project edits, or timers. */
export const TAP_TEMPO_LIMITS = Object.freeze({
  minTempo: 20, maxTempo: 300, minTaps: 5, maxTaps: 32,
  repeatGuardMs: 120, resetGapMs: 4500,
})

const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const withinRange = tempo => tempo >= TAP_TEMPO_LIMITS.minTempo && tempo <= TAP_TEMPO_LIMITS.maxTempo

/** A bounded median-based estimate with explicit refusal of irregular timing.
 * spreadMs is the observed longest-minus-shortest interval, not confidence.
 * A narrow central cluster cannot hide a missed beat or a tempo transition. */
export function estimateTapTempo(timestamps) {
  const times = Array.isArray(timestamps) ? timestamps.slice(-TAP_TEMPO_LIMITS.maxTaps) : []
  const base = { tapCount: times.length, intervalCount: Math.max(0, times.length - 1), bpm: null, spreadMs: null }
  if (!Array.isArray(timestamps) || times.some((time, index) => !Number.isFinite(time) || time < 0 || index > 0 && time <= times[index - 1])) {
    return { ...base, status: 'invalid' }
  }
  if (times.length < TAP_TEMPO_LIMITS.minTaps) return { ...base, status: 'collecting' }
  const intervals = times.slice(1).map((time, index) => time - times[index])
  const center = median(intervals), deviations = intervals.map(interval => Math.abs(interval - center))
  const spreadMs = Math.max(...intervals) - Math.min(...intervals)
  // Human jitter is allowed; large outliers, variable pacing and drift are not.
  const half = Math.floor(intervals.length / 2)
  const drift = Math.abs(median(intervals.slice(0, half)) - median(intervals.slice(-half)))
  if (median(deviations) > center * .05 || Math.max(...deviations) > center * .15 || drift > center * .08) {
    return { ...base, spreadMs, status: 'irregular' }
  }
  // Trimming only affects the estimate after the whole run passed consistency.
  const sorted = [...intervals].sort((a, b) => a - b)
  const retained = sorted.length >= 8 ? sorted.slice(1, -1) : sorted
  const intervalMs = retained.reduce((sum, interval) => sum + interval, 0) / retained.length
  const tempo = 60000 / intervalMs
  if (!withinRange(tempo)) return { ...base, spreadMs, status: 'out-of-range' }
  return { ...base, spreadMs, status: 'ready', bpm: Math.round(tempo * 10) / 10 }
}

/** Injectable monotonic clock; callers receive snapshots, never stored arrays. */
export function createTapTempo({ now = () => performance.now() } = {}) {
  if (typeof now !== 'function') throw new TypeError('Tap tempo requires a clock')
  let timestamps = []
  const getState = () => estimateTapTempo(timestamps)
  function reset() { timestamps = []; return getState() }
  function tap(timestamp = now()) {
    if (!Number.isFinite(timestamp) || timestamp < 0) return { ...getState(), ignored: 'invalid-time' }
    const previous = timestamps.at(-1)
    if (previous !== undefined) {
      const interval = timestamp - previous
      if (interval < 0 || interval > TAP_TEMPO_LIMITS.resetGapMs) {
        timestamps = [timestamp]
        return { ...getState(), resetReason: interval < 0 ? 'non-monotonic' : 'long-gap' }
      }
      // Duplicate events can share a timestamp on a precision-limited clock.
      if (interval < TAP_TEMPO_LIMITS.repeatGuardMs) return { ...getState(), ignored: 'repeat' }
    }
    timestamps.push(timestamp)
    if (timestamps.length > TAP_TEMPO_LIMITS.maxTaps) timestamps.shift()
    return getState()
  }
  return { tap, reset, getState }
}
