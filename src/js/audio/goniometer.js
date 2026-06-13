// Goniometer (vectorscope) coordinate math — pure & testable.
//
// Plots stereo L/R as a Lissajous figure rotated 45° (the broadcast/mastering
// convention), so the operator reads stereo image at a glance:
//   mono (L=R)        → vertical line   (x ≈ 0)
//   anti-phase (L=-R) → horizontal line (y ≈ 0)  ← mono-compatibility hazard
//   left only         → upper-left diagonal  (x < 0, y > 0)
//   right only        → upper-right diagonal (x > 0, y > 0)
//
// Coordinates are in audio units: a full-scale single channel lands at radius 1
// on its diagonal; in-phase mono can extend to √2 (the renderer clips to view).

const SQRT1_2 = Math.SQRT1_2 // 1/√2

/**
 * @param {number} l  left sample  (−1..1)
 * @param {number} r  right sample (−1..1)
 * @returns {{x:number, y:number}} side (x, + = right) and mid (y, + = in-phase up)
 */
export function scopePoint(l, r) {
  return {
    x: (r - l) * SQRT1_2, // side: difference → horizontal spread
    y: (l + r) * SQRT1_2, // mid:  sum        → vertical (in-phase = up)
  }
}

/**
 * Decimate a stereo frame to at most `maxPoints` scope points for cheap drawing.
 * @param {Float32Array|number[]} left
 * @param {Float32Array|number[]} right
 * @param {number} [maxPoints=1024]
 * @returns {{x:number, y:number}[]}
 */
export function scopePoints(left, right, maxPoints = 1024) {
  const n = Math.min(left.length, right.length)
  if (n === 0) return []
  const step = Math.max(1, Math.floor(n / maxPoints))
  const pts = []
  for (let i = 0; i < n; i += step) pts.push(scopePoint(left[i], right[i]))
  return pts
}
