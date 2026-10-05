import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { initDawPanel, formatDawTime, snapDawTime } from '../../src/js/daw/panel.js'
import { createProject } from '../../src/js/daw/project.js'
import { initModeNav } from '../../src/js/mode-nav.js'
import { renderProject } from '../../src/js/daw/render.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'

vi.mock('../../src/js/audio/sha256.js', () => ({ sha256Hex: vi.fn(async () => 'a'.repeat(64)) }))
vi.mock('../../src/js/daw/render.js', () => ({ renderProject: vi.fn() }))
vi.mock('../../src/js/daw/archive.js', () => ({
  exportProjectArchive: vi.fn(async () => new Blob(['zip'])),
  importProjectArchive: vi.fn(), archiveFileName: () => 'session.waveforge.zip',
}))
const html = readFileSync('index.html', 'utf8')
const el = id => document.getElementById(`daw-${id}`)
const action = id => document.querySelector(`[data-daw="${id}"]`)
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const click = async id => { action(id).click(); await tick() }
const change = async (id, value) => { el(id).value = String(value); el(id).dispatchEvent(new Event('change', { bubbles: true })); await tick() }
const makeFile = (name = 'voice.wav') => ({ name, size: 8, arrayBuffer: async () => new ArrayBuffer(8) })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
let panel, download, decode, confirm, toMaster
const getBuffer = (seconds = 4) => { const ctx = new AudioContext(); const buffer = ctx.createBuffer(1, seconds * 48000, 48000); buffer.getChannelData(0).fill(.1); return buffer }
async function setup({ importAudio = true, decodeAsset, confirmAction, sendToMaster, AudioContextClass } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(parsed.getElementById('app'))
  document.getElementById('mode-editor').hidden = false
  download = vi.fn(); decode = decodeAsset || vi.fn(async () => getBuffer()); confirm = confirmAction || vi.fn(() => true); toMaster = sendToMaster || vi.fn(async () => true)
  panel = initDawPanel({ decodeAsset: decode, confirmAction: confirm, downloadFile: download, onSendToMaster: toMaster, AudioContextClass })
  if (importAudio) await panel.importFiles([makeFile()])
  return panel
}
function clip() { return panel.getProject().tracks[0]?.clips[0] }
function trackChange(field, value) {
  const control = document.querySelector(`[data-track-control="${field}"]`)
  control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); return tick()
}
beforeEach(() => {
  vi.clearAllMocks()
  renderProject.mockImplementation(async project => ({ buffer: getBuffer(), revision: project.revision, peak: .1, clippedSamples: 0, peaks: { samplePeakDb: -20, truePeakDb: -19.9 } }))
})
afterEach(() => { panel?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })

describe('local DAW panel', () => {
  it('formats time and snaps only positions to the chosen beat grid', () => {
    expect(formatDawTime(65.125)).toBe('01:05.125')
    expect(snapDawTime(.74, 120, 1, true)).toBe(.5)
    expect(snapDawTime(.741, 120, 1, false)).toBe(.741)
  })
  it('imports audio as real tracks and clips; one undo removes a whole batch and redo restores it', async () => {
    await setup({ importAudio: false }); await panel.importFiles([makeFile('voice.wav'), makeFile('beat.wav')])
    expect(panel.getProject().tracks).toHaveLength(2)
    expect(panel.getProject().assets).toHaveLength(2)
    expect(document.querySelectorAll('.daw-wave path')).toHaveLength(2)
    await click('undo'); expect(panel.getProject().tracks).toHaveLength(0)
    await click('redo'); expect(panel.getProject().tracks).toHaveLength(2)
    expect(el('save-state').textContent).toContain('未下載')
  })
  it('binds move, duplicate, trim, split, delete and undo to clip commands', async () => {
    await setup()
    await click('later'); expect(clip().atSeconds).toBe(.5)
    el('snap').checked = false
    await change('clip-at', 1.25); await click('move'); expect(clip().atSeconds).toBe(1.25)
    await change('trim-start', 2); await change('trim-end', 4); await click('trim')
    expect(clip()).toMatchObject({ atSeconds: 2, offsetSeconds: .75, durationSeconds: 2 })
    el('seek').value = '3'; el('seek').dispatchEvent(new Event('input'))
    await click('split'); expect(panel.getProject().tracks[0].clips).toHaveLength(2)
    await click('duplicate'); expect(panel.getProject().tracks[0].clips).toHaveLength(3)
    await click('delete'); expect(panel.getProject().tracks[0].clips).toHaveLength(2)
    await click('undo'); expect(panel.getProject().tracks[0].clips).toHaveLength(3)
  })
  it('retains the selected split clip across duplicate undo/redo and exposes fades through its disclosure', async () => {
    await setup({ importAudio: false }); await panel.importFiles([makeFile('one.wav'), makeFile('two.wav')])
    await click('later'); await change('trim-start', 1); await change('trim-end', 4); await click('trim')
    el('seek').value = '2'; el('seek').dispatchEvent(new Event('input'))
    await click('split')
    const selectedId = document.querySelector('.daw-clip[aria-pressed="true"]').dataset.clipId
    await click('duplicate'); await click('undo'); await click('redo')
    expect(document.querySelectorAll('.daw-clip')).toHaveLength(4)
    expect(document.querySelector('.daw-clip[aria-pressed="true"]').dataset.clipId).toBe(selectedId)
    expect(el('clip-fields').disabled).toBe(false)
    const detail = el('fade-in').closest('details')
    expect(detail.open).toBe(false)
    detail.querySelector('summary').click()
    expect(detail.open).toBe(true)
    await change('fade-in', .05); await change('fade-out', .05); await click('fades')
    const savedClip = panel.getProject().tracks.flatMap(track => track.clips).find(clip => clip.id === selectedId)
    expect(savedClip).toMatchObject({ fadeInSeconds: .05, fadeOutSeconds: .05 })
  })
  it('preserves exact beat positions when trimming at a non-integer-second tempo', async () => {
    await setup(); await change('tempo', 137); await click('later')
    const position = clip().atSeconds
    expect(el('trim-start').value).toBe(String(position))
    await change('trim-end', position + 2); await click('trim')
    expect(clip().durationSeconds).toBeCloseTo(2, 12)
    expect(el('status').dataset.error).toBe('false')
  })
  it('keeps overlapping clips visually selectable on separate rows within the same track', async () => {
    await setup(); await click('duplicate')
    const buttons = [...document.querySelectorAll('.daw-clip')]
    buttons[1].click(); await change('clip-at', 0); await click('move')
    const positions = [...document.querySelectorAll('.daw-clip')].map(item => item.style.top)
    expect(new Set(positions).size).toBe(2)
  })
  it('synchronizes keyboard-focused clips and preserves focus after changing a track control', async () => {
    await setup(); await panel.importFiles([makeFile('second.wav')])
    const firstClip = document.querySelector('.daw-clip')
    firstClip.focus(); firstClip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick()
    expect(panel.getProject().tracks[0].clips[0].atSeconds).toBe(.5)
    expect(panel.getProject().tracks[1].clips[0].atSeconds).toBe(0)
    const mute = document.querySelector('[data-track-control="mute"]')
    mute.focus(); mute.click(); await tick()
    expect(document.activeElement.dataset.trackControl).toBe('mute')
  })
  it('moves between tracks while retaining inspector selection', async () => {
    await setup(); await click('add-track')
    const otherId = panel.getProject().tracks[1].id
    await change('clip-track', otherId); await click('move')
    expect(panel.getProject().tracks[1].clips).toHaveLength(1)
    expect(el('clip-fields').disabled).toBe(false)
    await click('later'); expect(panel.getProject().tracks[1].clips[0].atSeconds).toBe(.5)
  })
  it('binds track gain, pan, mute, solo, fades, clip gain and total gain to project metadata', async () => {
    await setup(); await trackChange('gainDb', -3); await trackChange('pan', -.5)
    document.querySelector('[data-track-control="mute"]').click(); await tick()
    document.querySelector('[data-track-control="solo"]').click(); await tick()
    await change('fade-in', .2); await change('fade-out', .3); await click('fades')
    await change('clip-gain', -2); await change('master-gain', -5)
    expect(panel.getProject().tracks[0]).toMatchObject({ gainDb: -3, pan: -.5, mute: true, solo: true })
    expect(clip()).toMatchObject({ gainDb: -2, fadeInSeconds: .2, fadeOutSeconds: .3 })
    expect(panel.getProject().masterGainDb).toBe(-5)
  })
  it('shows validation failure without changing audio state and supports correction', async () => {
    await setup(); const before = panel.getProject()
    await change('fade-in', 3); await change('fade-out', 3); await click('fades')
    expect(panel.getProject()).toEqual(before)
    expect(el('status').dataset.error).toBe('true')
    await change('fade-in', .1); await change('fade-out', .1); await click('fades')
    expect(clip().fadeInSeconds).toBe(.1)
  })
  it('restores canonical displayed values after rejected immediate parameter edits', async () => {
    await setup(); await change('master-gain', 99); await trackChange('gainDb', 99)
    expect(el('master-gain').value).toBe('0')
    expect(document.querySelector('input[data-track-control="gainDb"]').value).toBe('0')
    expect(panel.getProject().masterGainDb).toBe(0)
  })
  it('uses the same renderer result for preview and WAV, then invalidates it on edits', async () => {
    await setup(); await click('play'); await click('play'); await click('export')
    expect(renderProject).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledWith(expect.any(Blob), '未命名專案-mix.wav')
    await change('sample-rate', 44100); await click('export')
    expect(renderProject).toHaveBeenCalledTimes(2)
    expect(renderProject.mock.calls[1][0].sampleRate).toBe(44100)
  })
  it('blocks integer export on true-peak overload and allows explicit reduced-gain rerender', async () => {
    await setup()
    renderProject.mockResolvedValueOnce({ buffer: getBuffer(), revision: 3, peak: .98, peaks: { samplePeakDb: -.2, truePeakDb: .5 } })
    await click('export'); expect(download).not.toHaveBeenCalled(); expect(el('status').textContent).toContain('降低')
    await change('master-gain', -2); await click('export'); expect(download).toHaveBeenCalledOnce()
  })
  it('passes an audio buffer and explicit revision to mastering', async () => {
    await setup(); await click('master')
    expect(toMaster).toHaveBeenCalledWith(expect.objectContaining({ sampleRate: 48000 }), expect.objectContaining({ name: '未命名專案', revision: panel.getProject().revision, signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }))
  })
  for (const interruption of ['cancel', 'clear', 'leave', 'modify', 'undo']) {
    it(`aborts transfer ownership on ${interruption} and never accepts late success`, async () => {
      const pending = deferred(), committed = vi.fn()
      const send = vi.fn(async (_buffer, { signal, isCurrent }) => {
        await pending.promise
        if (signal.aborted || !isCurrent()) throw new DOMException('cancelled', 'AbortError')
        committed()
        return true
      })
      await setup({ sendToMaster: send })
      action('master').click(); await tick()
      expect(send).toHaveBeenCalledOnce()
      const ownership = send.mock.calls[0][1]
      expect(ownership.signal.aborted).toBe(false)
      expect(ownership.isCurrent()).toBe(true)
      if (interruption === 'clear') panel.clear()
      else if (interruption === 'leave') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
      else if (interruption === 'modify') await change('master-gain', -3)
      else if (interruption === 'undo') await click('undo')
      else await click('cancel')
      expect(ownership.signal.aborted).toBe(true)
      expect(ownership.isCurrent()).toBe(false)
      pending.resolve(); await tick()
      expect(committed).not.toHaveBeenCalled()
      expect(document.getElementById('mode-editor').hidden).toBe(false)
      expect(el('status').textContent).not.toContain('已將完整混音送往母帶')
    })
  }
  it('navigates to mastering only after successful transfer ownership has retired', async () => {
    const pending = deferred()
    await setup({ sendToMaster: vi.fn(() => pending.promise) })
    const navigation = initModeNav(); navigation.switchMode('editor')
    action('master').click(); await tick()
    const ownership = toMaster.mock.calls[0][1]
    expect(document.getElementById('mode-editor').hidden).toBe(false)
    pending.resolve(true); await tick()
    expect(document.getElementById('mode-master').hidden).toBe(false)
    expect(ownership.signal.aborted).toBe(false)
    expect(action('cancel').hidden).toBe(true)
    expect(el('status').textContent).toContain('已將完整混音送往母帶處理')
  })
  it('does not start hidden playback when resume finishes after leaving the editor', async () => {
    const pending = deferred(), started = vi.fn()
    class DeferredContext {
      constructor() { this.currentTime = 0; this.destination = {} }
      resume() { return pending.promise }
      close() { return Promise.resolve() }
      createBufferSource() { return { connect() {}, disconnect() {}, start: started, stop() {} } }
    }
    await setup({ AudioContextClass: DeferredContext })
    action('play').click(); await tick()
    expect(action('cancel').hidden).toBe(false)
    document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
    pending.resolve(); await tick()
    expect(started).not.toHaveBeenCalled()
    expect(renderProject).not.toHaveBeenCalled()
    expect(action('play').textContent).toBe('播放混音')
    expect(el('status').textContent).not.toContain('正在播放')
  })
  it('uses the same bounded decode hook when restoring a portable project', async () => {
    await setup({ importAudio: false })
    importProjectArchive.mockImplementationOnce(async (_file, options) => {
      const buffer = await options.decodeAsset(new ArrayBuffer(8), { name: 'restored.wav', sampleRate: 48000 }, { signal: options.signal })
      expect(buffer.sampleRate).toBe(48000)
      return { project: createProject(), files: new Map(), buffers: new Map() }
    })
    await panel.openArchive(makeFile('session.waveforge.zip'))
    expect(decode).toHaveBeenCalledWith(expect.any(ArrayBuffer), { name: 'restored.wav', sampleRate: 48000 }, { signal: expect.any(AbortSignal) })
  })
  it('counts original files and retained audio before allocating a long render', async () => {
    await setup({ importAudio: false })
    await panel.importFiles(Array.from({ length: 5 }, (_, i) => ({ ...makeFile(`large-${i}.wav`), size: 64 * 1024 * 1024 })))
    await change('clip-at', 596); await click('move'); await click('export')
    expect(renderProject).not.toHaveBeenCalled()
    expect(el('status').textContent).toContain('記憶體預算')
  })
  it('passes cached mix and retained history memory into archive restoration', async () => {
    await setup(); await click('play'); await click('stop')
    importProjectArchive.mockResolvedValueOnce({ project: createProject(), files: new Map(), buffers: new Map() })
    await panel.openArchive(makeFile('restore.zip'))
    const options = importProjectArchive.mock.calls.at(-1)[1]
    const sourcePCM = 4 * 48000 * 4, cachedPCM = 4 * 48000 * 4
    expect(options.retainedBytes).toBeGreaterThan(sourcePCM + cachedPCM + 8)
  })
  it('includes cached render and retained originals in the archive save budget', async () => {
    await setup({ importAudio: false })
    await panel.importFiles(Array.from({ length: 3 }, (_, i) => ({ ...makeFile(`large-${i}.wav`), size: 64 * 1024 * 1024 })))
    renderProject.mockResolvedValueOnce({ buffer: { length: 20 * 1024 * 1024, numberOfChannels: 2, sampleRate: 48000 }, revision: 9, peak: .1 })
    await click('export') // Cache the render even though its encoded delivery is too large.
    await click('save')
    expect(exportProjectArchive).not.toHaveBeenCalled()
    expect(el('status').textContent).toContain('工程打包')
  })
  it('applies the 24-bit encoding budget before sending a mix to mastering', async () => {
    await setup({ importAudio: false })
    await panel.importFiles(Array.from({ length: 4 }, (_, i) => ({ ...makeFile(`large-${i}.wav`), size: 63 * 1024 * 1024 })))
    renderProject.mockResolvedValueOnce({ buffer: { length: 30 * 1024 * 1024, numberOfChannels: 2, sampleRate: 48000 }, revision: 12, peak: .1 })
    await click('master')
    expect(toMaster).not.toHaveBeenCalled()
    expect(el('status').textContent).toContain('WAV 編碼')
  })
  it('keeps the existing project when a later file in a batch fails decoding', async () => {
    await setup(); const before = panel.getProject()
    decode.mockResolvedValueOnce(getBuffer()).mockRejectedValueOnce(new Error('bad audio'))
    await expect(panel.importFiles([makeFile('valid.wav'), makeFile('bad.wav')])).rejects.toThrow('bad audio')
    expect(panel.getProject()).toEqual(before); expect(el('clip-fields').disabled).toBe(false)
  })
  it('discards a cancelled import even when decoding completes after clear', async () => {
    const pending = deferred(); await setup({ importAudio: false, decodeAsset: () => pending.promise })
    const loading = panel.importFiles([makeFile()]); await tick(); panel.clear(); pending.resolve(getBuffer())
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(panel.getProject().tracks).toHaveLength(0); expect(el('save-state').textContent).toBe('尚無修改')
  })
  it('saves originals with project metadata and leaves subsequent edits dirty', async () => {
    await setup(); await click('save')
    expect(exportProjectArchive).toHaveBeenCalledWith(expect.objectContaining({ assets: expect.any(Array) }), expect.any(Map), expect.any(Object))
    expect(el('save-state').textContent).toContain('已交付下載')
    await click('later'); expect(el('save-state').textContent).toContain('未下載')
  })
  it('restores only on successful archive validation and retains old audio on failure', async () => {
    await setup(); const before = panel.getProject()
    importProjectArchive.mockRejectedValueOnce(new Error('invalid archive'))
    await expect(panel.openArchive(makeFile('bad.zip'))).rejects.toThrow('invalid archive')
    expect(panel.getProject()).toEqual(before)
    const restored = createProject({ name: 'Restored' })
    importProjectArchive.mockResolvedValueOnce({ project: restored, files: new Map(), buffers: new Map() })
    await panel.openArchive(makeFile('good.zip'))
    expect(panel.getProject().name).toBe('Restored'); expect(action('undo').disabled).toBe(true)
    expect(importProjectArchive.mock.calls[1][1].retainedBytes).toBeGreaterThan(0)
  })
  it('respects clear/open refusal and warns about unsaved changes before leaving', async () => {
    await setup({ confirmAction: () => false }); const before = panel.getProject()
    await click('clear'); await panel.openArchive(makeFile('session.zip')); expect(panel.getProject()).toEqual(before)
    expect(importProjectArchive).not.toHaveBeenCalled()
    const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); expect(event.defaultPrevented).toBe(true)
  })
  it('does not let a late render replace a newer edited project', async () => {
    await setup(); const pending = deferred(); renderProject.mockReturnValueOnce(pending.promise)
    action('export').click(); await tick(); await click('later')
    pending.resolve({ buffer: getBuffer(), revision: 3, peak: .1 }); await tick()
    expect(download).not.toHaveBeenCalled(); expect(clip().atSeconds).toBe(.5)
  })
  it('exposes editor mode with accessible tab navigation and hides unrelated master chrome', async () => {
    await setup({ importAudio: false }); const navigation = initModeNav(); navigation.switchMode('editor')
    expect(document.getElementById('app').classList.contains('mode-editor')).toBe(true)
    expect(document.getElementById('mode-master').hidden).toBe(true)
    expect(document.getElementById('tab-editor').getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.chain-panel').getAttribute('aria-hidden')).toBe('true')
    document.getElementById('tab-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.getElementById('tab-lyrics').getAttribute('aria-selected')).toBe('true')
    expect(document.getElementById('mode-editor').hidden).toBe(true)
  })
})
