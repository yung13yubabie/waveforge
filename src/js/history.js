// Undo/redo history — a linear stack with a cursor. Stores opaque state
// snapshots (engine.serialize() objects); pushing after an undo truncates the
// redo branch. Pure + testable. Caller debounces/dedupes edit gestures.

export class History {
  constructor(initial, limit = 100) {
    this._stack = initial !== undefined ? [initial] : []
    this._index = this._stack.length - 1
    this._limit = limit
  }

  get canUndo() { return this._index > 0 }
  get canRedo() { return this._index < this._stack.length - 1 }
  get current() { return this._stack[this._index] ?? null }
  get length() { return this._stack.length }

  push(state) {
    // discard any redo branch, then append
    this._stack = this._stack.slice(0, this._index + 1)
    this._stack.push(state)
    if (this._stack.length > this._limit) this._stack.shift()  // cap oldest
    this._index = this._stack.length - 1
  }

  undo() {
    if (!this.canUndo) return null
    this._index--
    return this._stack[this._index]
  }

  redo() {
    if (!this.canRedo) return null
    this._index++
    return this._stack[this._index]
  }

  reset(initial) {
    this._stack = initial !== undefined ? [initial] : []
    this._index = this._stack.length - 1
  }
}
