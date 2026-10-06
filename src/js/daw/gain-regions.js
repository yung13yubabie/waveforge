/** Clip-local attenuation of user-designated, already isolated audio. No PCM
 * copies or separation inference. Inputs are validated by project.js. */
const copyPoints = points => points.map(point => ({ ...point }))
const boundedGain = value => Math.max(0, Math.min(1, value))

function valueAt(points, seconds) {
  if (seconds <= points[0].timeSeconds) return points[0].value
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1], right = points[index]
    if (seconds <= right.timeSeconds) return left.value + (right.value - left.value) * (seconds - left.timeSeconds) / (right.timeSeconds - left.timeSeconds)
  }
  return points.at(-1).value
}

/** Strength, not amplitude, keeps partially consumed fades editable even when
 * the region gain changes to unity and back. Zero fades are intentional steps. */
export function getGainRegionAttenuationEnvelope(region) {
  if (region.attenuationEnvelope) return copyPoints(region.attenuationEnvelope)
  const duration = region.endSeconds - region.startSeconds
  const points = [{ timeSeconds: 0, value: region.fadeInSeconds > 0 ? 0 : 1 }]
  if (region.fadeInSeconds > 0) points.push({ timeSeconds: region.fadeInSeconds, value: 1 })
  const fadeOutStart = duration - region.fadeOutSeconds
  if (region.fadeOutSeconds > 0 && fadeOutStart > points.at(-1).timeSeconds) points.push({ timeSeconds: fadeOutStart, value: 1 })
  if (duration > points.at(-1).timeSeconds) points.push({ timeSeconds: duration, value: region.fadeOutSeconds > 0 ? 0 : 1 })
  return points
}

export function getGainRegionEnvelope(region) {
  return getGainRegionAttenuationEnvelope(region).map(point => ({ timeSeconds: point.timeSeconds, value: boundedGain(1 - (1 - region.gain) * point.value) }))
}

/** Drop regions outside the cut; retain IDs and exact boundary strengths. */
export function sliceGainRegions(regions, start, end) {
  return regions.flatMap(region => {
    const from = Math.max(start, region.startSeconds), to = Math.min(end, region.endSeconds)
    if (to <= from) return []
    // Preserve untouched regions without introducing derived metadata.
    if (from === region.startSeconds && to === region.endSeconds) {
      const startSeconds = from - start, endSeconds = to - start, duration = endSeconds - startSeconds
      return [{ ...region, startSeconds, endSeconds,
        fadeInSeconds: Math.min(duration, region.fadeInSeconds), fadeOutSeconds: Math.min(duration, region.fadeOutSeconds),
        ...(region.attenuationEnvelope ? { attenuationEnvelope: region.attenuationEnvelope.map((point, index, points) => ({ ...point,
          timeSeconds: index === points.length - 1 ? duration : point.timeSeconds })) } : {}) }]
    }
    const points = getGainRegionAttenuationEnvelope(region), localStart = from - region.startSeconds, localEnd = to - region.startSeconds
    const startSeconds = from - start, endSeconds = to - start, duration = endSeconds - startSeconds
    return [{ ...region, startSeconds, endSeconds,
      fadeInSeconds: Math.min(duration, Math.max(0, region.fadeInSeconds - localStart)),
      fadeOutSeconds: Math.min(duration, Math.max(0, localEnd - (region.endSeconds - region.startSeconds - region.fadeOutSeconds))),
      attenuationEnvelope: [{ timeSeconds: 0, value: boundedGain(valueAt(points, localStart)) },
        ...points.filter(point => point.timeSeconds > localStart && point.timeSeconds < localEnd)
          .map(point => ({ ...point, timeSeconds: point.timeSeconds - localStart })),
        { timeSeconds: duration, value: boundedGain(valueAt(points, localEnd)) }],
    }]
  })
}

const segmentValueAt = (segment, seconds) => boundedGain(segment.startGain + (segment.endGain - segment.startGain) * (seconds - segment.startSeconds) / (segment.endSeconds - segment.startSeconds))
function append(segments, startSeconds, endSeconds, startGain, endGain) {
  if (endSeconds <= startSeconds) return
  const previous = segments.at(-1)
  // Coalescing only exactly equal constants cannot flatten any boundary ramp.
  if (previous && previous.endSeconds === startSeconds && previous.startGain === previous.endGain && previous.endGain === startGain && startGain === endGain) previous.endSeconds = endSeconds
  else segments.push({ startSeconds, endSeconds, startGain, endGain })
}
function regionSegments(region, duration) {
  const segments = [], points = getGainRegionEnvelope(region)
  append(segments, 0, region.startSeconds, 1, 1)
  for (let index = 1; index < points.length; index++) {
    const left = points[index - 1], right = points[index]
    // Use the stored endpoint exactly to keep adjacent regions sample-aligned.
    append(segments, region.startSeconds + left.timeSeconds,
      index === points.length - 1 ? region.endSeconds : region.startSeconds + right.timeSeconds, left.value, right.value)
  }
  append(segments, region.endSeconds, duration, 1, 1)
  return segments
}
function lowerEnvelope(left, right) {
  const result = []
  let a = 0, b = 0
  while (a < left.length && b < right.length) {
    const first = left[a], second = right[b]
    const start = Math.max(first.startSeconds, second.startSeconds), end = Math.min(first.endSeconds, second.endSeconds)
    if (end > start) {
      const a0 = segmentValueAt(first, start), a1 = segmentValueAt(first, end)
      const b0 = segmentValueAt(second, start), b1 = segmentValueAt(second, end)
      const d0 = a0 - b0, d1 = a1 - b1
      // Opposing slopes may exchange the minimum between stored breakpoints.
      // Insert the exact crossing instead of drawing an incorrect straight line.
      const crossing = d0 * d1 < 0 ? start + (end - start) * d0 / (d0 - d1) : start
      if (crossing > start && crossing < end) {
        const gain = Math.min(segmentValueAt(first, crossing), segmentValueAt(second, crossing))
        append(result, start, crossing, Math.min(a0, b0), gain)
        append(result, crossing, end, gain, Math.min(a1, b1))
      } else append(result, start, end, Math.min(a0, b0), Math.min(a1, b1))
    }
    if (first.endSeconds <= second.endSeconds) a++
    if (second.endSeconds <= first.endSeconds) b++
  }
  return result
}

/** Compile once per clip, never per sample. Overlaps choose the lowest gain,
 * with unity outside half-open [start,end) regions. Steps are represented by
 * differing adjacent endpoint gains, so touching regions do not invent gaps.
 * At most 64 regions with four saved points each: time/storage are bounded by
 * their segment intersections, independent of PCM length and sample rate. */
export function getClipGainRegionSegments(clip) {
  let segments = [{ startSeconds: 0, endSeconds: clip.durationSeconds, startGain: 1, endGain: 1 }]
  for (const region of clip.gainRegions ?? []) segments = lowerEnvelope(segments, regionSegments(region, clip.durationSeconds))
  return segments
}
