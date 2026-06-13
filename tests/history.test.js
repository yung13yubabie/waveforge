import { describe, it, expect } from 'vitest'
import { History } from '../src/js/history.js'

describe('History', () => {
  it('seeds with an initial state; cannot undo/redo at start', () => {
    const h = new History('s0')
    expect(h.current).toBe('s0')
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.length).toBe(1)
  })

  it('push then undo returns the previous state', () => {
    const h = new History('s0')
    h.push('s1')
    expect(h.current).toBe('s1')
    expect(h.canUndo).toBe(true)
    expect(h.undo()).toBe('s0')
    expect(h.current).toBe('s0')
  })

  it('redo re-applies an undone state', () => {
    const h = new History('s0')
    h.push('s1'); h.undo()
    expect(h.canRedo).toBe(true)
    expect(h.redo()).toBe('s1')
    expect(h.canRedo).toBe(false)
  })

  it('pushing after an undo truncates the redo branch', () => {
    const h = new History('s0')
    h.push('s1'); h.push('s2')
    h.undo()              // back to s1
    expect(h.canRedo).toBe(true)
    h.push('s3')          // new branch — s2 is gone
    expect(h.canRedo).toBe(false)
    expect(h.current).toBe('s3')
    expect(h.undo()).toBe('s1')
  })

  it('undo at the start / redo at the end return null', () => {
    const h = new History('s0')
    expect(h.undo()).toBeNull()
    h.push('s1')
    expect(h.redo()).toBeNull()
  })

  it('caps the stack at the limit, dropping the oldest', () => {
    const h = new History('s0', 3)
    h.push('s1'); h.push('s2'); h.push('s3')   // stack now [s1,s2,s3] (s0 dropped)
    expect(h.length).toBe(3)
    // undo all the way → oldest reachable is s1, not s0
    expect(h.undo()).toBe('s2')
    expect(h.undo()).toBe('s1')
    expect(h.canUndo).toBe(false)
  })

  it('reset re-seeds and clears history', () => {
    const h = new History('s0')
    h.push('s1'); h.push('s2')
    h.reset('new')
    expect(h.current).toBe('new')
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.length).toBe(1)
  })
})
