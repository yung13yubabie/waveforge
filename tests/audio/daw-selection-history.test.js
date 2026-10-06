// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { createClipSelectionHistory } from '../../src/js/daw/multi-clip-selection.js'

const empty = () => ({ mode: false, refs: [], primary: null })
const update = (project, name) => applyCommand(project, { type: 'project.update', patch: { name } })

describe('selection sidecar follows real bounded project history', () => {
  it('follows undo/redo keys without changing serialized project or byte accounting', () => {
    const project = createProject(), history = new ProjectHistory(project), sidecar = createClipSelectionHistory()
    const originalKey = history.currentKey, originalBytes = history.bytes
    sidecar.set(originalKey, empty())
    const edited = update(project, 'edited'); history.push(edited)
    const editedKey = history.currentKey
    sidecar.set(editedKey, { ...empty(), mode: true })
    expect(editedKey).not.toBe(originalKey)
    expect(history.undo()).toEqual(project)
    expect(history.currentKey).toBe(originalKey)
    expect(sidecar.get(history.currentKey).mode).toBe(false)
    expect(history.redo()).toEqual(edited)
    expect(sidecar.get(history.currentKey).mode).toBe(true)
    expect(history.current).not.toHaveProperty('key')
    expect(history.bytes).toBe(originalBytes + new TextEncoder().encode(JSON.stringify(edited)).length)
    const keys = history.retainedKeys; keys.length = 0
    expect(history.retainedKeys).toEqual([originalKey, editedKey])
  })
  it('prunes abandoned branches and oldest snapshots while keeping accepted undo intact', () => {
    const history = new ProjectHistory(createProject(), { limit: 3 }), sidecar = createClipSelectionHistory()
    const remember = () => { sidecar.set(history.currentKey, empty()); sidecar.prune(history.retainedKeys) }
    remember(); const first = history.currentKey
    for (let index = 0; index < 3; index++) { history.push(update(history.current, String(index))); remember() }
    expect(sidecar.get(first)).toBeNull(); expect(sidecar.size).toBe(3)
    const abandoned = history.currentKey; history.undo()
    history.push(update(history.current, 'branch')); remember()
    expect(sidecar.get(abandoned)).toBeNull(); expect(history.canRedo).toBe(false)
    expect(history.undo().name).toBe('1')
  })
  it('failed pushes and no-op pushes keep key, branch and selection; reset never reuses keys', () => {
    const history = new ProjectHistory(createProject()), sidecar = createClipSelectionHistory()
    const first = history.currentKey; sidecar.set(first, empty())
    history.push(update(history.current, 'next')); const next = history.currentKey
    history.undo()
    expect(() => history.push({ ...history.current, tempo: NaN })).toThrow()
    expect(history.currentKey).toBe(first); expect(history.canRedo).toBe(true)
    history.push(history.current)
    expect(history.currentKey).toBe(first); expect(history.canRedo).toBe(true)
    history.reset(createProject()); expect(history.currentKey).toBeGreaterThan(next)
    sidecar.prune(history.retainedKeys); expect(sidecar.size).toBe(0)
  })
})
