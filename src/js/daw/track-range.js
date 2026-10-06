import { SOURCE_TIME_ROUNDOFF_SECONDS } from './sample-bounds.js'

/** Shared half-open timeline geometry. Callers validate the project and range
 * before this helper; no source-clock, subtitle, gain or PCM policy belongs here. */
export function intersectTrackRange(track, startSeconds, endSeconds) {
  const intersections = [], coverage = []
  for (const clip of track.clips) {
    const clipEnd = clip.atSeconds + clip.durationSeconds
    const start = Math.max(startSeconds, clip.atSeconds), end = Math.min(endSeconds, clipEnd)
    if (end - start <= SOURCE_TIME_ROUNDOFF_SECONDS) continue
    intersections.push({ clipId: clip.id,
      startSeconds: start === clip.atSeconds ? 0 : start - clip.atSeconds,
      endSeconds: end === clipEnd ? clip.durationSeconds : end - clip.atSeconds })
    coverage.push({ startSeconds: start, endSeconds: end })
  }
  coverage.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds)
  const gaps = []
  let cursor = startSeconds, coveredDurationSeconds = 0
  for (const interval of coverage) {
    if (interval.startSeconds - cursor > SOURCE_TIME_ROUNDOFF_SECONDS) gaps.push({ startSeconds: cursor, endSeconds: interval.startSeconds })
    coveredDurationSeconds += Math.max(0, interval.endSeconds - Math.max(cursor, interval.startSeconds))
    cursor = Math.max(cursor, interval.endSeconds)
  }
  if (endSeconds - cursor > SOURCE_TIME_ROUNDOFF_SECONDS) gaps.push({ startSeconds: cursor, endSeconds })
  return { intersections, gaps, coveredDurationSeconds, completeCoverage: gaps.length === 0 }
}
