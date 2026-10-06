/** Convert source seconds to covering sample bounds without letting binary
 * roundoff invent a frame. Division, addition and multiplication can put an
 * exact sample boundary a few machine epsilons to either side of its integer.
 * Clip offsets can also come from subtracting positions near the 600-second
 * timeline limit, so the error bound must include that arithmetic scale even
 * when the resulting source offset itself is small.
 * This is a relative floating-point allowance, not a time/sample grid: real
 * fractional coordinates outside it still use floor/ceil, never rounding.
 * At the DAW maximum (600 s / 96 kHz) it is < 0.000000052 sample. */
export const SOURCE_TIME_ROUNDOFF_SECONDS = 4 * Number.EPSILON * 600

function sampleCoordinate(seconds, sampleRate) {
  const value = seconds * sampleRate, nearest = Math.round(value)
  const tolerance = Math.max(4 * Number.EPSILON * Math.max(1, Math.abs(value)), SOURCE_TIME_ROUNDOFF_SECONDS * sampleRate)
  return Math.abs(value - nearest) <= tolerance ? nearest : value
}

export function sourceFrameBounds(offsetSeconds, durationSeconds, sampleRate) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new RangeError('Invalid source sample interval')
  const start = sampleCoordinate(offsetSeconds, sampleRate)
  const end = sampleCoordinate(offsetSeconds + durationSeconds, sampleRate)
  const first = Math.floor(start), last = Math.ceil(end)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) throw new RangeError('Source sample interval is too large')
  // A snapped start has zero residual, including when offsetSeconds was a
  // subtraction such as .35 - .25. Raw subtraction would produce a tiny
  // negative value and invalidate an otherwise valid replacement. The recipe
  // still stores the exact original seconds for bit-identical recovery.
  const fractionSeconds = start === first ? 0 : offsetSeconds - first / sampleRate
  return { first, last, offsetSeconds: fractionSeconds }
}
