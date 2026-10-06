// Actual-panel integration: index.html, panel event wiring, project commands,
// selection ownership and undo/redo are real. Decoding, archive I/O and the
// native rendering boundary are explicit doubles. Pointer events model event
// ordering in jsdom; these tests do not establish native audio or browser paint.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { applyCommand, createProject, getProjectDuration, registerAudioBuffer } from '../../src/js/daw/project.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { renderProject } from '../../src/js/daw/render.js'
import { initModeNav } from '../../src/js/mode-nav.js'

vi.mock('../../src/js/audio/sha256.js', () => ({ sha256Hex: vi.fn(async () => 'a'.repeat(64)) }))
vi.mock('../../src/js/daw/render.js', async original => ({ ...await original(), renderProject: vi.fn() }))
vi.mock('../../src/js/daw/archive.js', () => ({
  exportProjectArchive: vi.fn(async () => new Blob(['synthetic archive boundary'])),
  importProjectArchive: vi.fn(), archiveFileName: () => 'multiclip-test.waveforge.zip',
  ARCHIVE_LIMITS: { archiveBytes: 256 * 1024 * 1024, manifestBytes: 1024 * 1024 },
}))

const html = readFileSync('index.html', 'utf8')
const root = () => document.getElementById('mode-editor')
const el = name => document.getElementById(`daw-${name}`)
const action = name => root().querySelector(`[data-daw="${name}"]`)
const groupAction = name => root().querySelector(`[data-group-action="${name}"]`)
const targetField = () => root().querySelector('[data-group-target]')
const overlapField = () => root().querySelector('[data-group-overlap]')
const clipNode = id => root().querySelector(`.daw-clip[data-clip-id="${id}"]`)
const allClips = project => project.tracks.flatMap(track => track.clips)
const clipOf = (project, id) => allClips(project).find(clip => clip.id === id)
const selectedRefs = () => [...root().querySelectorAll('.daw-clip[aria-pressed="true"]')]
  .map(node => ({ trackId: node.dataset.trackId, clipId: node.dataset.clipId }))
const selectedIds = () => selectedRefs().map(ref => ref.clipId).sort()
const groupIds = ['a', 'b', 'c']
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const click = async name => { action(name).click(); await tick() }
const clickGroup = async name => { groupAction(name).click(); await tick() }
const sourceFile = (name = 'synthetic-native.wav') => {
  const bytes = Uint8Array.of(82, 73, 70, 70, 1, 2, 3, 4)
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
}
const originalElementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
let panel, audio, context, decode, nav, source

function pointer(target, type, { pointerId = 7, ...options } = {}) {
  const event = new MouseEvent(type, { button: 0, clientX: 100, clientY: 20, bubbles: true, cancelable: true, ...options })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  target.dispatchEvent(event)
  return event
}
function pressClip(id, options = {}) {
  const node = clipNode(id)
  const down = pointer(node, 'pointerdown', options)
  // Native focus follows an uncancelled pointerdown, before click. Calling
  // .click() alone would miss the focusin that can incorrectly collapse refs.
  if (!down.defaultPrevented) node.focus()
  pointer(window, 'pointerup', options)
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...options }))
}
async function selectGroup(ids = groupIds) {
  pressClip(ids[0])
  for (const id of ids.slice(1)) pressClip(id, { shiftKey: true })
  await tick()
  expect(selectedIds()).toEqual([...ids].sort())
}
function key(target, key, options = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event)
  return event
}
function editTarget(value) {
  targetField().value = String(value)
  targetField().dispatchEvent(new Event('input', { bubbles: true }))
}
async function change(name, value) {
  el(name).value = String(value)
  el(name).dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
async function setSnap(enabled) {
  el('snap').checked = enabled
  el('snap').dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
function assertUnchanged(project, refs, history) {
  expect(panel.getProject()).toEqual(project)
  expect(selectedRefs()).toEqual(refs)
  expect([action('undo').disabled, action('redo').disabled]).toEqual(history)
}
function assertMoved(before, after, delta, ids = groupIds) {
  expect(after.revision).toBe(before.revision + 1)
  expect(after.assets).toEqual(before.assets)
  expect(after.tempo).toBe(before.tempo)
  expect(after.gridOriginSeconds).toBe(before.gridOriginSeconds)
  for (const track of before.tracks) {
    const movedTrack = after.tracks.find(item => item.id === track.id)
    expect(movedTrack).toEqual({ ...track, clips: track.clips.map(clip => ids.includes(clip.id)
      ? { ...clip, atSeconds: clip.atSeconds + delta } : clip) })
  }
}
function beginDrag(id = 'b', options = {}) {
  const node = clipNode(id)
  const down = pointer(node, 'pointerdown', options)
  if (!down.defaultPrevented) node.focus()
  pointer(window, 'pointermove', { clientX: 148, ...options })
  return node
}

function fixture() {
  let project = registerAudioBuffer(createProject({ name: 'Multi-clip source recipe fixture', tempo: 120, gridOriginSeconds: .125 }),
    new Map(), audio, { id: 'source-native', name: source.name, hash: 'b'.repeat(64),
      sourceSampleRate: 96000, decodeBackend: 'synthetic-native-metadata' }).project
  for (const [id, gainDb, pan] of [['voice', -3, -.25], ['music', -8, .5]]) {
    project = applyCommand(project, { type: 'track.add', track: { id, name: id, gainDb, pan } })
  }
  for (const [trackId, id, atSeconds, durationSeconds] of [
    ['voice', 'a', .25, .75], ['voice', 'b', 1.5, .5], ['music', 'c', 2.25, .25],
    ['voice', 'blocker', 5, 1], ['music', 'distant', 8.137, .5],
  ]) {
    project = applyCommand(project, { type: 'clip.add', trackId, clip: { id, name: id, assetId: 'source-native',
      atSeconds, offsetSeconds: 11.5 / 44100, durationSeconds, gainDb: -2, fadeInSeconds: .0625, fadeOutSeconds: .125,
      gainEnvelope: [{ timeSeconds: 0, value: .3 }, { timeSeconds: durationSeconds / 2, value: 1 }, { timeSeconds: durationSeconds, value: .7 }],
      volumeAutomation: [{ timeSeconds: 0, value: .8 }, { timeSeconds: durationSeconds / 2, value: .5 }, { timeSeconds: durationSeconds, value: 1.2 }],
    } })
  }
  return applyCommand(project, { type: 'track.gainRegion.add', trackId: 'voice', region: {
    id: 'common-ramp', label: 'shared vocal ramp', startSeconds: .25, endSeconds: 2, gain: .4, fadeInSeconds: .75, fadeOutSeconds: .75,
  } })
}
async function restore(project = fixture()) {
  importProjectArchive.mockResolvedValueOnce({ project: structuredClone(project),
    files: new Map(project.assets.map(asset => [asset.id, source])),
    buffers: new Map(project.assets.map(asset => [asset.id, audio])),
  })
  await panel.openArchive(sourceFile('synthetic-session.waveforge.zip'))
}
async function setup() {
  document.body.replaceChildren(new DOMParser().parseFromString(html, 'text/html').getElementById('app'))
  nav = initModeNav(); nav.switchMode('editor')
  context = new AudioContext()
  audio = context.createBuffer(1, 4 * 44100, 44100)
  audio.getChannelData(0).fill(.125)
  source = sourceFile()
  decode = vi.fn(async () => audio)
  panel = initDawPanel({ decodeAsset: decode, confirmAction: () => true, downloadFile: vi.fn(), AudioContextClass: function () { return context } })
  await restore()
  expect(action('undo').disabled).toBe(true)
  expect(action('redo').disabled).toBe(true)
}

beforeEach(() => { vi.clearAllMocks(); importProjectArchive.mockReset(); renderProject.mockReset() })
afterEach(() => {
  panel?.destroy(); panel = null; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalElementFromPoint) Object.defineProperty(document, 'elementFromPoint', originalElementFromPoint)
  else delete document.elementFromPoint
})

describe('multi-clip selection through the actual DAW panel', () => {
  it('uses additive Shift clicks across tracks, with pointer/focus/click ordering and no project history changes', async () => {
    await setup()
    const before = panel.getProject()
    await selectGroup()
    expect(selectedRefs()).toEqual([{ trackId: 'voice', clipId: 'a' }, { trackId: 'voice', clipId: 'b' }, { trackId: 'music', clipId: 'c' }])
    expect(el('group-tools').hidden).toBe(false)
    expect(el('clip-fields').hidden).toBe(true)
    expect(el('clip-fields').disabled).toBe(true)
    expect(Number(targetField().value)).toBe(.25)
    expect(overlapField().checked).toBe(false)
    pressClip('b', { shiftKey: true }); await tick()
    expect(selectedIds()).toEqual(['a', 'c'])
    pressClip('c', { shiftKey: true }); await tick()
    expect(selectedIds()).toEqual(['a'])
    expect(el('group-tools').hidden).toBe(true)
    expect(el('clip-fields').hidden).toBe(false)
    expect(el('clip-fields').disabled).toBe(false)
    expect(panel.getProject()).toEqual(before)
    expect(action('undo').disabled).toBe(true)
  })

  it('supports mobile toggling, clear without leaving mode, and exit to one primary clip', async () => {
    await setup(); await click('multi-select')
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('true')
    for (const id of groupIds) pressClip(id)
    await tick(); expect(selectedIds()).toEqual(groupIds)
    pressClip('b'); await tick(); expect(selectedIds()).toEqual(['a', 'c'])
    await clickGroup('clear')
    expect(selectedIds()).toEqual([])
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('true')
    for (const id of ['a', 'c']) pressClip(id)
    await tick(); expect(selectedIds()).toEqual(['a', 'c'])
    await clickGroup('exit')
    expect(selectedIds()).toHaveLength(1)
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('false')
    expect(el('clip-fields').hidden).toBe(false)
    expect(action('undo').disabled).toBe(true)
  })

  it.each(['ctrlKey', 'metaKey'])('limits %s+A to timeline focus and leaves text editing alone', async modifier => {
    await setup()
    const before = panel.getProject()
    el('name').focus()
    expect(key(el('name'), 'a', { [modifier]: true }).defaultPrevented).toBe(false)
    expect(selectedIds()).toEqual([])
    action('play').focus()
    expect(key(action('play'), 'a', { [modifier]: true }).defaultPrevented).toBe(false)
    el('timeline').focus()
    expect(key(el('timeline'), 'a', { [modifier]: true }).defaultPrevented).toBe(true)
    await tick()
    expect(selectedIds()).toEqual(allClips(before).map(clip => clip.id).sort())
    expect(el('group-tools').hidden).toBe(false)
    expect(panel.getProject()).toEqual(before)
    expect(action('undo').disabled).toBe(true)
    key(el('timeline'), 'Escape'); await tick()
    expect(selectedIds()).toHaveLength(1)
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('false')
  })

  it('accepts group arrow keys and Delete from the timeline after selecting all without moving focus to a clip', async () => {
    await setup()
    el('timeline').focus()
    expect(key(el('timeline'), 'a', { ctrlKey: true }).defaultPrevented).toBe(true)
    await tick()
    const refs = selectedRefs(), ids = refs.map(ref => ref.clipId)
    let before = panel.getProject()
    for (const [pressedKey, delta] of [['ArrowRight', .375], ['ArrowLeft', -.5]]) {
      expect(document.activeElement).toBe(el('timeline'))
      expect(key(el('timeline'), pressedKey).defaultPrevented).toBe(true)
      await tick()
      assertMoved(before, panel.getProject(), delta, ids)
      expect(selectedRefs()).toEqual(refs)
      before = panel.getProject()
    }
    expect(document.activeElement).toBe(el('timeline'))
    expect(key(el('timeline'), 'Delete').defaultPrevented).toBe(true)
    await tick()
    expect(allClips(panel.getProject())).toEqual([])
    expect(panel.getProject().revision).toBe(before.revision + 1)
    expect(selectedRefs()).toEqual([])
    await click('undo')
    expect(panel.getProject()).toEqual(before)
    expect(selectedRefs()).toEqual(refs)
  })

  it.each(['clear', 'remove', 'exit'])('returns focus to the timeline when focused group %s hides its controls', async groupOperation => {
    await setup(); await selectGroup()
    const before = panel.getProject(), control = groupAction(groupOperation)
    control.focus()
    expect(document.activeElement).toBe(control)
    await clickGroup(groupOperation)
    expect(el('group-tools').hidden).toBe(true)
    expect(document.activeElement).toBe(el('timeline'))
    expect(selectedRefs()).toHaveLength(groupOperation === 'exit' ? 1 : 0)
    if (groupOperation === 'remove') expect(panel.getProject().revision).toBe(before.revision + 1)
    else {
      expect(panel.getProject()).toEqual(before)
      expect(action('undo').disabled).toBe(true)
    }
  })

  it('makes hidden single-clip actions unavailable while a group is selected', async () => {
    await setup(); await selectGroup()
    const before = panel.getProject(), refs = selectedRefs()
    expect(el('clip-fields').hidden).toBe(true)
    expect(el('clip-fields').disabled).toBe(true)
    // Programmatic events exercise guards too, rather than relying solely on
    // native fieldset disabling, which jsdom only partially models.
    for (const name of ['move', 'trim', 'split', 'duplicate', 'delete', 'fades', 'transpose-render', 'replace']) {
      action(name).dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await tick()
      assertUnchanged(before, refs, [true, true])
    }
    expect(decode).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
  })

  it('uses Escape in the group field to cancel its draft, then Escape on the timeline to exit multi-select', async () => {
    await setup(); await selectGroup()
    const before = panel.getProject(), refs = selectedRefs()
    editTarget(1.75)
    overlapField().checked = true
    overlapField().dispatchEvent(new Event('change', { bubbles: true }))
    targetField().focus()
    expect(key(targetField(), 'Escape').defaultPrevented).toBe(true)
    await tick()
    // Field Escape dismisses an in-progress numeric/overlap edit. Only the
    // timeline's Escape exits the group, so editing does not lose selected IDs.
    assertUnchanged(before, refs, [true, true])
    expect(Number(targetField().value)).toBe(.25)
    expect(overlapField().checked).toBe(false)
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('true')
    el('timeline').focus()
    key(el('timeline'), 'Escape'); await tick()
    expect(selectedIds()).toHaveLength(1)
    expect(action('multi-select').getAttribute('aria-pressed')).toBe('false')
    expect(panel.getProject()).toEqual(before)
    expect(action('undo').disabled).toBe(true)
  })

  it('stops playback and resets the cursor when the already selected single clip is clicked again', async () => {
    await setup()
    clipNode('a').click(); await tick()
    const before = panel.getProject(), refs = selectedRefs()
    const createSource = vi.spyOn(context, 'createBufferSource')
    // Playback transport runs against the existing fake Web Audio context;
    // its mix is supplied at the explicit native-render boundary only.
    const mix = context.createBuffer(1, Math.ceil(getProjectDuration(before) * before.sampleRate), before.sampleRate)
    renderProject.mockResolvedValueOnce({ buffer: mix, revision: before.revision, peak: .125,
      clippedSamples: 0, peaks: { samplePeakDb: -18, truePeakDb: -18 } })
    context.currentTime = 10
    await click('play')
    expect(createSource).toHaveBeenCalledOnce()
    const playbackSource = createSource.mock.results[0].value
    expect(playbackSource.start).toHaveBeenCalledWith(0, .25, getProjectDuration(before) - .25)
    expect(action('play').textContent).toBe('暫停')
    // Advance the mock audio clock beyond the clip start, then activate the
    // same clip without a selection change. Selection equality must not skip
    // the existing stop-and-seek behavior.
    context.currentTime = 11.5
    clipNode('a').click(); await tick()
    expect(playbackSource.stop).toHaveBeenCalledOnce()
    expect(playbackSource.disconnect).toHaveBeenCalledOnce()
    expect(Number(el('seek').value)).toBe(.25)
    expect(action('play').textContent).toBe('播放混音')
    assertUnchanged(before, refs, [true, true])
    expect(renderProject).toHaveBeenCalledOnce()
  })
})

describe('atomic edits and history through the actual group controls', () => {
  it('moves one common delta, preserves source recipes, and restores refs in one Undo/Redo', async () => {
    await setup(); await selectGroup()
    await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs(), pcm = audio.getChannelData(0).slice()
    editTarget(1.75); await clickGroup('move')
    const moved = panel.getProject()
    assertMoved(before, moved, 1.5)
    expect(selectedRefs()).toEqual(refs)
    expect(action('undo').disabled).toBe(false)
    await click('undo'); assertUnchanged(before, refs, [true, false])
    await click('redo'); assertUnchanged(moved, refs, [false, true])
    await click('save')
    const [saved, files] = exportProjectArchive.mock.calls.at(-1)
    expect(saved).toEqual(moved)
    expect(files.get('source-native')).toBe(source)
    expect(audio.getChannelData(0)).toEqual(pcm)
    expect(decode).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
  })

  it('nudges from the earliest clip on the shifted grid, including keyboard and unsnapped steps', async () => {
    await setup(); await selectGroup()
    let before = panel.getProject()
    await clickGroup('nudge-right'); assertMoved(before, panel.getProject(), .375)
    before = panel.getProject()
    await clickGroup('nudge-left'); assertMoved(before, panel.getProject(), -.5)
    before = panel.getProject()
    clipNode('b').focus()
    expect(selectedIds()).toEqual(groupIds)
    expect(key(clipNode('b'), 'ArrowRight').defaultPrevented).toBe(true)
    await tick(); assertMoved(before, panel.getProject(), .5)
    await setSnap(false)
    before = panel.getProject()
    await clickGroup('nudge-left'); assertMoved(before, panel.getProject(), -.01)
    expect(selectedIds()).toEqual(groupIds)
  })

  it.each([true, false])('duplicates after the whole project, retaining track/source recipes and selecting copies (snap=%s)', async snap => {
    await setup(); await selectGroup(); await setSnap(snap)
    const before = panel.getProject(), originals = selectedRefs(), end = getProjectDuration(before)
    await clickGroup('duplicate')
    const copied = panel.getProject(), copies = selectedRefs()
    expect(copied.revision).toBe(before.revision + 1)
    expect(allClips(copied)).toHaveLength(allClips(before).length + groupIds.length)
    expect(copied.assets).toEqual(before.assets)
    expect(copies).toHaveLength(groupIds.length)
    expect(copies.every(ref => !allClips(before).some(clip => clip.id === ref.clipId))).toBe(true)
    const earliest = Math.min(...copies.map(ref => clipOf(copied, ref.clipId).atSeconds))
    expect(earliest).toBeGreaterThanOrEqual(end)
    expect(earliest).toBe(snap ? 9.125 : end)
    const delta = earliest - .25
    for (const track of before.tracks) {
      const afterTrack = copied.tracks.find(item => item.id === track.id)
      for (const clip of track.clips) expect(afterTrack.clips.find(item => item.id === clip.id)).toEqual(clip)
      for (const original of track.clips.filter(clip => groupIds.includes(clip.id))) {
        const duplicate = afterTrack.clips.find(clip => copies.some(ref => ref.clipId === clip.id) && clip.name === original.name)
        expect(duplicate).toEqual({ ...original, id: duplicate.id, atSeconds: original.atSeconds + delta })
      }
    }
    await click('undo'); assertUnchanged(before, originals, [true, false])
    await click('redo'); assertUnchanged(copied, copies, [false, true])
    expect(decode).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
  })

  it('deletes the selected group atomically, clearing refs and restoring them through Undo/Redo', async () => {
    await setup(); await selectGroup()
    const before = panel.getProject(), refs = selectedRefs()
    await clickGroup('remove')
    const removed = panel.getProject()
    expect(removed.revision).toBe(before.revision + 1)
    expect(allClips(removed).map(clip => clip.id).sort()).toEqual(['blocker', 'distant'])
    expect(removed.tracks).toHaveLength(before.tracks.length)
    expect(removed.assets).toEqual(before.assets)
    expect(selectedIds()).toEqual([])
    expect(el('group-tools').hidden).toBe(true)
    await click('undo'); assertUnchanged(before, refs, [true, false])
    await click('redo'); assertUnchanged(removed, [], [false, true])
  })

  it('rejects invalid targets and forbidden overlap without changing project, selection or redo history', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    editTarget(1.75); await clickGroup('move')
    const moved = panel.getProject()
    await click('undo')
    const before = panel.getProject(), refs = selectedRefs()
    for (const value of ['', '-1', '600', 'Infinity', '4.75']) {
      editTarget(value); await clickGroup('move')
      assertUnchanged(before, refs, [true, false])
      expect(el('status').dataset.error).toBe('true')
    }
    await click('redo'); assertUnchanged(moved, refs, [false, true])
  })

  it('requires explicit overlap consent and resets it after the authorized group edit', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    editTarget(4.75); await clickGroup('move')
    assertUnchanged(before, refs, [true, true])
    expect(overlapField().checked).toBe(false)
    editTarget(4.75)
    overlapField().checked = true
    overlapField().dispatchEvent(new Event('change', { bubbles: true }))
    await clickGroup('move')
    assertMoved(before, panel.getProject(), 4.5)
    expect(overlapField().checked).toBe(false)
    await click('undo'); assertUnchanged(before, refs, [true, false])
  })
})

describe('group gesture and queued-action ownership', () => {
  it('drags all members by a common delta, keeps tracks, and commits one history entry', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    const node = beginDrag('b')
    expect(selectedRefs()).toEqual(refs)
    expect(panel.getProject()).toEqual(before)
    for (const id of groupIds) expect(parseFloat(clipNode(id).style.left)).toBeCloseTo((clipOf(before, id).atSeconds + 1) * 48)
    // Dropping over another track must not route any member out of its track.
    Object.defineProperty(document, 'elementFromPoint', { configurable: true,
      value: () => root().querySelector('.daw-lane[data-track-id="music"]') })
    pointer(window, 'pointerup', { clientX: 148 })
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await tick()
    const moved = panel.getProject()
    assertMoved(before, moved, 1)
    expect(selectedRefs()).toEqual(refs)
    await click('undo'); assertUnchanged(before, refs, [true, false])
    await click('redo'); assertUnchanged(moved, refs, [false, true])
  })

  it.each(['ctrlKey', 'metaKey'])('restores every drag preview when %s+A changes selection while the pointer is held', async modifier => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject()
    beginDrag('b')
    expect(parseFloat(clipNode('a').style.left)).toBeCloseTo((clipOf(before, 'a').atSeconds + 1) * 48)
    expect(key(clipNode('b'), 'a', { [modifier]: true }).defaultPrevented).toBe(true)
    const refs = selectedRefs()
    expect(selectedIds()).toEqual(allClips(before).map(clip => clip.id).sort())
    // Check immediately after select-all, before pointerup can repaint. This
    // catches a cancelled gesture leaving stale preview positions on screen.
    for (const clip of allClips(before)) expect(parseFloat(clipNode(clip.id).style.left)).toBeCloseTo(clip.atSeconds * 48)
    pointer(window, 'pointerup', { clientX: 148 }); await tick()
    assertUnchanged(before, refs, [true, true])
    for (const clip of allClips(before)) expect(parseFloat(clipNode(clip.id).style.left)).toBeCloseTo(clip.atSeconds * 48)
  })

  it.each(['Escape', 'pointercancel'])('cancels %s without changing project, refs or history', async reason => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    beginDrag()
    if (reason === 'Escape') key(el('timeline'), 'Escape')
    else pointer(window, 'pointercancel')
    pointer(window, 'pointerup', { clientX: 148 }); await tick()
    assertUnchanged(before, refs, [true, true])
    for (const id of groupIds) expect(parseFloat(clipNode(id).style.left)).toBeCloseTo(clipOf(before, id).atSeconds * 48)
  })

  it('rejects a drag into a same-track collision and restores every preview without consuming redo', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    editTarget(1.75); await clickGroup('move')
    const moved = panel.getProject()
    await click('undo')
    const before = panel.getProject(), refs = selectedRefs()
    beginDrag()
    pointer(window, 'pointermove', { clientX: 316 })
    pointer(window, 'pointerup', { clientX: 316 }); await tick()
    assertUnchanged(before, refs, [true, false])
    expect(el('status').dataset.error).toBe('true')
    for (const id of groupIds) expect(parseFloat(clipNode(id).style.left)).toBeCloseTo(clipOf(before, id).atSeconds * 48)
    await click('redo'); assertUnchanged(moved, refs, [false, true])
  })

  it('ignores a different pointer release and still accepts the owning pointer', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    beginDrag('b', { pointerId: 7 })
    pointer(window, 'pointerup', { pointerId: 8, clientX: 196 }); await tick()
    assertUnchanged(before, refs, [true, true])
    pointer(window, 'pointerup', { pointerId: 7, clientX: 148 }); await tick()
    assertMoved(before, panel.getProject(), 1)
  })

  it.each(['source import', 'archive open', 'clear', 'mode change', 'project edit'])('retires stale drag ownership on %s', async reason => {
    await setup(); await selectGroup(); await setSnap(false)
    const original = panel.getProject()
    beginDrag()
    if (reason === 'source import') await panel.importFiles([sourceFile('new-source.wav')])
    else if (reason === 'archive open') await restore(original)
    else if (reason === 'clear') panel.clear()
    else if (reason === 'mode change') { nav.switchMode('master'); nav.switchMode('editor') }
    else await change('name', 'Newer project revision')
    const after = panel.getProject(), refs = selectedRefs(), history = [action('undo').disabled, action('redo').disabled]
    pointer(window, 'pointermove', { clientX: 196 })
    pointer(window, 'pointerup', { clientX: 196 }); await tick()
    assertUnchanged(after, refs, history)
    if (reason !== 'clear') for (const id of groupIds) expect(clipOf(after, id).atSeconds).toBe(clipOf(original, id).atSeconds)
  })

  it('rejects a stale Move press after selection changes before its click', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject()
    editTarget(1.75)
    const control = groupAction('move')
    pointer(control, 'pointerdown')
    pressClip('distant')
    const refs = selectedRefs()
    pointer(window, 'pointerup')
    control.click()
    await tick()
    assertUnchanged(before, refs, [true, true])
  })

  it.each(['ArrowRight', 'Delete'])('rejects queued %s when selection changes before the keyboard command runs', async pressedKey => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject()
    clipNode('b').focus()
    expect(key(clipNode('b'), pressedKey).defaultPrevented).toBe(true)
    // Unlike group button callbacks, keyboard commands use the panel's queue.
    // New refs must invalidate their captured owner before that queue executes.
    pressClip('c')
    const refs = selectedRefs()
    await tick()
    expect(refs.map(ref => ref.clipId)).toEqual(['a', 'b'])
    assertUnchanged(before, refs, [true, true])
  })

  it('rejects a queued drag release when clear replaces the project before commit', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    beginDrag()
    pointer(window, 'pointerup', { clientX: 148 })
    panel.clear()
    const cleared = panel.getProject()
    await tick()
    assertUnchanged(cleared, [], [true, true])
    expect(el('status').dataset.error).toBe('false')
  })
})


describe('secondary pointer ownership regressions', () => {
  it('ignores a click from another primary pointer while the owning drag is active', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    beginDrag('b', { pointerId: 7 })
    const second = new MouseEvent('pointerdown', { button: 0, clientX: 300, clientY: 20, bubbles: true, cancelable: true })
    Object.defineProperties(second, { pointerId: { value: 8 }, isPrimary: { value: true } })
    clipNode('c').dispatchEvent(second)
    pointer(window, 'pointerup', { pointerId: 8, clientX: 300 })
    clipNode('c').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(selectedRefs()).toEqual(refs)
    pointer(window, 'pointerup', { pointerId: 7, clientX: 148 }); await tick()
    assertMoved(before, panel.getProject(), 1)
  })
  it('ignores a secondary contact while preserving the owning group drag', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject(), refs = selectedRefs()
    beginDrag('b', { pointerId: 7 })
    const second = new MouseEvent('pointerdown', { button: 0, clientX: 300, clientY: 20, bubbles: true, cancelable: true })
    Object.defineProperties(second, { pointerId: { value: 8 }, isPrimary: { value: false } })
    clipNode('c').dispatchEvent(second)
    pointer(window, 'pointerup', { pointerId: 8, clientX: 300 })
    pointer(window, 'pointerup', { pointerId: 7, clientX: 148 }); await tick()
    expect(selectedRefs()).toEqual(refs)
    assertMoved(before, panel.getProject(), 1)
  })
  it('ignores cancellation from a non-owning pointer', async () => {
    await setup(); await selectGroup(); await setSnap(false)
    const before = panel.getProject()
    beginDrag('b', { pointerId: 7 })
    pointer(window, 'pointercancel', { pointerId: 8 })
    pointer(window, 'pointerup', { pointerId: 7, clientX: 148 }); await tick()
    assertMoved(before, panel.getProject(), 1)
  })
})
