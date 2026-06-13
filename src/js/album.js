// Album assembly data model — an ordered list of tracks for sequencing into a
// DDP master. Each track keeps its own chain snapshot (per-track mastering),
// a gain trim and a pre-gap. Pure + testable; the panel UI wires onto it.

export class Album {
  constructor() {
    this._tracks = []
    this._nextId = 1
  }

  get tracks() { return this._tracks }
  get length() { return this._tracks.length }

  // t: { title, file, snapshot, lufs, gainTrimDb?, gapBeforeSec?, isrc?, title? }
  add(t = {}) {
    const track = {
      id: this._nextId++,
      title: t.title ?? 'Untitled',
      file: t.file ?? null,            // File ref; decoded lazily at render time
      snapshot: t.snapshot ?? null,    // engine.serialize() at add time
      lufs: t.lufs ?? null,            // source integrated LUFS (informational)
      gainTrimDb: t.gainTrimDb ?? 0,
      gapBeforeSec: t.gapBeforeSec ?? 2,
      isrc: t.isrc ?? '',
    }
    this._tracks.push(track)
    return track
  }

  remove(id) {
    const i = this._tracks.findIndex(t => t.id === id)
    if (i < 0) return false
    this._tracks.splice(i, 1)
    return true
  }

  // delta: -1 = up (earlier), +1 = down (later)
  move(id, delta) {
    const i = this._tracks.findIndex(t => t.id === id)
    if (i < 0) return false
    const j = i + delta
    if (j < 0 || j >= this._tracks.length) return false
    const [t] = this._tracks.splice(i, 1)
    this._tracks.splice(j, 0, t)
    return true
  }

  update(id, patch) {
    const t = this._tracks.find(t => t.id === id)
    if (!t) return false
    Object.assign(t, patch)
    return true
  }

  get(id) { return this._tracks.find(t => t.id === id) ?? null }

  clear() { this._tracks = [] }
}

// Suggested per-track gain trim (dB) to move a measured loudness toward a
// target — the starting point for the hybrid loudness workflow (user then
// fine-tunes by ear). Clamped to ±maxDb; silent/invalid input → 0.
export function loudnessTrim(measuredLufs, targetLufs, maxDb = 12) {
  if (!Number.isFinite(measuredLufs) || !Number.isFinite(targetLufs)) return 0
  const delta = targetLufs - measuredLufs
  const clamped = Math.max(-maxDb, Math.min(maxDb, delta))
  return Math.round(clamped * 10) / 10
}
