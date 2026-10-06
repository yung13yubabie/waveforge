// Actual-panel DOM integration: index.html, project commands, history, grid
// geometry and tempo controls are real. Synthetic decoding, archive loading,
// and the native render boundary are explicit doubles. The controlled tap and
// AudioContext clocks establish controller behavior, not browser DSP or tempo
// inference from audio; browser WAV/ZIP parity is covered separately.
import { readFileSync } from 'node:fs'
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { applyCommand, createProject, registerAudioBuffer } from '../../src/js/daw/project.js'
import { renderProject } from '../../src/js/daw/render.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { initModeNav } from '../../src/js/mode-nav.js'

vi.mock('../../src/js/audio/sha256.js', () => ({ sha256Hex: vi.fn(async () => 'a'.repeat(64)) }))
vi.mock('../../src/js/daw/render.js', async original => ({ ...await original(), renderProject: vi.fn() }))
vi.mock('../../src/js/daw/archive.js', () => ({
  exportProjectArchive: vi.fn(async () => new Blob(['synthetic archive boundary'])),
  importProjectArchive: vi.fn(), archiveFileName: () => 'grid-test.waveforge.zip',
  ARCHIVE_LIMITS: { archiveBytes: 256 * 1024 * 1024, manifestBytes: 1024 * 1024 },
}))

const html = readFileSync('index.html', 'utf8')
const dawCss = readFileSync('src/css/daw.css', 'utf8')
const root = () => document.getElementById('mode-editor')
const el = name => document.getElementById(`daw-${name}`)
const action = name => root().querySelector(`[data-daw="${name}"]`)
const tempoAction = name => el('tempo-tools').querySelector(`[data-tempo-action="${name}"]`)
const originField = () => el('tempo-tools').querySelector('[data-tempo-origin]')
const candidateRow = () => root().querySelector('.daw-tempo-candidate-row')
const selectedClip = () => root().querySelector('.daw-clip[aria-pressed="true"]')
const clip = () => panel.getProject().tracks[0].clips[0]
const tick = async () => { for (let index = 0; index < 20; index++) await Promise.resolve() }
const click = async name => { action(name).click(); await tick() }
const clickTempo = async name => { tempoAction(name).click(); await tick() }
const change = async (name, value) => {
  el(name).value = String(value)
  el(name).dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
const sourceFile = (name = 'synthetic-voice.wav') => {
  const bytes = Uint8Array.of(82, 73, 70, 70, 1, 2, 3, 4)
  return { name, size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
}
let panel, audio, context, sources, tapTime, decode, nav, download

async function disclosure(element, open = true) {
  if (element.open === open) return
  // Observe the actual details toggle event, including the outer disclosure;
  // setting open without delivering toggle would miss the visibility wiring.
  const toggled = new Promise(resolve => element.addEventListener('toggle', resolve, { once: true }))
  element.querySelector(':scope > summary').click()
  await toggled
  expect(element.open).toBe(open)
}
async function openTempo({ origin = false } = {}) {
  await disclosure(root().querySelector('.daw-grid-settings'))
  await disclosure(root().querySelector('details.daw-tempo-controls'))
  if (origin) await disclosure(root().querySelector('.daw-tempo-origin-details'))
}
function editOrigin(value) {
  originField().value = String(value)
  originField().dispatchEvent(new Event('input', { bubbles: true }))
}
async function setOrigin(value) {
  await openTempo({ origin: true }); editOrigin(value); await clickTempo('apply-origin')
}
function taps(count = 5, interval = 600) {
  for (let index = 0; index < count; index++) { tapTime += interval; tempoAction('tap').click() }
}
async function moveAt(value, snap = true) {
  el('snap').checked = snap
  await change('clip-at', value); await click('move')
}
async function arrow(key) {
  const target = selectedClip()
  target.focus()
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event); await tick()
  expect(event.defaultPrevented).toBe(true)
}
function seek(time) {
  el('seek').value = String(time)
  el('seek').dispatchEvent(new Event('input', { bubbles: true }))
}
function withoutGrid(project) {
  const { tempo, gridOriginSeconds, revision, ...remaining } = project
  return remaining
}
function expectGridGeometry(origin, step, zoom = Number(el('zoom').value)) {
  const timeline = el('timeline'), marker = timeline.querySelector('.daw-grid-origin-marker')
  expect(parseFloat(timeline.style.getPropertyValue('--daw-beat-width'))).toBeCloseTo(step * zoom, 12)
  expect(parseFloat(timeline.style.getPropertyValue('--daw-grid-origin'))).toBeCloseTo((origin % step) * zoom, 12)
  if (origin > 0) {
    expect(marker.dataset.gridOrigin).toBe(String(origin))
    expect(parseFloat(marker.style.left)).toBeCloseTo(origin * zoom, 12)
    expect(marker.getAttribute('aria-label')).toContain(`${origin} 秒`)
  } else expect(marker).toBeNull()
}
async function restore(project, file = sourceFile()) {
  importProjectArchive.mockResolvedValueOnce({
    project: structuredClone(project),
    files: new Map(project.assets.map(asset => [asset.id, file])),
    buffers: new Map(project.assets.map(asset => [asset.id, audio])),
  })
  await panel.openArchive(sourceFile('synthetic-session.waveforge.zip'))
}
function richProject() {
  let project = registerAudioBuffer(createProject({ name: 'Native source metadata fixture' }), new Map(), audio, {
    id: 'source-native', name: 'original-96k.wav', hash: 'b'.repeat(64),
    sourceSampleRate: 96000, decodeBackend: 'synthetic-native-metadata',
  }).project
  project = applyCommand(project, { type: 'track.add', track: { id: 'voice', name: 'Voice', gainDb: -3, pan: -.25 } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'voice', clip: {
    id: 'selected-voice', assetId: 'source-native', atSeconds: .375, offsetSeconds: .5, durationSeconds: 3,
    gainDb: -2, fadeInSeconds: .15, fadeOutSeconds: .25,
    volumeAutomation: [{ timeSeconds: 0, value: .75 }, { timeSeconds: 1, value: .5 }, { timeSeconds: 3, value: 1 }],
    gainRegions: [{ id: 'word-region', label: 'word', startSeconds: .75, endSeconds: 1.25, gain: .2, fadeInSeconds: .02, fadeOutSeconds: .03 }],
  } })
  return applyCommand(project, { type: 'timelineSelection.set', selection: { startSeconds: .625, endSeconds: 2.125 } })
}
function mountPanel() {
  download = vi.fn()
  panel = initDawPanel({ decodeAsset: decode, confirmAction: () => true, downloadFile: download,
    AudioContextClass: function () { return context } })
}
async function setup({ importAudio = true, files = [sourceFile()] } = {}) {
  document.body.replaceChildren(new DOMParser().parseFromString(html, 'text/html').getElementById('app'))
  nav = initModeNav(); nav.switchMode('editor')
  context = new AudioContext(); sources = []
  const createSource = context.createBufferSource.bind(context)
  vi.spyOn(context, 'createBufferSource').mockImplementation(() => {
    const source = createSource(); sources.push(source); return source
  })
  vi.spyOn(context, 'close')
  audio = context.createBuffer(1, 4 * 44100, 44100)
  const pcm = audio.getChannelData(0)
  for (let index = 0; index < pcm.length; index++) pcm[index] = .125 * Math.sin(index / 17)
  decode = vi.fn(async () => audio)
  renderProject.mockImplementation(async project => ({ buffer: audio, revision: project.revision,
    peak: .125, clippedSamples: 0, peaks: { samplePeakDb: -18, truePeakDb: -18 } }))
  mountPanel()
  if (importAudio) await panel.importFiles(files)
}

beforeEach(() => {
  vi.clearAllMocks(); renderProject.mockReset(); importProjectArchive.mockReset()
  tapTime = 0
  // Only tap interval estimation uses this deterministic unit-test clock.
  vi.spyOn(performance, 'now').mockImplementation(() => tapTime)
})
afterEach(() => { panel?.destroy(); panel = null; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('tempo and origin through the actual DAW panel', () => {
  it('mounts one compact disclosure in the grid fields and responds to both disclosure toggle events', async () => {
    await setup({ importAudio: false })
    expect(el('tempo-tools').parentElement.classList.contains('daw-grid-fields')).toBe(true)
    expect(root().querySelectorAll('details.daw-tempo-controls')).toHaveLength(1)
    expect(root().querySelector('.daw-grid-settings').open).toBe(false)
    expect(root().querySelector('.daw-tempo-controls').open).toBe(false)
    for (const name of ['tap', 'apply', 'reset', 'half', 'double', 'apply-origin', 'use-position', 'reset-origin']) {
      expect(tempoAction(name)?.tagName).toBe('BUTTON')
    }
    expect(originField()?.type).toBe('number')
    expect(tempoAction('tap').disabled).toBe(true)
    await disclosure(root().querySelector('.daw-grid-settings'))
    expect(tempoAction('tap').disabled).toBe(true)
    await disclosure(root().querySelector('.daw-tempo-controls'))
    expect(tempoAction('tap').disabled).toBe(false)
    taps(); expect(candidateRow().hidden).toBe(false)
    await disclosure(root().querySelector('.daw-grid-settings'), false)
    expect(candidateRow().hidden).toBe(true)
    await openTempo(); expect(tempoAction('apply').disabled).toBe(true)
    taps(); await disclosure(root().querySelector('.daw-tempo-controls'), false)
    expect(candidateRow().hidden).toBe(true)
    expect(action('undo').disabled).toBe(true)
  })

  it.each(['.daw-grid-settings', '.daw-tempo-controls', '.daw-tempo-origin-details'])('leaves Space on %s summaries to the browser without starting or pausing playback', async selector => {
    await setup(); await openTempo({ origin: true })
    const summary = root().querySelector(`${selector} > summary`), before = panel.getProject()
    const pressSpace = async () => {
      summary.focus()
      const event = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })
      summary.dispatchEvent(event); await tick()
      // jsdom does not perform native keyboard activation of <summary>. This
      // establishes only that the global transport handler leaves it alone;
      // real disclosure toggling on Space is tested in the native browser.
      expect(event.defaultPrevented).toBe(false)
    }
    await pressSpace()
    expect(renderProject).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    expect(action('play').textContent).toBe('播放混音')
    await click('play')
    expect(sources).toHaveLength(1)
    expect(action('play').textContent).toBe('暫停')
    await pressSpace()
    expect(sources).toHaveLength(1)
    expect(sources[0].stop).not.toHaveBeenCalled()
    expect(sources[0].disconnect).not.toHaveBeenCalled()
    expect(action('play').textContent).toBe('暫停')
    expect(panel.getProject()).toEqual(before)
  })

  it.each([[1.125, .625], [.123456789, .623456789]])('uses saved origin %s for manual move, lane phase and the reference marker', async (origin, position) => {
    await setup()
    await setOrigin(origin)
    expect(panel.getProject().gridOriginSeconds).toBe(origin)
    await moveAt(.72)
    expect(clip().atSeconds).toBeCloseTo(position, 12)
    expect(parseFloat(selectedClip().style.left)).toBeCloseTo(position * 48, 12)
    expectGridGeometry(origin, .5)
    // jsdom cannot paint CSS variables. Check the real stylesheet consumes the
    // tested phase variable; visual rendering is verified in the browser suite.
    expect(dawCss).toMatch(/\.daw-lane\s*\{[^}]*background-position-x:\s*var\(--daw-grid-origin,\s*0px\)/)
    await change('zoom', 96); expectGridGeometry(origin, .5, 96)
    await change('grid', .5); expectGridGeometry(origin, .25, 96)
    await change('tempo', 100); expectGridGeometry(origin, .3, 96)
    await click('undo'); expectGridGeometry(origin, .25, 96)
    await click('redo'); expectGridGeometry(origin, .3, 96)
  })

  it('moves off-grid clips to the immediate directional boundary for both buttons and keyboard', async () => {
    await setup(); await setOrigin(1.125)
    await moveAt(.74, false); el('snap').checked = true
    await click('later'); expect(clip().atSeconds).toBe(1.125)
    await click('earlier'); expect(clip().atSeconds).toBe(.625)
    await click('earlier'); expect(clip().atSeconds).toBe(.125)
    await moveAt(.74, false); el('snap').checked = true
    await arrow('ArrowLeft'); expect(clip().atSeconds).toBe(.625)
    await arrow('ArrowRight'); expect(clip().atSeconds).toBe(1.125)
    await arrow('ArrowRight'); expect(clip().atSeconds).toBe(1.625)
    expect(document.activeElement.dataset.clipId).toBe(clip().id)
  })

  it('keeps disabled snap at absolute milliseconds and unsnapped nudges at 10 ms regardless of phase', async () => {
    await setup(); await setOrigin(.123456789); await change('tempo', 137)
    await moveAt(.74149, false); expect(clip().atSeconds).toBe(.741)
    await click('later'); expect(clip().atSeconds).toBeCloseTo(.751, 12)
    await arrow('ArrowLeft'); expect(clip().atSeconds).toBeCloseTo(.741, 12)
    await moveAt(.74151, false); expect(clip().atSeconds).toBe(.742)
    expect(panel.getProject().gridOriginSeconds).toBe(.123456789)
  })

  it('changes only grid metadata, preserving source, native metadata, clip selection, automation and gain regions through undo/redo', async () => {
    await setup({ importAudio: false })
    const file = sourceFile('original-96k.wav'), bytes = await file.arrayBuffer(), pcm = audio.getChannelData(0).slice()
    await restore(richProject(), file)
    root().querySelector('.daw-clip').click()
    const before = panel.getProject(), selectedId = selectedClip().dataset.clipId
    await setOrigin(.123456789)
    const aligned = panel.getProject()
    expect(aligned.revision).toBe(before.revision + 1)
    expect(withoutGrid(aligned)).toEqual(withoutGrid(before))
    await openTempo(); taps()
    expect(panel.getProject()).toEqual(aligned)
    await clickTempo('apply'); await clickTempo('apply')
    const paced = panel.getProject()
    expect(paced.tempo).toBe(100)
    expect(paced.revision).toBe(aligned.revision + 1)
    expect(withoutGrid(paced)).toEqual(withoutGrid(before))
    expect(selectedClip().dataset.clipId).toBe(selectedId)
    expect(el('selection-title').textContent).toBe(before.tracks[0].clips[0].name)
    expect(root().querySelectorAll('.daw-region-cue')).toHaveLength(1)
    await click('undo'); expect(panel.getProject()).toEqual(aligned); expectGridGeometry(.123456789, .5)
    await click('undo'); expect(panel.getProject()).toEqual(before); expectGridGeometry(0, .5)
    expect(action('undo').disabled).toBe(true)
    await click('redo'); expect(panel.getProject()).toEqual(aligned)
    await click('redo'); expect(panel.getProject()).toEqual(paced); expectGridGeometry(.123456789, .6)
    expect(selectedClip().dataset.clipId).toBe(selectedId)
    await click('save')
    const [saved, retainedFiles] = exportProjectArchive.mock.calls.at(-1)
    expect(saved).toEqual(paced)
    expect(retainedFiles.get('source-native')).toBe(file)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(bytes))
    expect(audio.getChannelData(0)).toEqual(pcm)
    expect(decode).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
  })

  it('captures the live controller clock before the origin command stops playback, without rounding it', async () => {
    await setup(); await openTempo({ origin: true }); seek(.5)
    context.currentTime = 10
    await click('play')
    expect(sources).toHaveLength(1)
    expect(sources[0].start).toHaveBeenCalledWith(0, .5, 3.5)
    const oldSeekDisplay = Number(el('seek').value)
    // No animation frame is dispatched between this fake native-clock advance
    // and the click: reading the seek input would capture stale .5 seconds.
    context.currentTime = 10.73456789
    const expected = .5 + (context.currentTime - 10)
    const before = panel.getProject()
    await clickTempo('use-position')
    expect(expected).not.toBe(oldSeekDisplay)
    expect(panel.getProject().gridOriginSeconds).toBe(expected)
    expect(panel.getProject().revision).toBe(before.revision + 1)
    expect(withoutGrid(panel.getProject())).toEqual(withoutGrid(before))
    expect(sources[0].stop).toHaveBeenCalledOnce()
    expect(sources[0].disconnect).toHaveBeenCalledOnce()
    expect(Number(el('seek').value)).toBe(expected)
    expectGridGeometry(expected, .5)
    await click('undo'); expect(panel.getProject()).toEqual(before)
    await click('redo'); expect(panel.getProject().gridOriginSeconds).toBe(expected)
  })

  it.each(['source import', 'archive', 'name', 'tempo', 'origin', 'navigation', 'clear'])('discards project-owned tap candidates after %s and rejects a stale Apply', async reason => {
    await setup(); await openTempo({ origin: true }); taps()
    expect(candidateRow().hidden).toBe(false)
    const staleApply = tempoAction('apply')
    if (reason === 'source import') await panel.importFiles([sourceFile('second.wav')])
    else if (reason === 'archive') await restore(panel.getProject())
    else if (reason === 'name') await change('name', 'Renamed project')
    else if (reason === 'tempo') await change('tempo', 137)
    else if (reason === 'origin') { editOrigin(.375); await clickTempo('apply-origin') }
    else if (reason === 'navigation') {
      document.querySelector('.mode-tab[data-mode="master"]').click()
      expect(root().hidden).toBe(true)
      document.querySelector('.mode-tab[data-mode="editor"]').click()
    } else panel.clear()
    const after = panel.getProject()
    expect(candidateRow().hidden).toBe(true)
    expect(tempoAction('apply').disabled).toBe(true)
    staleApply.click(); await tick()
    expect(panel.getProject()).toEqual(after)
    await openTempo(); expect(tempoAction('apply').disabled).toBe(true)
  })

  it('keeps a global candidate when only clip selection changes and applies one project-level command', async () => {
    await setup({ files: [sourceFile('one.wav'), sourceFile('two.wav')] })
    await openTempo(); taps()
    const before = panel.getProject(), first = root().querySelector('.daw-clip')
    first.click()
    expect(selectedClip().dataset.clipId).toBe(first.dataset.clipId)
    expect(candidateRow().hidden).toBe(false)
    expect(panel.getProject()).toEqual(before)
    await clickTempo('double'); expect(panel.getProject()).toEqual(before)
    await clickTempo('half'); await clickTempo('apply')
    expect(panel.getProject().tempo).toBe(100)
    expect(panel.getProject().revision).toBe(before.revision + 1)
    expect(withoutGrid(panel.getProject())).toEqual(withoutGrid(before))
    expect(selectedClip().dataset.clipId).toBe(first.dataset.clipId)
    await click('undo'); expect(panel.getProject()).toEqual(before)
  })

  it('preserves project and redo state after invalid origin/BPM inputs, and allows a corrected origin', async () => {
    await setup(); await setOrigin(.25); const before = panel.getProject()
    await change('tempo', 137); await click('undo')
    expect(panel.getProject()).toEqual(before)
    for (const value of ['', '-1', '600.001', 'Infinity']) {
      editOrigin(value); await clickTempo('apply-origin')
      expect(panel.getProject()).toEqual(before)
      expect(el('status').dataset.error).toBe('true')
      expect(action('redo').disabled).toBe(false)
    }
    for (const value of ['', 19, 301]) {
      await change('tempo', value)
      expect(panel.getProject()).toEqual(before)
      expect(el('tempo').value).toBe('120')
      expect(action('redo').disabled).toBe(false)
    }
    await click('redo'); expect(panel.getProject().tempo).toBe(137)
    editOrigin(.375); await clickTempo('apply-origin')
    expect(panel.getProject().gridOriginSeconds).toBe(.375)
    expect(el('status').dataset.error).toBe('false')
  })

  it.each([true, false])('clamps nudge endpoints without empty undo entries when snap is %s', async snap => {
    await setup(); const original = panel.getProject()
    await setOrigin(1.125); el('snap').checked = snap
    const aligned = panel.getProject()
    await click('earlier'); await arrow('ArrowLeft')
    expect(panel.getProject()).toEqual(aligned)
    await click('undo'); expect(panel.getProject()).toEqual(original)
    await click('redo'); expect(panel.getProject()).toEqual(aligned)
    await moveAt(595.999, false); el('snap').checked = snap
    const nearEnd = panel.getProject()
    await click('later'); expect(clip().atSeconds).toBe(596)
    const atEnd = panel.getProject()
    await click('later'); await arrow('ArrowRight')
    expect(panel.getProject()).toEqual(atEnd)
    await click('undo'); expect(panel.getProject()).toEqual(nearEnd)
    await click('redo'); expect(panel.getProject()).toEqual(atEnd)
  })

  it('resets origin, drafts, timeline marker and undo history on a confirmed new project', async () => {
    await setup(); await setOrigin(1.125); await openTempo(); taps()
    const originalId = panel.getProject().id
    await click('clear')
    expect(panel.getProject().id).not.toBe(originalId)
    expect(panel.getProject().tracks).toEqual([])
    expect(panel.getProject().assets).toEqual([])
    expect(panel.getProject().gridOriginSeconds ?? 0).toBe(0)
    expect(originField().value).toBe('0')
    expect(candidateRow().hidden).toBe(true)
    expect(action('undo').disabled).toBe(true)
    expect(action('redo').disabled).toBe(true)
    expectGridGeometry(0, .5)
    await openTempo({ origin: true }); await clickTempo('reset-origin')
    expect(action('undo').disabled).toBe(true)
  })

  it('saves an empty BPM/origin template as a real ZIP and reopens it in a fresh panel', async () => {
    // No source media exists here, so the actual archive code exercises the
    // manifest/ZIP roundtrip without claiming native decoding coverage.
    vi.stubGlobal('Blob', NodeBlob)
    const actualArchive = await vi.importActual('../../src/js/daw/archive.js')
    exportProjectArchive.mockImplementationOnce(actualArchive.exportProjectArchive)
    importProjectArchive.mockImplementationOnce(actualArchive.importProjectArchive)
    await setup({ importAudio: false })
    expect(action('save').disabled).toBe(true)
    await change('tempo', 137.25); await setOrigin(.123456789)
    const template = panel.getProject()
    expect(template.tracks).toEqual([])
    expect(template.assets).toEqual([])
    expect(action('save').disabled).toBe(false)
    await click('save')
    expect(download).toHaveBeenCalledOnce()
    const [archive] = download.mock.calls[0]
    expect(new DataView(await archive.arrayBuffer()).getUint32(0, true)).toBe(0x04034b50)
    expect(el('save-state').textContent).toContain('已交付下載')
    panel.destroy(); mountPanel()
    expect(action('save').disabled).toBe(true)
    await panel.openArchive(archive)
    expect(panel.getProject()).toEqual(template)
    expect(originField().value).toBe('0.123456789')
    expectGridGeometry(.123456789, 60 / 137.25)
    expect(el('save-state').textContent).toBe('已開啟工程')
    expect(action('save').disabled).toBe(false)
    expect(action('undo').disabled).toBe(true)
    expect(decode).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
    await click('clear')
    expect(action('save').disabled).toBe(true)
    expect(el('save-state').textContent).toBe('尚無修改')
    expect(panel.getProject().gridOriginSeconds ?? 0).toBe(0)
  })

  it('removes document/window handlers and leaves one working tempo mount after repeated destroy/reinit', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener'), documentRemove = vi.spyOn(document, 'removeEventListener')
    const windowAdd = vi.spyOn(window, 'addEventListener'), windowRemove = vi.spyOn(window, 'removeEventListener')
    await setup({ importAudio: false })
    const documentTypes = new Set(['toggle', 'wf:mode-change', 'visibilitychange'])
    const windowTypes = new Set(['blur', 'pagehide'])
    for (let cycle = 0; cycle < 3; cycle++) {
      await openTempo(); taps()
      const before = panel.getProject(), oldPanel = panel, detachedApply = tempoAction('apply')
      await clickTempo('apply')
      expect(panel.getProject().revision).toBe(before.revision + 1)
      const final = panel.getProject()
      panel.destroy(); panel.destroy()
      expect(el('tempo-tools').children).toHaveLength(0)
      detachedApply.click(); document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
      window.dispatchEvent(new Event('blur'))
      expect(oldPanel.getProject()).toEqual(final)
      for (const args of documentAdd.mock.calls.filter(([type]) => documentTypes.has(type))) expect(documentRemove).toHaveBeenCalledWith(...args)
      for (const args of windowAdd.mock.calls.filter(([type]) => windowTypes.has(type))) expect(windowRemove).toHaveBeenCalledWith(...args)
      mountPanel()
      nav.switchMode('editor')
      expect(root().querySelectorAll('details.daw-tempo-controls')).toHaveLength(1)
      expect(candidateRow().hidden).toBe(true)
      expect(action('undo').disabled).toBe(true)
    }
    await openTempo(); taps(); await clickTempo('apply')
    expect(panel.getProject().revision).toBe(1)
    await click('undo'); expect(panel.getProject().tempo).toBe(120)
    expect(action('undo').disabled).toBe(true)
  })
})
