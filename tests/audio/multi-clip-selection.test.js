// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMultiClipSelection, createClipSelectionHistory, MULTI_CLIP_SELECTION_LIMITS } from '../../src/js/daw/multi-clip-selection.js'

const ref = (clipId, trackId = 'track') => ({ trackId, clipId })
const project = (...ids) => ({ tracks: [{ id: 'track', clips: ids.map(id => ({ id })) }] })
const selected = (...ids) => ({ mode: true, refs: ids.map(id => ref(id)), primary: ids.length ? ref(ids.at(-1)) : null })

describe('ephemeral multi-clip selection', () => {
  it('keeps stable ordered IDs, a primary clip, explicit mode and monotonic change versions', () => {
    const state = createMultiClipSelection()
    expect(state.snapshot()).toEqual({ mode: false, refs: [], primary: null })
    expect(state.version).toBe(0)
    state.select(ref('one')); expect(state.version).toBe(1)
    state.select(ref('one')); expect(state.version).toBe(1)
    state.select(ref('two'), { additive: true })
    expect(state.snapshot()).toEqual(selected('one', 'two'))
    state.select(ref('one'), { additive: true })
    expect(state.refs).toEqual([ref('one'), ref('two')]); expect(state.primary).toEqual(ref('one'))
    state.select(ref('two'), { toggle: true })
    expect(state.refs).toEqual([ref('one')]); expect(state.primary).toEqual(ref('one'))
    state.select(ref('three'), { toggle: true }); state.select(ref('three'), { toggle: true })
    expect(state.primary).toEqual(ref('one'))
    state.select(ref('one'), { toggle: true })
    expect(state.snapshot()).toEqual(selected()); expect(state.mode).toBe(true)
  })

  it('collapses to the primary on exit, supports single replacement in mode, and distinguishes clear from project reset', () => {
    const state = createMultiClipSelection()
    state.restore(selected('one', 'two')); state.setMode(false)
    expect(state.snapshot()).toEqual({ mode: false, refs: [ref('two')], primary: ref('two') })
    state.setMode(true); state.select(ref('three'))
    expect(state.snapshot()).toEqual(selected('three'))
    state.clear(); expect(state.snapshot()).toEqual(selected())
    state.reset(); expect(state.mode).toBe(false)
    const before = state.version
    state.reset(); expect(state.version).toBe(before + 1)
  })

  it('selects all in track/clip order, preserves a live primary and reconciles deletions without holding project objects', () => {
    const state = createMultiClipSelection(), live = project('one', 'two')
    live.tracks.push({ id: 'other', clips: [{ id: 'three', pcm: new Float32Array(100) }] })
    state.select(ref('two')); state.selectAll(live)
    expect(state.refs).toEqual([ref('one'), ref('two'), ref('three', 'other')])
    expect(state.primary).toEqual(ref('two'))
    live.tracks[0].clips.pop(); state.reconcile(live)
    expect(state.primary).toEqual(ref('three', 'other'))
    expect(state.snapshot()).toEqual({ mode: true, refs: [ref('one'), ref('three', 'other')], primary: ref('three', 'other') })
    expect(JSON.stringify(state.snapshot())).not.toMatch(/pcm|tracks|version/)
    live.tracks = []; state.reconcile(live); expect(state.snapshot()).toEqual(selected())
  })

  it('makes detached snapshots and getters, restores IDs without rolling back owner version', () => {
    const state = createMultiClipSelection(), input = selected('one', 'two')
    state.restore(input); input.refs[0].clipId = 'outside'; input.primary.clipId = 'outside'
    const snapshot = state.snapshot(), refs = state.refs, primary = state.primary
    snapshot.refs[0].trackId = 'outside'; snapshot.primary.clipId = 'outside'; refs.push(ref('outside')); primary.clipId = 'outside'
    expect(state.snapshot()).toEqual(selected('one', 'two'))
    const before = state.version
    state.clear(); state.restore(selected('one', 'two'))
    expect(state.version).toBe(before + 2)
  })

  it.each([
    null, [], new Date(), Object.create({ trackId: 'track', clipId: 'one' }),
    { trackId: 'track' }, { trackId: '', clipId: 'one' }, { trackId: 'track', clipId: 1 },
    { trackId: 'track', clipId: 'one', project: {} }, { trackId: 'track', clipId: '__proto__' },
    JSON.parse('{"trackId":"track","clipId":"one","__proto__":{}}'),
    { trackId: 'track', clipId: 'one', [Symbol('audio')]: new Float32Array(1) },
  ])('rejects malformed/prototype references atomically: %j', invalid => {
    const state = createMultiClipSelection(); state.restore(selected('one', 'two'))
    const version = state.version
    expect(() => state.select(invalid)).toThrow(/clip selection/)
    expect(state.snapshot()).toEqual(selected('one', 'two')); expect(state.version).toBe(version)
  })

  it('rejects reference accessors without evaluating them', () => {
    const state = createMultiClipSelection()
    const invalid = Object.defineProperty({ clipId: 'one' }, 'trackId', { get() { throw new Error('Must not read accessors') }, enumerable: true })
    expect(() => state.select(invalid)).toThrow(/unsupported fields/)
    expect(state.refs).toEqual([])
  })

  it.each([
    null, {}, { mode: 1, refs: [], primary: null }, { ...selected('one'), version: 0 },
    { ...selected('one'), project: {} }, { ...selected('one'), refs: [ref('one'), ref('one')] },
    { ...selected('one'), primary: ref('missing') }, { ...selected(), primary: ref('one') },
    { ...selected('one'), primary: null }, { ...selected('one', 'two'), mode: false },
    { ...selected('one'), refs: Array(1) },
    { ...selected('one'), refs: Object.assign([ref('one')], { audio: new Float32Array(1) }) },
    Object.create(selected('one')),
  ])('rejects malformed snapshots without losing the old selection: %j', invalid => {
    const state = createMultiClipSelection(); state.select(ref('old'))
    expect(() => state.restore(invalid)).toThrow(/clip selection/)
    expect(state.primary).toEqual(ref('old'))
  })

  it('enforces 256 clips at selection, restore and select-all boundaries without truncation', () => {
    const state = createMultiClipSelection(), ids = Array.from({ length: 256 }, (_, index) => `clip-${index}`)
    state.selectAll(project(...ids)); expect(state.refs).toHaveLength(256)
    const before = state.snapshot(), version = state.version
    expect(() => state.select(ref('extra'), { additive: true })).toThrow(/256/)
    expect(() => state.restore(selected(...ids, 'extra'))).toThrow(/256/)
    expect(() => state.selectAll(project(...ids, 'extra'))).toThrow(/256/)
    expect(state.snapshot()).toEqual(before); expect(state.version).toBe(version)
  })
})

describe('bounded selection history sidecar', () => {
  it('stores only detached ID snapshots, prunes discarded undo branches, and allows eviction independently of project history', () => {
    const history = createClipSelectionHistory(), input = selected('one', 'two')
    history.set(1, input); history.set('branch', selected('three'))
    input.refs[0].clipId = 'outside'
    const loaded = history.get(1); loaded.primary.clipId = 'outside'
    expect(history.get(1)).toEqual(selected('one', 'two'))
    history.prune(['branch']); expect(history.get(1)).toBeNull(); expect(history.size).toBe(1)
    expect(history.get('missing')).toBeNull()
    history.clear(); expect(history.size).toBe(0); expect(history.bytes).toBe(2)
  })

  it('evicts oldest entries at 100 entries while preserving the newest state', () => {
    const history = createClipSelectionHistory()
    for (let key = 0; key <= 100; key++) history.set(key, selected(`clip-${key}`))
    expect(history.size).toBe(100); expect(history.get(0)).toBeNull(); expect(history.get(100)).toEqual(selected('clip-100'))
    history.set(1, selected('updated')); history.set(101, selected('new'))
    expect(history.get(2)).toBeNull(); expect(history.get(1)).toEqual(selected('updated'))
  })

  it('caps actual serialized UTF-8 storage at 256 KiB, including keys and metadata', () => {
    const history = createClipSelectionHistory()
    const refs = Array.from({ length: 256 }, (_, index) => ref(`clip-${index}`.padEnd(128, 'x'), 't'.repeat(128)))
    const snapshot = { mode: true, refs, primary: refs[0] }
    for (let key = 0; key < 10; key++) history.set(key, snapshot)
    const retained = Array.from({ length: 10 }, (_, key) => ({ key, snapshot: history.get(key) })).filter(item => item.snapshot)
    expect(retained.length).toBeGreaterThan(0); expect(retained.length).toBeLessThan(10)
    expect(history.bytes).toBe(new TextEncoder().encode(JSON.stringify(retained)).byteLength)
    expect(history.bytes).toBeLessThanOrEqual(MULTI_CLIP_SELECTION_LIMITS.historyBytes)
    expect(history.get(9)).toEqual(snapshot)
    const tiny = createClipSelectionHistory({ maxBytes: 2 })
    expect(tiny.set(1, selected('one'))).toBe(false); expect(tiny.size).toBe(0); expect(tiny.bytes).toBe(2)
  })

  it('rejects invalid snapshot/key/budget data without altering retained entries', () => {
    const history = createClipSelectionHistory(); history.set(1, selected('one'))
    expect(() => history.set(1, { ...selected('one'), audio: new Float32Array(8) })).toThrow()
    expect(() => history.set({ project: {} }, selected('two'))).toThrow()
    expect(() => history.set('x'.repeat(129), selected())).toThrow()
    expect(history.get(1)).toEqual(selected('one'))
    expect(() => createClipSelectionHistory({ maxEntries: 101 })).toThrow()
    expect(() => createClipSelectionHistory({ maxBytes: 256 * 1024 + 1 })).toThrow()
  })
})
