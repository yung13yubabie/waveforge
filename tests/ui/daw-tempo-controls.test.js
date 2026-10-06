import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../src/js/daw/project.js'
import { createTempoControls } from '../../src/js/daw/tempo-controls.js'

let controls, root, panel, outer, details, project, busy, position, time, callbacks
const action = name => root.querySelector(`[data-tempo-action="${name}"]`)
const origin = () => root.querySelector('[data-tempo-origin]')
const candidate = () => root.querySelector('.daw-tempo-candidate')
const status = () => root.querySelector('.daw-tempo-status')
const candidateRow = () => root.querySelector('.daw-tempo-candidate-row')
const toggle = (element, open) => { element.open = open; element.dispatchEvent(new Event('toggle')) }
const open = () => { toggle(outer, true); toggle(details, true) }
const openOrigin = () => { open(); toggle(root.querySelector('.daw-tempo-origin-details'), true) }
const key = (target, type, value, options = {}) => {
  const event = new KeyboardEvent(type, { key: value, bubbles: true, cancelable: true, ...options }); target.dispatchEvent(event); return event
}
const editOrigin = value => { origin().value = String(value); origin().dispatchEvent(new Event('input', { bubbles: true })) }
const taps = (count = 5, interval = 600) => { for (let index = 0; index < count; index++) { time += interval; action('tap').click() } }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail }); return { resolve, reject, promise } }

function setup() {
  document.body.innerHTML = '<section id="mode-editor"><details id="grid"><summary>拍格</summary><div id="rhythm"></div></details></section>'
  root = document.getElementById('rhythm'); panel = document.getElementById('mode-editor'); outer = document.getElementById('grid')
  project = createProject({ name: '<img src=x onerror=alert(1)>' }); busy = false; position = 1.23456789; time = 0
  callbacks = {
    applyGridPatch: vi.fn(patch => { project = { ...project, ...patch, revision: project.revision + 1 }; controls.render() }),
    onStatus: vi.fn(),
  }
  controls = createTempoControls({ root, getProject: () => project, isBusy: () => busy,
    getCurrentTime: () => position, now: () => time, ...callbacks })
  details = root.querySelector('.daw-tempo-controls')
}
beforeEach(setup)
afterEach(() => { controls?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('tap tempo and grid origin controls', () => {
  it('starts collapsed, explains the limited grid purpose, and creates no injected markup', () => {
    expect(details.open).toBe(false); expect(candidateRow().hidden).toBe(true)
    expect(root.textContent).toContain('只改拍格，不改錄音速度')
    expect(root.querySelector('img')).toBeNull()
    expect(action('tap').disabled).toBe(true)
    open(); expect(action('tap').disabled).toBe(false)
    expect(root.querySelector('.daw-tempo-origin-details').open).toBe(false)
  })

  it('collects taps without touching the project, then accepts one explicit BPM command exactly once', () => {
    open(); const original = JSON.stringify(project)
    taps(4); expect(candidateRow().hidden).toBe(true); expect(action('apply').disabled).toBe(true)
    taps(1); expect(candidate().textContent).toBe('100 BPM'); expect(status().textContent).toContain('5 下')
    expect(JSON.stringify(project)).toBe(original); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
    action('apply').click(); action('apply').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledExactlyOnceWith({ tempo: 100 })
    expect(project.tempo).toBe(100); expect(project.gridOriginSeconds).toBeUndefined()
    expect(candidateRow().hidden).toBe(true)
  })

  it('does not create an undo command for a candidate equal to the saved BPM', () => {
    open(); taps(5, 500)
    expect(candidate().textContent).toBe('120 BPM'); expect(action('apply').disabled).toBe(true)
    action('apply').click(); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
  })

  it('shows only valid half/double choices and keeps them as unapplied candidate choices', () => {
    open(); taps(); action('double').click()
    expect(candidate().textContent).toBe('200 BPM'); expect(action('double').hidden).toBe(true)
    action('half').click(); action('half').click(); action('half').click()
    expect(candidate().textContent).toBe('25 BPM'); expect(action('half').hidden).toBe(true)
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
    taps(1); expect(candidate().textContent).toBe('100 BPM')
    action('half').click(); action('apply').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledExactlyOnceWith({ tempo: 50 })
  })

  it('refuses irregular taps and starts a new sequence after a long pause', () => {
    open()
    for (const delta of [500, 500, 300, 850, 600, 500]) { time += delta; action('tap').click() }
    expect(candidateRow().hidden).toBe(true); expect(status().textContent).toContain('還不穩')
    time += 5000; action('tap').click()
    expect(status().textContent).toBe('1 / 5 下')
    taps(4); expect(candidate().textContent).toBe('100 BPM')
  })

  it('handles focused keyboard tapping without repeats, default button clicks, or global keyboard shortcuts', () => {
    open(); const bubbled = vi.fn(); panel.addEventListener('keydown', bubbled)
    const tapButton = action('tap')
    for (let index = 0; index < 5; index++) {
      time += 600
      expect(key(tapButton, 'keydown', ' ').defaultPrevented).toBe(true)
      key(tapButton, 'keydown', ' ', { repeat: true })
      key(tapButton, 'keydown', ' ')
      key(tapButton, 'keyup', ' ')
      // Some assistive/browser activation paths additionally dispatch click.
      time += 1; tapButton.click()
    }
    expect(status().textContent).toContain('5 下'); expect(candidate().textContent).toBe('99.8 BPM')
    expect(bubbled).not.toHaveBeenCalled(); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
    panel.removeEventListener('keydown', bubbled)
  })

  it('ignores rapid pointer repeats without discarding valid double/triple click beat sequences', () => {
    open(); taps(4)
    time += 600; action('tap').click()
    time += 60; action('tap').click()
    expect(status().textContent).toContain('5 下'); expect(candidate().textContent).toBe('100 BPM')
    action('reset').click()
    for (const detail of [1, 2, 3, 1, 2]) {
      time += 400; action('tap').dispatchEvent(new MouseEvent('click', { detail, bubbles: true }))
    }
    expect(status().textContent).toContain('5 下'); expect(candidate().textContent).toBe('150 BPM')
  })

  it.each(['reset', 'Escape', 'blur', 'pagehide', 'navigation', 'cancel', 'close', 'ancestor-close'])('cancels taps on %s and reopening requires new taps', reason => {
    open(); taps()
    if (reason === 'reset') action('reset').click()
    else if (reason === 'Escape') key(action('tap'), 'keydown', 'Escape')
    else if (reason === 'cancel') controls.cancel()
    else if (reason === 'close') toggle(details, false)
    else if (reason === 'ancestor-close') toggle(outer, false)
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
    else window.dispatchEvent(new Event(reason))
    expect(candidateRow().hidden).toBe(true); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
    document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'editor' } })); open()
    expect(action('apply').disabled).toBe(true)
    taps(); action('apply').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledExactlyOnceWith({ tempo: 100 })
  })

  it.each(['project', 'revision', 'id', 'tempo', 'origin', 'hidden', 'hidden-ancestor', 'closed-ancestor', 'disconnected', 'busy'])('rejects a stale enabled accept after %s changes, even before render', change => {
    open(); taps()
    if (change === 'project') project = structuredClone(project)
    if (change === 'revision') project.revision++
    if (change === 'id') project.id = 'other'
    if (change === 'tempo') project.tempo = 121
    if (change === 'origin') project.gridOriginSeconds = 2
    if (change === 'hidden') root.hidden = true
    if (change === 'hidden-ancestor') panel.hidden = true
    if (change === 'closed-ancestor') outer.open = false
    if (change === 'disconnected') root.remove()
    if (change === 'busy') busy = true
    action('apply').click()
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled(); expect(candidateRow().hidden).toBe(true)
  })

  it('preserves taps across harmless renders and a moving playback position', () => {
    open(); taps(3); position = 3.5; controls.render(); taps(2)
    expect(candidate().textContent).toBe('100 BPM'); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
  })

  it('clears the candidate on document hiding and permits a fresh sequence on return', () => {
    open(); taps(); const hidden = vi.spyOn(document, 'hidden', 'get')
    hidden.mockReturnValue(true); document.dispatchEvent(new Event('visibilitychange'))
    expect(candidateRow().hidden).toBe(true); expect(action('tap').disabled).toBe(true)
    hidden.mockReturnValue(false); document.dispatchEvent(new Event('visibilitychange'))
    expect(action('tap').disabled).toBe(false); taps(); action('apply').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledExactlyOnceWith({ tempo: 100 })
  })

  it('edits an exact numeric grid origin without committing until Apply or Enter', () => {
    openOrigin(); const original = JSON.stringify(project)
    editOrigin(.123456789); controls.render()
    expect(origin().value).toBe('0.123456789'); expect(JSON.stringify(project)).toBe(original)
    key(origin(), 'keydown', 'Enter'); key(origin(), 'keydown', 'Enter', { repeat: true })
    expect(callbacks.applyGridPatch).toHaveBeenCalledExactlyOnceWith({ gridOriginSeconds: .123456789 })
    expect(project.tempo).toBe(120)
  })

  it.each(['', '-1', '600.1', 'Infinity', 'not-a-number'])('rejects invalid origin field %s', value => {
    openOrigin(); editOrigin(value); action('apply-origin').click()
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled(); expect(callbacks.onStatus).toHaveBeenCalledWith(expect.stringContaining('0–600'), true)
    expect(origin().value).toBe(value === 'Infinity' || value === 'not-a-number' ? '' : value)
  })

  it('allows a bounded origin before audio exists and never rounds the play position', () => {
    openOrigin(); action('use-position').click()
    expect(callbacks.applyGridPatch).toHaveBeenLastCalledWith({ gridOriginSeconds: 1.23456789 })
    editOrigin(600); action('apply-origin').click()
    expect(callbacks.applyGridPatch).toHaveBeenLastCalledWith({ gridOriginSeconds: 600 })
    action('reset-origin').click(); action('reset-origin').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledTimes(3)
    expect(callbacks.applyGridPatch).toHaveBeenLastCalledWith({ gridOriginSeconds: 0 })
  })

  it.each([NaN, Infinity, -1, 601, '2'])('refuses an invalid live playback position %s', value => {
    openOrigin(); position = value; action('use-position').click()
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled(); expect(status().textContent).toBe('目前播放位置無效')
  })

  it('discards origin drafts after project replacement and closed origin disclosure', () => {
    openOrigin(); editOrigin(3); project = structuredClone(project); action('apply-origin').click()
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled(); expect(origin().value).toBe('0')
    editOrigin(4); toggle(root.querySelector('.daw-tempo-origin-details'), false)
    openOrigin(); expect(origin().value).toBe('0')
  })

  it('disables hidden origin commands and stale busy commands without changing the project', () => {
    open(); action('use-position').click(); expect(callbacks.applyGridPatch).not.toHaveBeenCalled()
    openOrigin(); editOrigin(3); busy = true; action('apply-origin').click()
    expect(callbacks.applyGridPatch).not.toHaveBeenCalled(); expect(origin().value).toBe('0')
  })

  it('locks async acceptance, consumes the candidate once, and reports failures as text', async () => {
    open(); taps(); const wait = deferred(); callbacks.applyGridPatch.mockReturnValueOnce(wait.promise)
    action('apply').click(); action('apply').click(); action('tap').click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledOnce(); expect(action('tap').disabled).toBe(true)
    wait.reject(new Error('<img src=x onerror=alert(1)>')); await settle()
    expect(root.querySelector('img')).toBeNull(); expect(status().textContent).toBe('<img src=x onerror=alert(1)>')
    expect(action('tap').disabled).toBe(false); expect(candidateRow().hidden).toBe(true)
  })

  it('reports synchronous command errors without leaving a reusable stale candidate', () => {
    callbacks.applyGridPatch.mockImplementationOnce(() => { throw new Error('Cannot edit') })
    open(); taps(); action('apply').click(); action('apply').click()
    expect(callbacks.onStatus).toHaveBeenCalledWith('Cannot edit', true)
    expect(callbacks.applyGridPatch).toHaveBeenCalledOnce(); expect(status().textContent).toBe('Cannot edit')
  })

  it('disposes handlers and ignores async errors after destroy, allowing a fresh mount', async () => {
    open(); taps(); const wait = deferred(); callbacks.applyGridPatch.mockReturnValueOnce(wait.promise)
    const oldTap = action('tap'); action('apply').click(); controls.destroy(); controls.destroy()
    wait.reject(new Error('late failure')); await settle(); oldTap.click()
    expect(callbacks.applyGridPatch).toHaveBeenCalledOnce(); expect(callbacks.onStatus).not.toHaveBeenCalled()
    expect(root.children).toHaveLength(0)
    controls = createTempoControls({ root, getProject: () => project, getCurrentTime: () => position, now: () => time, ...callbacks })
    details = root.querySelector('.daw-tempo-controls'); open()
    expect(candidateRow().hidden).toBe(true); expect(action('tap').disabled).toBe(false)
  })
})
