import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { createTimelineSelectionControls } from '../../src/js/daw/selection-controls.js'

let controls, project, root, timeline, busy, zoom, callbacks
const action = name => root.querySelector(`[data-range-action="${name}"]`)
const input = name => root.querySelector(`[data-range-endpoint="${name}Seconds"]`)
const handle = name => root.querySelector(`[data-range-handle="${name}Seconds"]`)
const lane = () => root.querySelector('.daw-lane')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
function pointer(target, type, clientX, options = {}) {
  const event = new MouseEvent(type, { clientX, clientY: 80, bubbles: true, cancelable: true, button: 0, ...options })
  Object.defineProperties(event, { pointerId: { value: options.pointerId ?? 1 }, pointerType: { value: options.pointerType || 'mouse' }, isPrimary: { value: options.isPrimary ?? true } })
  target.dispatchEvent(event); return event
}
function key(target, value) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }); target.dispatchEvent(event); return event
}
function edit(name, value) {
  input(name).value = String(value); input(name).dispatchEvent(new Event('input', { bubbles: true }))
}
function rebuild() {
  timeline.innerHTML = '<div class="daw-ruler"><span class="daw-ruler-label">音軌</span><div class="daw-ruler-lane" data-seek-lane="true"></div></div><div class="daw-track"><div class="daw-track-controls"><button>靜音</button></div><div class="daw-lane" data-seek-lane="true"><button class="daw-clip">voice.wav</button></div></div>'
  for (const element of timeline.querySelectorAll('.daw-ruler-lane, .daw-lane')) {
    // The timeline starts at client 100 and the fixed track labels end at 200.
    element.getBoundingClientRect = () => ({ left: 200 - timeline.scrollLeft, width: 1000, top: 0, height: 150, right: 1200 - timeline.scrollLeft })
  }
}
function select(startSeconds = 1, endSeconds = 3) {
  project = applyCommand(project, { type: 'timelineSelection.set', selection: { startSeconds, endSeconds } }); controls.render()
}
function setup(options = {}) {
  document.body.innerHTML = '<section id="mode-editor" class="daw-panel"><div class="daw-arrangement"><div id="daw-timeline" class="daw-timeline"></div></div></section>'
  root = document.getElementById('mode-editor'); timeline = document.getElementById('daw-timeline')
  project = applyCommand(createProject(), { type: 'asset.add', asset: { id: 'audio', name: 'voice.wav', hash: '', sampleRate: 48000, channels: 1, duration: 10, length: 480000 } })
  project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'audio' } })
  busy = false; zoom = 100; rebuild()
  callbacks = {
    commitSelection: vi.fn(selection => { project = applyCommand(project, { type: 'timelineSelection.set', selection }); rebuild(); controls.render() }),
    clearSelection: vi.fn(() => { project = applyCommand(project, { type: 'timelineSelection.clear' }); controls.render() }),
    playSelection: vi.fn(), exportSelection: vi.fn(), onStatus: vi.fn(),
  }
  controls = createTimelineSelectionControls({ root, getProject: () => project, isBusy: () => busy,
    getZoom: () => zoom, snapTime: value => Math.round(value * 2) / 2, ...callbacks, ...options })
}
beforeEach(() => setup())
afterEach(() => { controls?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('timeline range controls', () => {
  it('starts compact and collapsed, exposes exact seconds and forwards actual selection actions', () => {
    expect(root.querySelector('.daw-selection-details').open).toBe(false)
    expect(root.querySelector('.daw-selection-actions').hidden).toBe(true)
    expect(action('draw').getAttribute('aria-pressed')).toBe('false')
    edit('start', 1.23456789); edit('end', 3.987654321); action('apply').click()
    expect(callbacks.commitSelection).toHaveBeenCalledExactlyOnceWith({ startSeconds: 1.23456789, endSeconds: 3.987654321 })
    expect(input('start').value).toBe('1.23456789')
    expect(root.querySelectorAll('.daw-timeline-selection')).toHaveLength(2)
    action('play').click(); action('loop').click(); action('export').click()
    expect(callbacks.playSelection.mock.calls).toEqual([[{ loop: false }], [{ loop: true }]])
    expect(callbacks.exportSelection).toHaveBeenCalledExactlyOnceWith()
    action('clear').click()
    expect(callbacks.clearSelection).toHaveBeenCalledOnce()
    expect(project.timelineSelection).toBeUndefined()
    expect(root.querySelectorAll('.daw-timeline-selection, .daw-selection-handle')).toHaveLength(0)
  })

  it('owns drawing over clips and commits one reversed pointer gesture without moving a clip', () => {
    const clipPointer = vi.fn(), clipClick = vi.fn(), documentPointer = vi.fn()
    root.addEventListener('pointerdown', clipPointer); root.addEventListener('click', clipClick)
    window.addEventListener('pointerup', documentPointer)
    action('draw').click(); clipClick.mockClear()
    const before = structuredClone(project.tracks)
    pointer(root.querySelector('.daw-clip'), 'pointerdown', 551)
    pointer(window, 'pointermove', 294); pointer(window, 'pointermove', 301)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    expect(lane().querySelector('.daw-timeline-selection').dataset.preview).toBe('true')
    pointer(window, 'pointerup', 301); timeline.click()
    expect(callbacks.commitSelection).toHaveBeenCalledExactlyOnceWith({ startSeconds: 1, endSeconds: 3.5 })
    expect(project.tracks).toEqual(before)
    expect(clipPointer).not.toHaveBeenCalled(); expect(clipClick).not.toHaveBeenCalled(); expect(documentPointer).not.toHaveBeenCalled()
    window.removeEventListener('pointerup', documentPointer)
  })

  it('allows ordinary clip gestures and unrelated controls when draw mode is off', () => {
    const listener = vi.fn(); root.addEventListener('pointerdown', listener)
    pointer(root.querySelector('.daw-clip'), 'pointerdown', 300)
    expect(listener).toHaveBeenCalledOnce()
    action('draw').click()
    pointer(root.querySelector('.daw-track-controls button'), 'pointerdown', 130)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
  })

  it('uses scrolled lane coordinates once and follows scrolling during a gesture', () => {
    timeline.scrollLeft = 150; action('draw').click()
    pointer(lane(), 'pointerdown', 200) // 1.5 seconds, not 3 seconds.
    timeline.scrollLeft = 250; timeline.dispatchEvent(new Event('scroll'))
    expect(lane().querySelector('.daw-timeline-selection').style.left).toBe('150px')
    expect(lane().querySelector('.daw-timeline-selection').style.width).toBe('100px')
    pointer(window, 'pointerup', 200)
    expect(callbacks.commitSelection).toHaveBeenCalledExactlyOnceWith({ startSeconds: 1.5, endSeconds: 2.5 })
  })

  it('drags touch handles without jumping from the wide grab target and preserves the other endpoint', () => {
    select(2, 4); timeline.scrollLeft = 100
    pointer(handle('start'), 'pointerdown', 280, { pointerType: 'touch', pointerId: 8 }) // 20px before the true edge.
    pointer(window, 'pointermove', 380, { pointerType: 'touch', pointerId: 8 })
    pointer(window, 'pointerup', 380, { pointerType: 'touch', pointerId: 8 })
    expect(callbacks.commitSelection).toHaveBeenCalledExactlyOnceWith({ startSeconds: 3, endSeconds: 4 })
    expect(handle('start').getAttribute('aria-valuenow')).toBe('3')
  })

  it('does not mutate on stationary or out-and-back handle clicks or an empty draw', () => {
    select(1.234567, 3)
    pointer(handle('start'), 'pointerdown', 320); pointer(window, 'pointerup', 320)
    pointer(handle('start'), 'pointerdown', 320); pointer(window, 'pointermove', 420); pointer(window, 'pointerup', 320)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    action('draw').click(); pointer(lane(), 'pointerdown', 500); pointer(window, 'pointerup', 500)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    expect(project.timelineSelection).toEqual({ startSeconds: 1.234567, endSeconds: 3 })
  })

  it.each(['Escape', 'pointercancel', 'navigation', 'blur', 'pagehide', 'cancel'])('discards the preview on %s without a history commit', reason => {
    select(); action('draw').click(); pointer(lane(), 'pointerdown', 700); pointer(window, 'pointermove', 900)
    if (reason === 'Escape') key(root, 'Escape')
    else if (reason === 'pointercancel') pointer(window, reason, 900)
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
    else if (reason === 'cancel') controls.cancel()
    else window.dispatchEvent(new Event(reason))
    pointer(window, 'pointerup', 900)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    expect(project.timelineSelection).toEqual({ startSeconds: 1, endSeconds: 3 })
    expect(action('draw').getAttribute('aria-pressed')).toBe('false')
    expect(lane().querySelector('.daw-timeline-selection').style.left).toBe('100px')
    expect(lane().querySelector('.daw-timeline-selection').dataset.preview).toBe('false')
  })

  it.each(['project', 'revision', 'source', 'selection', 'rebuild', 'zoom', 'busy', 'hidden'])('rejects a gesture after %s changes', change => {
    select(); action('draw').click(); pointer(lane(), 'pointerdown', 700); pointer(window, 'pointermove', 900)
    if (change === 'project') project = structuredClone(project)
    if (change === 'revision') project.revision++
    if (change === 'source') project.assets[0].hash = 'a'.repeat(64)
    if (change === 'selection') project.timelineSelection.startSeconds = .5
    if (change === 'rebuild') rebuild()
    if (change === 'zoom') zoom = 50
    if (change === 'busy') busy = true
    if (change === 'hidden') root.hidden = true
    controls.render(); pointer(window, 'pointerup', 900)
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
  })

  it('ignores unrelated pointer IDs and non-primary buttons without stealing their events', () => {
    action('draw').click()
    expect(pointer(lane(), 'pointerdown', 300, { button: 2 }).defaultPrevented).toBe(false)
    expect(pointer(lane(), 'pointerdown', 300, { isPrimary: false }).defaultPrevented).toBe(false)
    pointer(lane(), 'pointerdown', 300, { pointerId: 7 })
    expect(pointer(window, 'pointerup', 600, { pointerId: 8 }).defaultPrevented).toBe(false)
    pointer(window, 'pointerup', 500, { pointerId: 7 })
    expect(callbacks.commitSelection).toHaveBeenCalledExactlyOnceWith({ startSeconds: 1, endSeconds: 3 })
  })

  it('edits accessible endpoints on the chosen grid, preserves focus and respects bounds', () => {
    select(1.2, 3)
    expect(handle('start').getAttribute('role')).toBe('slider')
    expect(handle('start').getAttribute('aria-label')).toBe('範圍起點')
    key(handle('start'), 'ArrowRight')
    expect(project.timelineSelection.startSeconds).toBe(1.5)
    expect(document.activeElement).toBe(handle('start'))
    key(handle('start'), 'ArrowLeft'); expect(project.timelineSelection.startSeconds).toBe(1)
    key(handle('end'), 'End'); expect(project.timelineSelection.endSeconds).toBe(10)
    key(handle('end'), 'ArrowRight'); expect(project.timelineSelection.endSeconds).toBe(10)
    key(handle('start'), 'Home'); expect(project.timelineSelection.startSeconds).toBe(0)
    key(handle('start'), 'ArrowLeft'); expect(project.timelineSelection.startSeconds).toBe(0)
    expect(callbacks.commitSelection).toHaveBeenCalledTimes(4)
  })

  it('accepts exact keyboard numeric entry and rejects blank, reversed and out-of-bounds ranges', () => {
    edit('start', .125000001); edit('end', .500000001); key(input('end'), 'Enter')
    expect(project.timelineSelection).toEqual({ startSeconds: .125000001, endSeconds: .500000001 })
    for (const [start, end] of [['', 2], [3, 2], [-1, 2], [1, 11], [2, 2]]) {
      edit('start', start); edit('end', end); action('apply').click()
    }
    expect(callbacks.commitSelection).toHaveBeenCalledOnce()
    expect(callbacks.onStatus).toHaveBeenCalledTimes(5)
    key(input('start'), 'Escape')
    expect(input('start').value).toBe('0.125000001')
  })

  it('never applies fields drafted against an older project and keeps fresh drafts during harmless renders', () => {
    edit('start', 2); edit('end', 4); controls.render()
    expect(input('start').value).toBe('2')
    project = structuredClone(project)
    action('apply').click()
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    expect(input('start').value).toBe('0')
    expect(input('end').value).toBe('10')
  })

  it('disables busy and empty-project actions, including keyboard and stale enabled clicks', () => {
    select(); busy = true; controls.render()
    for (const element of root.querySelectorAll('.daw-selection-controls button, .daw-selection-controls input, .daw-selection-handle')) expect(element.disabled).toBe(true)
    action('play').click(); key(handle('start'), 'ArrowRight'); action('clear').click()
    expect(callbacks.playSelection).not.toHaveBeenCalled(); expect(callbacks.clearSelection).not.toHaveBeenCalled(); expect(callbacks.commitSelection).not.toHaveBeenCalled()
    busy = false; project = createProject(); controls.render()
    expect(action('draw').disabled).toBe(true); expect(action('apply').disabled).toBe(true)
    expect(root.querySelector('.daw-selection-actions').hidden).toBe(true)
  })

  it('waits for callbacks and reports rejected operations without duplicate actions or uncaught errors', async () => {
    select(); const wait = deferred(); callbacks.playSelection.mockReturnValueOnce(wait.promise)
    action('play').click(); action('play').click()
    expect(callbacks.playSelection).toHaveBeenCalledOnce(); expect(action('loop').disabled).toBe(true)
    wait.resolve(); await settle(); expect(action('loop').disabled).toBe(false)
    callbacks.exportSelection.mockRejectedValueOnce(new Error('Output unavailable'))
    action('export').click(); await settle()
    expect(callbacks.onStatus).toHaveBeenCalledWith('Output unavailable', true)
    expect(action('export').disabled).toBe(false)
  })

  it('does not publish a late callback error after destruction', async () => {
    select(); let reject
    callbacks.playSelection.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail }))
    action('play').click(); controls.destroy(); reject(new Error('Stale error')); await settle()
    expect(callbacks.onStatus).not.toHaveBeenCalled()
  })

  it('reuses overlays on render, restores them after child rebuild and removes listeners on destroy', () => {
    select(); const original = lane().querySelector('.daw-timeline-selection')
    for (let index = 0; index < 8; index++) controls.render()
    expect(lane().querySelector('.daw-timeline-selection')).toBe(original)
    expect(root.querySelectorAll('.daw-selection-controls')).toHaveLength(1)
    expect(root.querySelectorAll('.daw-selection-handle')).toHaveLength(2)
    rebuild(); controls.render()
    expect(root.querySelectorAll('.daw-timeline-selection')).toHaveLength(2)
    action('draw').click(); pointer(lane(), 'pointerdown', 700); controls.destroy(); controls.destroy()
    pointer(window, 'pointerup', 900); key(root, 'Escape'); controls.render()
    expect(callbacks.commitSelection).not.toHaveBeenCalled()
    expect(root.querySelectorAll('.daw-selection-controls, .daw-timeline-selection, .daw-selection-handle')).toHaveLength(0)
    expect(timeline.classList.contains('daw-selection-drawing')).toBe(false)
    const parent = vi.fn(); root.addEventListener('pointerdown', parent); pointer(lane(), 'pointerdown', 300)
    expect(parent).toHaveBeenCalledOnce()
  })

  it('keeps tiny edge ranges selectable with separate ruler rows for both 44px handles', () => {
    select(0, 1 / 48000)
    expect(timeline.classList.contains('daw-selection-tight')).toBe(true)
    expect(handle('start').style.left).toBe('0px')
    expect(handle('end').getAttribute('aria-valuenow')).toBe(String(1 / 48000))
  })
})
