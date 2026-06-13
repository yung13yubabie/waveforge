// Fixed-capacity ring buffer of loudness samples for the scrolling history
// graph (short-term LUFS over time, à la Youlean / iZotope Insight). Pure &
// testable — the canvas renderer (ui/loudness-graph.js) just plots toArray().

export class LoudnessHistory {
  constructor(capacity = 600) {
    this.capacity = Math.max(1, capacity | 0)
    this._buf = new Float32Array(this.capacity)
    this._len = 0
    this._head = 0 // index of the oldest sample
  }

  // Non-finite values (−Infinity on silence) are stored as NaN so the renderer
  // can draw a gap rather than a spike to the floor.
  push(v) {
    const x = Number.isFinite(v) ? v : NaN
    if (this._len < this.capacity) {
      this._buf[(this._head + this._len) % this.capacity] = x
      this._len++
    } else {
      this._buf[this._head] = x
      this._head = (this._head + 1) % this.capacity
    }
  }

  toArray() {
    const out = new Array(this._len)
    for (let i = 0; i < this._len; i++) {
      out[i] = this._buf[(this._head + i) % this.capacity]
    }
    return out
  }

  get length() { return this._len }

  clear() { this._len = 0; this._head = 0 }
}

/**
 * Map a LUFS value to a canvas y coordinate (top = max, bottom = min).
 * @returns {number|null} y, or null when the value is a silence gap.
 */
export function lufsToY(lufs, { min = -40, max = 0, height }) {
  if (!Number.isFinite(lufs)) return null
  const clamped = Math.max(min, Math.min(max, lufs))
  return height * (1 - (clamped - min) / (max - min))
}
