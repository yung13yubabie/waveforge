import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { createMultiClipSelection } from '../../src/js/daw/multi-clip-selection.js'
import { createClipGroupControls } from '../../src/js/daw/clip-group-controls.js'

let controls, project, state, root, host, busy, sourceVersion, grid, callbacks
const ref = clipId => ({ trackId: 'track', clipId })
const action = name => host.querySelector(`[data-group-action="${name}"]`)
const target = () => host.querySelector('[data-group-target]')
const overlap = () => host.querySelector('[data-group-overlap]')
const edit = value => { target().value = String(value); target().dispatchEvent(new Event('input', { bubbles: true })) }
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const key = (name, repeat = false) => { const event = new KeyboardEvent('keydown', { key: name, repeat, bubbles: true, cancelable: true }); target().dispatchEvent(event); return event }
function setup() {
  document.body.innerHTML = '<section id="editor"><div id="group-host"></div></section>'
  root = document.getElementById('editor'); host = document.getElementById('group-host')
  project = createProject({ id: 'groups', assets: [{ id: 'audio', name: 'voice.wav', sampleRate: 48000, channels: 1, duration: 10, length: 480000 }] })
  project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
  for (const [id, atSeconds, durationSeconds] of [['one', 1, 2], ['two', 5, 3], ['outside', 10, 2]]) {
    project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id, assetId: 'audio', atSeconds, durationSeconds } })
  }
  state = createMultiClipSelection(); state.select(ref('one')); state.select(ref('two'), { additive: true })
  busy = false; sourceVersion = 0; grid = { stepSeconds: .5, snapEnabled: true }
  callbacks = Object.fromEntries(['moveTo', 'nudge', 'duplicateToEnd', 'remove', 'clear', 'exit', 'onStatus'].map(name => [name, vi.fn()]))
  controls = createClipGroupControls({ host, getProject: () => project, getSelection: () => state, isBusy: () => busy,
    getGridInfo: () => grid, getOwnerVersion: () => sourceVersion, ...callbacks })
}
beforeEach(setup)
afterEach(() => { controls?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('contextual clip group inspector', () => {
  it('shows the count/span, exact earliest target and current grid with unchecked overlap permission', () => {
    expect(host.hidden).toBe(false)
    expect(host.textContent).toContain('已選 2 個片段 · 1 秒 – 8 秒（跨度 7 秒）')
    expect(target().value).toBe('1'); expect(target().max).toBe('593'); expect(overlap().checked).toBe(false)
    expect(host.textContent).toContain('依目前拍格微移')
    grid = { snapEnabled: false, stepSeconds: .01 }; controls.render()
    expect(host.textContent).toContain('每次 0.01 秒')
    expect(action('duplicate').textContent).toBe('複製到尾端'); expect(action('remove').textContent).toBe('刪除所選')
  })

  it('forwards one exact numeric move with detached IDs and captured owner, then resets one-shot overlap consent', () => {
    edit(2.123456789); overlap().checked = true; action('move').click()
    expect(callbacks.moveTo).toHaveBeenCalledOnce()
    const [seconds, context] = callbacks.moveTo.mock.calls[0]
    expect(seconds).toBe(2.123456789); expect(context.refs).toEqual([ref('one'), ref('two')])
    expect(context.allowOverlap).toBe(true)
    expect(context.owner).toMatchObject({ projectToken: expect.any(Number), projectId: 'groups', revision: project.revision, selectionVersion: state.version, sourceVersion: 0 })
    expect(context.owner).not.toHaveProperty('project')
    context.refs[0].clipId = 'mutated'; context.owner.refs[1].clipId = 'mutated'
    expect(state.refs).toEqual([ref('one'), ref('two')]); expect(overlap().checked).toBe(false)
  })

  it('forwards shared nudges and group actions once, never leaking overlap permission into duplicate/remove', () => {
    action('nudge-left').click(); overlap().checked = true; action('nudge-right').click()
    expect(callbacks.nudge.mock.calls.map(([direction, context]) => [direction, context.allowOverlap])).toEqual([[-1, false], [1, true]])
    overlap().checked = true; action('duplicate').click(); action('remove').click(); action('clear').click(); action('exit').click()
    for (const name of ['duplicateToEnd', 'remove', 'clear', 'exit']) {
      expect(callbacks[name]).toHaveBeenCalledOnce()
      expect(callbacks[name].mock.calls[0][0]).toMatchObject({ refs: [ref('one'), ref('two')], allowOverlap: false })
    }
  })

  it.each(['', '-1', '594', 'Infinity', 'NaN'])('rejects invalid draft %j without committing or changing the project', value => {
    const before = JSON.stringify(project)
    edit(value); action('move').click()
    expect(callbacks.moveTo).not.toHaveBeenCalled(); expect(JSON.stringify(project)).toBe(before)
    expect(callbacks.onStatus).toHaveBeenCalledOnce(); expect(target().getAttribute('aria-invalid')).toBe('true')
    edit(3); expect(target().hasAttribute('aria-invalid')).toBe(false)
  })

  it('allows the exact 600-second boundary, skips unchanged moves, and commits Enter once without key repeats', () => {
    action('move').click(); expect(callbacks.moveTo).not.toHaveBeenCalled()
    edit(593); expect(key('Enter', true).defaultPrevented).toBe(true); expect(callbacks.moveTo).not.toHaveBeenCalled()
    expect(key('Enter').defaultPrevented).toBe(true); expect(callbacks.moveTo).toHaveBeenCalledOnce()
    expect(callbacks.moveTo.mock.calls[0][0]).toBe(593)
  })

  it.each([
    ['project replacement', () => { project = structuredClone(project) }],
    ['project revision', () => { project.revision++ }],
    ['selection membership', () => { state.select(ref('outside'), { toggle: true }) }],
    ['selection primary', () => { state.select(ref(state.primary.clipId === 'one' ? 'two' : 'one'), { additive: true }) }],
    ['selection reset and restore', () => { const snapshot = state.snapshot(); state.reset(); state.restore(snapshot) }],
    ['source/controller owner', () => { sourceVersion++ }],
    ['grid change', () => { grid.stepSeconds /= 2 }],
  ])('rejects a stale draft and stale displayed command after %s', (_label, change) => {
    edit(4); overlap().checked = true; change(); action('move').click()
    expect(callbacks.moveTo).not.toHaveBeenCalled(); expect(overlap().checked).toBe(false)
    expect(target().value).toBe('1')
    edit(3); action('move').click(); expect(callbacks.moveTo).toHaveBeenCalledOnce()
    change(); action('remove').click(); expect(callbacks.remove).not.toHaveBeenCalled()
  })

  it('resets draft/consent on owner change, while ordinary renders preserve an unfinished valid-owner draft', () => {
    edit(4); overlap().checked = true; controls.render()
    expect(target().value).toBe('4'); expect(overlap().checked).toBe(true)
    sourceVersion++; controls.render()
    expect(target().value).toBe('1'); expect(overlap().checked).toBe(false)
    edit(6); overlap().checked = true; expect(key('Escape').defaultPrevented).toBe(true)
    expect(target().value).toBe('1'); expect(overlap().checked).toBe(false); expect(callbacks.moveTo).not.toHaveBeenCalled()
  })

  it.each(['project', 'selection', 'cancel', 'pointercancel'])('rejects a held button gesture after %s changes, even after a fresh render', reason => {
    const control = action('remove')
    control.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    if (reason === 'project') project = structuredClone(project)
    if (reason === 'selection') state.select(ref('outside'), { additive: true })
    if (reason === 'cancel') controls.cancel()
    if (reason === 'pointercancel') control.dispatchEvent(new Event('pointercancel', { bubbles: true }))
    controls.render(); control.click()
    expect(callbacks.remove).not.toHaveBeenCalled()
    control.dispatchEvent(new MouseEvent('pointerdown', { button: 0, bubbles: true })); control.click()
    expect(callbacks.remove).toHaveBeenCalledOnce()
  })

  it('guards a held keyboard button activation across an owner change and suppresses key repeats', () => {
    const control = action('duplicate')
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    sourceVersion++; controls.render(); control.click(); expect(callbacks.duplicateToEnd).not.toHaveBeenCalled()
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true })
    control.dispatchEvent(repeat); expect(repeat.defaultPrevented).toBe(true)
  })

  it('disables all controls while busy and prevents programmatic input/actions', () => {
    busy = true; controls.render()
    for (const control of host.querySelectorAll('button,input')) expect(control.disabled).toBe(true)
    edit(3); key('Enter'); action('remove').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(callbacks.moveTo).not.toHaveBeenCalled(); expect(callbacks.remove).not.toHaveBeenCalled()
    busy = false; controls.render(); edit(3); action('move').click(); expect(callbacks.moveTo).toHaveBeenCalledOnce()
  })

  it('blocks repeated asynchronous callbacks and releases controls on completion', async () => {
    let resolve
    callbacks.duplicateToEnd.mockReturnValueOnce(new Promise(done => { resolve = done }))
    action('duplicate').click(); action('duplicate').click(); action('remove').click()
    expect(callbacks.duplicateToEnd).toHaveBeenCalledOnce(); expect(callbacks.remove).not.toHaveBeenCalled()
    expect(action('duplicate').disabled).toBe(true)
    resolve(); await settle(); expect(action('duplicate').disabled).toBe(false)
  })

  it('surfaces a current command rejection, leaves the project unchanged and clears one-shot consent', () => {
    const before = JSON.stringify(project)
    callbacks.moveTo.mockImplementationOnce(() => { throw new Error('移動會與同軌其他片段重疊') })
    edit(4); action('move').click()
    expect(callbacks.moveTo.mock.calls[0][1].allowOverlap).toBe(false)
    expect(callbacks.onStatus).toHaveBeenCalledExactlyOnceWith('移動會與同軌其他片段重疊', true)
    expect(JSON.stringify(project)).toBe(before); expect(overlap().checked).toBe(false); expect(action('move').disabled).toBe(false)
  })

  it.each(['cancel', 'destroy', 'replace'])('suppresses late async errors after %s and never re-enables an unrelated pending action', async mode => {
    let reject, resolveNext
    callbacks.duplicateToEnd.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail }))
    action('duplicate').click()
    if (mode === 'cancel') controls.cancel()
    else if (mode === 'destroy') controls.destroy()
    else { project = structuredClone(project); controls.cancel() }
    if (mode !== 'destroy') {
      callbacks.remove.mockReturnValueOnce(new Promise(resolve => { resolveNext = resolve }))
      action('remove').click(); expect(action('remove').disabled).toBe(true)
    }
    reject(new Error('stale error')); await settle(); expect(callbacks.onStatus).not.toHaveBeenCalled()
    if (mode !== 'destroy') { expect(action('remove').disabled).toBe(true); resolveNext(); await settle(); expect(action('remove').disabled).toBe(false) }
  })

  it('hides for a single/deleted clip or hidden panel, and never permits stale commands there', () => {
    state.setMode(false); controls.render(); expect(host.hidden).toBe(true)
    action('remove').click(); expect(callbacks.remove).not.toHaveBeenCalled()
    state.select(ref('one'), { additive: true }); controls.render(); expect(host.hidden).toBe(false)
    root.hidden = true; action('remove').click(); expect(callbacks.remove).not.toHaveBeenCalled()
    root.hidden = false; project.tracks[0].clips = project.tracks[0].clips.filter(clip => clip.id !== 'one'); controls.render()
    expect(host.hidden).toBe(true); action('remove').click(); expect(callbacks.remove).not.toHaveBeenCalled()
  })

  it('does not interpolate source names and removes DOM/listeners on repeated destroy', () => {
    project.tracks[0].clips[0].name = '<img src=x onerror=alert(1)>'
    controls.render(); expect(host.querySelector('img')).toBeNull()
    const removedButton = action('remove'), removedTarget = target()
    controls.destroy(); controls.destroy(); controls.render(); removedButton.click()
    removedTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(host.children).toHaveLength(0); expect(callbacks.remove).not.toHaveBeenCalled(); expect(callbacks.moveTo).not.toHaveBeenCalled()
  })
})
