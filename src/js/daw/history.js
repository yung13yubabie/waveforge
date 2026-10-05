// DAW undo stores bounded, immutable JSON metadata only. Original Blobs and
// AudioBuffers live outside this class; retainedAssetIds() supports safe GC.
import { validateProject } from './project.js'

export const HISTORY_LIMITS = Object.freeze({ snapshots: 100, bytes: 8 * 1024 * 1024, snapshotBytes: 1024 * 1024 })

/** Reject runtime objects instead of silently discarding audio during JSON.stringify. */
export function cloneProjectMetadata(project) {
  const seen = new Set()
  let nodes = 0
  function visit(value, depth = 0) {
    if (++nodes > 100000 || depth > 32) throw new Error('Project metadata is too complex')
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return
    if (typeof value === 'number' && Number.isFinite(value)) return
    if (typeof value !== 'object' || seen.has(value)) throw new Error('Project must contain JSON metadata only')
    const prototype = Object.getPrototypeOf(value)
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('Audio, files and runtime objects cannot be stored in project metadata')
    }
    seen.add(value)
    for (const key of Object.keys(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe project metadata key')
      visit(value[key], depth + 1)
    }
    seen.delete(value)
  }
  visit(project)
  const serialized = JSON.stringify(project)
  if (new TextEncoder().encode(serialized).length > HISTORY_LIMITS.snapshotBytes) {
    throw new Error('Project metadata exceeds the 1 MiB limit')
  }
  const copy = JSON.parse(serialized)
  validateProject(copy)
  return copy
}

export class ProjectHistory {
  constructor(initial, { limit = HISTORY_LIMITS.snapshots, maxBytes = HISTORY_LIMITS.bytes } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_LIMITS.snapshots) throw new Error('Invalid history limit')
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HISTORY_LIMITS.bytes) throw new Error('Invalid history byte limit')
    this._limit = limit
    this._maxBytes = maxBytes
    this._stack = []
    this._index = -1
    this.reset(initial)
  }

  get canUndo() { return this._index > 0 }
  get canRedo() { return this._index >= 0 && this._index < this._stack.length - 1 }
  get length() { return this._stack.length }
  get current() { return this._index < 0 ? null : JSON.parse(this._stack[this._index].json) }
  get bytes() { return this._stack.reduce((sum, item) => sum + item.bytes, 0) }

  _entry(project) {
    const json = JSON.stringify(cloneProjectMetadata(project))
    const bytes = new TextEncoder().encode(json).length
    if (bytes > this._maxBytes) throw new Error('Project exceeds the history memory budget')
    return { json, bytes }
  }

  push(project) {
    const entry = this._entry(project) // Validate before touching the current branch.
    if (this._stack[this._index]?.json === entry.json) return this.current
    const next = this._stack.slice(0, this._index + 1)
    next.push(entry)
    let size = next.reduce((sum, item) => sum + item.bytes, 0)
    while (next.length > this._limit || size > this._maxBytes) size -= next.shift().bytes
    this._stack = next
    this._index = next.length - 1
    return this.current
  }

  undo() { if (!this.canUndo) return null; this._index--; return this.current }
  redo() { if (!this.canRedo) return null; this._index++; return this.current }

  reset(initial) {
    const entries = initial === undefined ? [] : [this._entry(initial)]
    this._stack = entries
    this._index = entries.length - 1
    return this.current
  }

  retainedAssetIds() {
    const ids = new Set()
    for (const { json } of this._stack) for (const asset of JSON.parse(json).assets) ids.add(asset.id)
    return ids
  }
}
