// DOM integration only: native rendering/playback/decoding are injected mocks.
// Commands, history, selectedRenderView, peak scans, WAV encoding and ZIP I/O
// are real. These assertions do not establish browser DSP or audible quality.
import { readFileSync } from 'node:fs'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { initModeNav } from '../../src/js/mode-nav.js'
import { buildRenderPlan, renderProject } from '../../src/js/daw/render.js'
import { selectedRenderView } from '../../src/js/daw/selection.js'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { measurePeaks } from '../../src/js/audio/measure.js'

vi.mock('../../src/js/daw/render.js', async importOriginal => ({ ...await importOriginal(), renderProject: vi.fn() }))
vi.mock('../../src/js/daw/selection.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, selectedRenderView: vi.fn(actual.selectedRenderView) }
})
vi.mock('../../src/js/audio/wav.js', async importOriginal => {
  const actual = await importOriginal()
  return { ...actual, encodeWAV: vi.fn(actual.encodeWAV) }
})

const { encodeWAV: encodeActualWAV } = await vi.importActual('../../src/js/audio/wav.js')
const { selectedRenderView: selectActualView } = await vi.importActual('../../src/js/daw/selection.js')
const html = readFileSync('index.html', 'utf8')
const rates = [44100, 48000, 96000]
const root = () => document.getElementById('mode-editor')
const el = id => document.getElementById(`daw-${id}`)
const action = name => root().querySelector(`[data-daw="${name}"]`)
const rangeAction = name => root().querySelector(`[data-range-action="${name}"]`)
const endpoint = name => root().querySelector(`[data-range-endpoint="${name}Seconds"]`)
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const change = async (id, value) => {
  el(id).value = String(value)
  el(id).dispatchEvent(new Event('change', { bubbles: true }))
  await tick()
}
const click = async name => { action(name).click(); await tick() }
const clickRange = async name => { rangeAction(name).click(); await tick() }
async function idle() {
  // The actual range peak scan and WAV encoder each yield a macrotask. Wait
  // for observable completion, rather than replacing those boundaries.
  await vi.waitFor(() => expect(root().getAttribute('aria-busy')).toBe('false'), { interval: 1, timeout: 1000 })
  await tick()
}
async function setRange(start, end) {
  for (const [name, value] of [['start', start], ['end', end]]) {
    endpoint(name).value = String(value)
    endpoint(name).dispatchEvent(new Event('input', { bubbles: true }))
  }
  await clickRange('apply')
}
function buffer(rate, frames, fill) {
  const value = new AudioContext().createBuffer(2, frames, rate)
  for (let channel = 0; channel < 2; channel++) {
    const data = value.getChannelData(channel)
    for (let frame = 0; frame < frames; frame++) data[frame] = fill(frame, channel)
  }
  return value
}
const quietMix = (frame, channel) => (channel ? -.17 : .23) * Math.sin((frame + 3) / 13)
function rendered(project, fill = quietMix) {
  const plan = buildRenderPlan(project)
  const mixed = buffer(plan.sampleRate, plan.frames, fill)
  const channels = [mixed.getChannelData(0), mixed.getChannelData(1)]
  let peak = 0, clippedSamples = 0
  for (const channel of channels) for (const value of channel) {
    peak = Math.max(peak, Math.abs(value))
    if (Math.abs(value) > 1) clippedSamples++
  }
  return { buffer: mixed, plan, revision: project.revision, peak, clippedSamples, peaks: measurePeaks(channels) }
}
function pcmSnapshot(value) { return [value.getChannelData(0).slice(), value.getChannelData(1).slice()] }
function acquiringBuffer(value) {
  let channels = pcmSnapshot(value)
  return { length: value.length, sampleRate: value.sampleRate, duration: value.duration, numberOfChannels: value.numberOfChannels,
    getChannelData: channel => channels[channel],
    acquireContents() {
      // Native-boundary double for Web Audio's acquire-the-contents behavior:
      // preserve the sound, detach previously exposed arrays, and expose fresh
      // channel data afterward. This is not a browser conformance/audio test.
      const acquired = channels.map(channel => channel.slice())
      structuredClone(null, { transfer: channels.map(channel => channel.buffer) })
      channels = acquired.map(channel => channel.slice())
      return acquired
    },
  }
}
function holdNextZeroDelayTask() {
  const schedule = globalThis.setTimeout
  let resume = null
  const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 0 && !resume) {
      resume = () => callback(...args)
      return 0
    }
    return schedule(callback, delay, ...args)
  })
  return {
    isHeld: () => resume !== null,
    restore: () => timer.mockRestore(),
    release() { timer.mockRestore(); resume?.(); resume = null },
  }
}
function expectUnchanged(value, before) {
  for (let channel = 0; channel < 2; channel++) expect(value.getChannelData(channel)).toEqual(before[channel])
}
function readStoredEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = new Map(), decoder = new TextDecoder()
  let offset = 0
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const start = offset + 30 + nameLength + extraLength
    entries.set(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)), bytes.slice(start, start + length))
    offset = start + length
  }
  return entries
}

let panel, nav, download, toMaster, original, originalFile, contexts, sources, nativeContext
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('File', NodeFile)
  vi.stubGlobal('crypto', webcrypto)
  nativeContext = globalThis.AudioContext
  contexts = []; sources = []
  selectedRenderView.mockImplementation(selectActualView)
  encodeWAV.mockImplementation(encodeActualWAV)
  renderProject.mockImplementation(async project => rendered(project))
})
afterEach(() => {
  panel?.destroy(); panel = null
  document.body.replaceChildren()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function setup({ rate = 48000, frames = 256, importAudio = true, onSourceStart } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(parsed.getElementById('app'))
  nav = initModeNav(); nav.switchMode('editor')
  original = buffer(rate, frames, (frame, channel) => (channel ? -.09 : .11) * Math.cos(frame / 7))
  originalFile = new NodeFile([encodeActualWAV(pcmSnapshot(original), rate, 24)], 'synthetic-original.wav', { type: 'audio/wav' })
  class PlaybackContext extends nativeContext {
    constructor() { super(); contexts.push(this); this.close = vi.fn(async () => { this.state = 'closed' }) }
    createBufferSource() {
      const value = super.createBufferSource()
      if (onSourceStart) value.start.mockImplementation((...args) => onSourceStart(value, ...args))
      sources.push(value); return value
    }
  }
  download = vi.fn(); toMaster = vi.fn(async () => true)
  panel = initDawPanel({ AudioContextClass: PlaybackContext, decodeAsset: vi.fn(async () => original),
    confirmAction: () => true, downloadFile: download, onSendToMaster: toMaster })
  if (importAudio) await panel.importFiles([originalFile])
  if (rate !== panel.getProject().sampleRate) await change('sample-rate', rate)
}

describe('timeline selection through the real DAW panel', () => {
  it.each(rates)('exports the exact selected full-mix WAV frames at %i Hz without touching source PCM', async rate => {
    await setup({ rate })
    const originalBefore = pcmSnapshot(original), before = panel.getProject()
    const range = { startSeconds: 31.25 / rate, endSeconds: 145.25 / rate }
    expect(el('snap').checked).toBe(true)
    await setRange(range.startSeconds, range.endSeconds)
    expect(panel.getProject().timelineSelection).toEqual(range)
    expect(panel.getProject().tracks).toEqual(before.tracks)
    expect(panel.getProject().assets).toEqual(before.assets)
    expect(panel.getProject().revision).toBe(before.revision + 1)
    let fullBefore
    renderProject.mockImplementationOnce(async project => {
      const result = rendered(project)
      fullBefore = pcmSnapshot(result.buffer)
      return result
    })
    await clickRange('export'); await idle()

    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0][1]).toBe('未命名專案-range-31-146.wav')
    expect(renderProject).toHaveBeenCalledTimes(1)
    const full = await renderProject.mock.results[0].value
    const view = await selectedRenderView.mock.results[0].value
    expect(full.plan).toEqual(buildRenderPlan(panel.getProject()))
    expect(full.buffer.length).toBe(256)
    expect(view).toMatchObject({ buffer: full.buffer, firstFrame: 31, lastFrame: 146, length: 115, sampleRate: rate })
    for (let channel = 0; channel < 2; channel++) {
      const data = full.buffer.getChannelData(channel)
      expect(view.channels[channel].buffer).toBe(data.buffer)
      expect(view.channels[channel].byteOffset).toBe(data.byteOffset + 31 * Float32Array.BYTES_PER_ELEMENT)
      expect(view.channels[channel]).toEqual(fullBefore[channel].subarray(31, 146))
    }
    expect(encodeWAV).toHaveBeenCalledExactlyOnceWith(view.channels, rate, 24)
    const bytes = new Uint8Array(await download.mock.calls[0][0].arrayBuffer())
    const header = new DataView(bytes.buffer)
    expect(header.getUint16(22, true)).toBe(2)
    expect(header.getUint32(24, true)).toBe(rate)
    expect(header.getUint16(34, true)).toBe(24)
    expect(header.getUint32(40, true)).toBe(115 * 6)
    expect(bytes.length).toBe(44 + 115 * 6)
    const fullWav = new Uint8Array(encodeActualWAV(fullBefore, rate, 24))
    expect(bytes.subarray(44)).toEqual(fullWav.subarray(44 + 31 * 6, 44 + 146 * 6))
    expectUnchanged(original, originalBefore)
    expectUnchanged(full.buffer, fullBefore)
  })

  it.each(rates)('auditions and loops the same full buffer at quantized frame boundaries at %i Hz', async rate => {
    await setup({ rate }); await setRange(31.25 / rate, 145.25 / rate)
    const before = pcmSnapshot(original)
    await clickRange('play'); await idle()
    const full = await renderProject.mock.results[0].value
    const first = sources[0]
    expect(first.buffer).toBe(full.buffer)
    expect(first.start).toHaveBeenCalledExactlyOnceWith(0, 31 / rate, 146 / rate - 31 / rate)
    expect(first.loop).toBe(false)
    await clickRange('loop'); await idle()
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    expect(first.onended).toBeNull()
    expect(sources[1]).toMatchObject({ buffer: full.buffer, loop: true, loopStart: 31 / rate, loopEnd: 146 / rate })
    expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(0, 31 / rate)
    expect(renderProject).toHaveBeenCalledTimes(1)
    expect(selectedRenderView).toHaveBeenCalledTimes(1)
    await click('stop')
    expect(sources[1].stop).toHaveBeenCalledTimes(1)
    expect(sources[1].disconnect).toHaveBeenCalledTimes(1)
    expect(sources[1].onended).toBeNull()
    expect(el('seek').value).toBe('0')
    expectUnchanged(original, before)
  })

  it('keeps ordinary Play, clip looping, WAV export and transfer on the full mix when a range exists', async () => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    await click('play'); await idle()
    const full = await renderProject.mock.results[0].value
    expect(sources[0].buffer).toBe(full.buffer)
    expect(sources[0].start).toHaveBeenCalledExactlyOnceWith(0, 0, original.duration)
    expect(selectedRenderView).not.toHaveBeenCalled()
    await click('stop')
    el('loop').checked = true; el('loop').dispatchEvent(new Event('change', { bubbles: true })); await tick()
    await click('play'); await idle()
    expect(sources[1]).toMatchObject({ loop: true, loopStart: 0, loopEnd: original.duration, buffer: full.buffer })
    expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(0, 0)
    await click('stop'); await click('export'); await idle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0][1]).toBe('未命名專案-mix.wav')
    expect(new Uint8Array(await download.mock.calls[0][0].arrayBuffer())).toEqual(new Uint8Array(encodeActualWAV(pcmSnapshot(full.buffer), 48000, 24)))
    await click('master'); await idle()
    expect(toMaster).toHaveBeenCalledExactlyOnceWith(full.buffer, expect.objectContaining({ revision: panel.getProject().revision }))
    expect(root().hidden).toBe(true)
    expect(panel.getProject().timelineSelection).toEqual({ startSeconds: 32 / 48000, endSeconds: 144 / 48000 })
    expect(selectedRenderView).not.toHaveBeenCalled()
    expect(renderProject).toHaveBeenCalledTimes(1)
  })

  it('allows a quiet selected range while overload elsewhere still blocks full Play and WAV', async () => {
    renderProject.mockImplementation(async project => rendered(project, (frame, channel) => frame >= 64 && frame < 192 ? (channel ? -.125 : .25) : 1.5))
    await setup(); await setRange(64 / 48000, 192 / 48000)
    const before = pcmSnapshot(original)
    await clickRange('export'); await idle()
    const view = await selectedRenderView.mock.results[0].value
    const full = await renderProject.mock.results[0].value
    expect(full.peak).toBe(1.5)
    expect(view.peak).toBe(.25)
    expect(view.clippedSamples).toBe(0)
    expect(download).toHaveBeenCalledTimes(1)
    await clickRange('play'); await idle()
    expect(sources).toHaveLength(1)
    await click('stop'); await click('export'); await idle()
    expect(el('status').textContent).toContain('已停止 WAV 輸出')
    await click('play'); await idle()
    expect(el('status').textContent).toContain('已停止試聽')
    expect(download).toHaveBeenCalledTimes(1)
    expect(encodeWAV).toHaveBeenCalledTimes(1)
    expect(sources).toHaveLength(1)
    expect(full.buffer.getChannelData(0)[63]).toBe(1.5)
    expectUnchanged(original, before)
  })

  it('blocks selected-range overload before encoding or creating a playback source without changing PCM', async () => {
    renderProject.mockImplementation(async project => rendered(project, (frame, channel) => frame === 100 ? -1.25 : quietMix(frame, channel)))
    await setup(); await setRange(64 / 48000, 192 / 48000)
    const before = pcmSnapshot(original)
    await clickRange('export'); await idle()
    expect(el('status').textContent).toContain('已停止 WAV 輸出')
    await clickRange('play'); await idle()
    expect(el('status').textContent).toContain('已停止試聽')
    expect(download).not.toHaveBeenCalled()
    expect(encodeWAV).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    const full = await renderProject.mock.results[0].value
    expect(full.buffer.getChannelData(0)[100]).toBe(-1.25)
    expectUnchanged(original, before)
  })

  it('saves and restores the range through a real ZIP while retaining the complete original media', async () => {
    await setup(); await setRange(31.25 / 48000, 145.25 / 48000)
    const accepted = panel.getProject(), before = pcmSnapshot(original)
    await click('save'); await idle()
    expect(download).toHaveBeenCalledTimes(1)
    const archive = download.mock.calls[0][0]
    const entries = readStoredEntries(new Uint8Array(await archive.arrayBuffer()))
    const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')))
    expect(manifest.project).toEqual(accepted)
    expect(manifest.project.timelineSelection).toEqual(accepted.timelineSelection)
    expect(entries.get('media/0000.bin')).toEqual(new Uint8Array(await originalFile.arrayBuffer()))
    expect(el('save-state').textContent).toContain('已交付下載')
    await clickRange('clear')
    expect(el('save-state').textContent).toContain('未下載')
    await panel.openArchive(new NodeFile([archive], 'restored.waveforge.zip'))
    expect(panel.getProject()).toEqual(accepted)
    expect(endpoint('start').value).toBe(String(accepted.timelineSelection.startSeconds))
    expect(endpoint('end').value).toBe(String(accepted.timelineSelection.endSeconds))
    expect(rangeAction('play').closest('.daw-selection-actions').hidden).toBe(false)
    expectUnchanged(original, before)
  })

  it('keeps numeric details collapsed, clears an invalidated range with the shrinking edit, and restores both with one undo', async () => {
    await setup()
    const details = root().querySelector('.daw-selection-details')
    expect(details.open).toBe(false)
    expect(rangeAction('play').closest('.daw-selection-actions').hidden).toBe(true)
    details.querySelector('summary').click()
    expect(details.open).toBe(true)
    await setRange(32 / 48000, 224 / 48000)
    const accepted = panel.getProject(), originalBefore = pcmSnapshot(original)
    expect(root().querySelector('.daw-selection-summary').getAttribute('aria-live')).toBe('polite')
    await change('trim-end', 128 / 48000); await click('trim')
    expect(panel.getProject().timelineSelection).toBeUndefined()
    expect(panel.getProject().tracks[0].clips[0].durationSeconds).toBe(128 / 48000)
    expect(panel.getProject().revision).toBe(accepted.revision + 1)
    expect(el('status').textContent).toContain('原選區已超出工程，已清除，可復原找回')
    expect(root().querySelectorAll('.daw-timeline-selection, .daw-selection-handle')).toHaveLength(0)
    expect(rangeAction('play').closest('.daw-selection-actions').hidden).toBe(true)
    await click('undo')
    expect(panel.getProject()).toEqual(accepted)
    expect(root().querySelectorAll('.daw-selection-handle')).toHaveLength(2)
    await click('redo')
    expect(panel.getProject().timelineSelection).toBeUndefined()
    await click('undo'); await clickRange('clear')
    expect(panel.getProject().tracks).toEqual(accepted.tracks)
    expect(panel.getProject().timelineSelection).toBeUndefined()
    await click('undo'); expect(panel.getProject()).toEqual(accepted)
    expect(details.open).toBe(true)
    expectUnchanged(original, originalBefore)
  })

  it('rejects invalid numeric edits without replacing the accepted range or creating an undo entry', async () => {
    await setup(); await setRange(32 / 48000, 224 / 48000)
    const accepted = panel.getProject()
    for (const [start, end] of [['', 100 / 48000], [120 / 48000, 100 / 48000], [0, 257 / 48000]]) {
      await setRange(start, end)
      expect(panel.getProject()).toEqual(accepted)
      expect(el('status').dataset.error).toBe('true')
    }
    endpoint('end').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await click('undo')
    expect(panel.getProject().timelineSelection).toBeUndefined()
    expect(panel.getProject().revision).toBe(accepted.revision - 1)
  })
})

const interruptions = {
  cancel: () => action('cancel').click(),
  stop: () => action('stop').click(),
  navigation: () => nav.switchMode('lyrics'),
  'source edit': () => { el('clip-gain').value = '-6'; el('clip-gain').dispatchEvent(new Event('change', { bubbles: true })) },
  'selection undo': () => action('undo').click(),
  clear: () => panel.clear(),
  destroy: () => panel.destroy(),
}

describe('selected range cancellation and stale ownership', () => {
  it.each(rates.flatMap(rate => ['play', 'loop'].map(mode => ({ rate, mode }))))('reacquires detached range views after $mode before exporting the unchanged 112 frames at $rate Hz', async ({ rate, mode }) => {
    await setup({ rate, onSourceStart: source => { source.acquiredPCM = source.buffer.acquireContents() } })
    await setRange(32 / rate, 144 / rate)
    const accepted = panel.getProject(), originalBefore = pcmSnapshot(original)
    let mixedBefore
    renderProject.mockImplementationOnce(async project => {
      const result = rendered(project)
      result.buffer = acquiringBuffer(result.buffer)
      mixedBefore = pcmSnapshot(result.buffer)
      return result
    })
    await clickRange(mode); await idle()
    const full = await renderProject.mock.results[0].value
    const firstView = await selectedRenderView.mock.results[0].value
    for (let channel = 0; channel < 2; channel++) {
      expect(firstView.channels[channel].length).toBe(0)
      expect(firstView.channels[channel].buffer.byteLength).toBe(0)
      expect(full.buffer.getChannelData(channel).length).toBe(256)
      expect(sources[0].acquiredPCM[channel]).toEqual(mixedBefore[channel])
    }
    if (mode === 'play') await click('stop')
    await clickRange('export'); await idle()
    expect(download).toHaveBeenCalledTimes(1)
    expect(download.mock.calls[0][1]).toBe('未命名專案-range-32-144.wav')
    const bytes = new Uint8Array(await download.mock.calls[0][0].arrayBuffer())
    const header = new DataView(bytes.buffer)
    expect(bytes.length).toBe(44 + 112 * 6)
    expect(header.getUint32(24, true)).toBe(rate)
    expect(header.getUint32(40, true)).toBe(112 * 6)
    const expected = new Uint8Array(encodeActualWAV(mixedBefore, rate, 24))
    expect(bytes.subarray(44)).toEqual(expected.subarray(44 + 32 * 6, 44 + 144 * 6))
    for (let channel = 0; channel < 2; channel++) {
      const exported = encodeWAV.mock.calls[0][0][channel]
      expect(exported.length).toBe(112)
      expect(exported.buffer).toBe(full.buffer.getChannelData(channel).buffer)
      expect(exported.buffer).not.toBe(firstView.channels[channel].buffer)
    }
    if (mode === 'loop') expect(sources[0].stop).not.toHaveBeenCalled()
    expect(renderProject).toHaveBeenCalledTimes(1)
    expect(selectedRenderView).toHaveBeenCalledTimes(1)
    expect(panel.getProject()).toEqual(accepted)
    expectUnchanged(original, originalBefore)
    expectUnchanged(full.buffer, mixedBefore)
  })

  it.each(['range scan', 'encoded WAV'])('keeps the %s operation reserved after Cancel and Clear until its actual yielded work settles', async stage => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    const originalBefore = pcmSnapshot(original)
    let held, encoded
    if (stage === 'range scan') held = holdNextZeroDelayTask()
    else encodeWAV.mockImplementationOnce((...args) => {
      encoded = encodeActualWAV(...args)
      held = holdNextZeroDelayTask()
      return encoded
    })
    const readFailure = new Error('admission probe reached its first file read')
    const read = vi.fn(async () => { throw readFailure })
    // Six <=64 MiB declared files plus the two-file read allowance approach
    // the real 512 MiB cap. No large bytes are allocated: an admitted probe
    // stops at its first read. At 256 stereo float frames, two mix copies cost
    // 4096 bytes, and the 112-frame encoded WAV plus download copy cost 1432.
    // 4096 bytes of headroom tests both mix copies; 5632 tests the WAV lease
    // separately because the copies plus empty-project metadata fit there.
    const headroom = stage === 'range scan' ? 4096 : 5632
    const files = Array.from({ length: 6 }, (_, index) => ({ name: `budget-probe-${index}.wav`,
      size: 64 * 1024 * 1024 - (index === 5 ? headroom : 0), arrayBuffer: read }))
    try {
      await clickRange('export')
      await vi.waitFor(() => expect(held?.isHeld()).toBe(true), { interval: 1, timeout: 1000 })
      held.restore()
      expect(selectedRenderView).toHaveBeenCalledTimes(1)
      if (stage === 'range scan') expect(encodeWAV).not.toHaveBeenCalled()
      else expect(encoded.byteLength).toBe(44 + 112 * 6)
      await click('cancel'); panel.clear()
      const cleared = panel.getProject()
      expect(cleared.assets).toHaveLength(0)
      expect(cleared.timelineSelection).toBeUndefined()
      expect(root().getAttribute('aria-busy')).toBe('false')
      const json = JSON.stringify(cleared)
      const emptyMetadataBytes = 2 * (new TextEncoder().encode(json).length + json.length)
      const fullMixBytes = 256 * 2 * Float32Array.BYTES_PER_ELEMENT
      // Guard the fixture thresholds: a missing second PCM copy must be
      // detectable, and the encoded case must require the WAV reservation.
      if (stage === 'range scan') {
        expect(fullMixBytes + emptyMetadataBytes).toBeLessThan(headroom)
        expect(fullMixBytes * 2 + emptyMetadataBytes).toBeGreaterThan(headroom)
      } else {
        expect(fullMixBytes * 2 + emptyMetadataBytes).toBeLessThan(headroom)
        expect(fullMixBytes * 2 + encoded.byteLength * 2 + emptyMetadataBytes).toBeGreaterThan(headroom)
      }
      await expect(panel.importFiles(files)).rejects.toThrow('記憶體預算')
      expect(read).not.toHaveBeenCalled()
      expect(download).not.toHaveBeenCalled()
      held.release(); await tick()
      // The same request becomes admissible only after withJob's actual
      // finally releases the old operation, despite earlier UI cancellation.
      await expect(panel.importFiles(files)).rejects.toBe(readFailure)
      expect(read).toHaveBeenCalledTimes(1)
      expect(panel.getProject()).toEqual(cleared)
      expect(download).not.toHaveBeenCalled()
      expectUnchanged(original, originalBefore)
    } finally { held?.release(); await tick() }
  })

  it.each(Object.keys(interruptions))('discards a pending native render after %s without late export or playback', async interruption => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    const before = pcmSnapshot(original), pending = deferred()
    let late
    renderProject.mockImplementationOnce(project => { late = rendered(project); return pending.promise })
    await clickRange('export')
    expect(renderProject).toHaveBeenCalledTimes(1)
    expect(root().getAttribute('aria-busy')).toBe('true')
    interruptions[interruption](); await tick()
    const afterInterruption = panel.getProject()
    pending.resolve(late); await tick()
    await new Promise(resolve => setTimeout(resolve, 0)); await tick()
    expect(download).not.toHaveBeenCalled()
    expect(encodeWAV).not.toHaveBeenCalled()
    expect(selectedRenderView).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    expect(panel.getProject()).toEqual(afterInterruption)
    expectUnchanged(original, before)
  })

  it.each(Object.keys(interruptions))('lets queued %s win after actual WAV encoding and before the download handoff', async interruption => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    const originalBefore = pcmSnapshot(original), cancelled = deferred()
    let encoded
    encodeWAV.mockImplementationOnce((...args) => {
      encoded = encodeActualWAV(...args)
      // This callback cannot run until export yields AFTER real encoding.
      // If the panel removes that yield, a forbidden download happens first.
      setTimeout(() => {
        const handedOffBeforeCancellation = download.mock.calls.length
        interruptions[interruption]()
        cancelled.resolve(handedOffBeforeCancellation)
      }, 0)
      return encoded
    })
    await clickRange('export')
    expect(await cancelled.promise).toBe(0)
    await new Promise(resolve => setTimeout(resolve, 0)); await tick()
    expect(encodeWAV).toHaveBeenCalledTimes(1)
    expect(new DataView(encoded).getUint32(40, true)).toBe(112 * 6)
    expect(download).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
    expectUnchanged(original, originalBefore)
  })

  it.each(['revision', 'source recipe'])('rejects a full render with a stale %s rather than silently exporting it', async stale => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    renderProject.mockImplementationOnce(async project => {
      const value = rendered(project)
      if (stale === 'revision') value.revision--
      else value.plan.tracks[0].clips[0].assetId = 'stale-other-source'
      return value
    })
    await clickRange('export'); await idle()
    expect(el('status').dataset.error).toBe('true')
    expect(el('status').textContent).toContain('current full project render')
    expect(encodeWAV).not.toHaveBeenCalled()
    expect(download).not.toHaveBeenCalled()
    expect(sources).toHaveLength(0)
  })

  it('replaces cached mix views after a new range or source edit and renders the restored range after undo', async () => {
    await setup(); await setRange(32 / 48000, 144 / 48000)
    const originalBefore = pcmSnapshot(original)
    await clickRange('loop'); await idle()
    const first = sources[0], beforeRangeEdit = panel.getProject()
    await setRange(64 / 48000, 192 / 48000)
    expect(first.stop).toHaveBeenCalledTimes(1)
    expect(first.disconnect).toHaveBeenCalledTimes(1)
    await clickRange('export'); await idle()
    const secondView = await selectedRenderView.mock.results[1].value
    expect(secondView).toMatchObject({ firstFrame: 64, lastFrame: 192, length: 128 })
    expect(secondView.buffer).not.toBe(first.buffer)
    expect(download.mock.calls[0][1]).toBe('未命名專案-range-64-192.wav')
    await change('clip-gain', -6)
    await clickRange('play'); await idle()
    const thirdView = await selectedRenderView.mock.results[2].value
    expect(thirdView.buffer).not.toBe(secondView.buffer)
    expect(renderProject.mock.calls[2][0].tracks[0].clips[0].gainDb).toBe(-6)
    expect(thirdView).toMatchObject({ firstFrame: 64, lastFrame: 192 })
    await click('undo'); await click('undo')
    expect(panel.getProject()).toEqual(beforeRangeEdit)
    await clickRange('play'); await idle()
    const restoredView = await selectedRenderView.mock.results[3].value
    expect(restoredView).toMatchObject({ firstFrame: 32, lastFrame: 144, length: 112 })
    expect(restoredView.buffer).not.toBe(first.buffer)
    expect(restoredView.buffer).not.toBe(thirdView.buffer)
    expect(sources.at(-1).start).toHaveBeenCalledExactlyOnceWith(0, 32 / 48000, 144 / 48000 - 32 / 48000)
    expect(renderProject).toHaveBeenCalledTimes(4)
    expect(selectedRenderView).toHaveBeenCalledTimes(4)
    expectUnchanged(original, originalBefore)
  })

  it('invalidates cached range views across repeated Clear and destroy, and ignores stale controls/onended callbacks', async () => {
    await setup()
    const originalBefore = pcmSnapshot(original)
    let previousBuffer = null, staleEnded = null, staleHandle = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await panel.importFiles([originalFile])
      await setRange(32 / 48000, (144 + attempt) / 48000)
      await clickRange('loop'); await idle()
      const active = sources.at(-1)
      expect(active.buffer).not.toBe(previousBuffer)
      if (staleEnded) {
        staleEnded()
        expect(active.stop).not.toHaveBeenCalled()
        expect(active.disconnect).not.toHaveBeenCalled()
        expect(action('play').textContent).toBe('暫停')
      }
      const accepted = panel.getProject()
      if (staleHandle) {
        staleHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        expect(panel.getProject()).toEqual(accepted)
      }
      previousBuffer = active.buffer; staleEnded = active.onended
      staleHandle = root().querySelector('[data-range-handle="startSeconds"]')
      const runtimeBuffers = renderProject.mock.calls.at(-1)[1]
      panel.clear(); panel.clear()
      expect(active.stop).toHaveBeenCalledTimes(1)
      expect(active.disconnect).toHaveBeenCalledTimes(1)
      expect(active.onended).toBeNull()
      expect(runtimeBuffers.size).toBe(0)
      expect(root().querySelectorAll('.daw-timeline-selection, .daw-selection-handle')).toHaveLength(0)
      expect(panel.getProject().timelineSelection).toBeUndefined()
    }
    expect(renderProject).toHaveBeenCalledTimes(3)
    expect(selectedRenderView).toHaveBeenCalledTimes(3)
    await panel.importFiles([originalFile]); await setRange(64 / 48000, 192 / 48000)
    await clickRange('play'); await idle()
    const active = sources.at(-1), staleExport = rangeAction('export'), stalePlay = rangeAction('play')
    const runtimeBuffers = renderProject.mock.calls.at(-1)[1]
    panel.destroy(); panel.destroy()
    staleExport.click(); stalePlay.click(); staleEnded(); await tick()
    expect(active.stop).toHaveBeenCalledTimes(1)
    expect(active.disconnect).toHaveBeenCalledTimes(1)
    expect(active.onended).toBeNull()
    expect(contexts).toHaveLength(1)
    expect(contexts[0].close).toHaveBeenCalledTimes(1)
    expect(runtimeBuffers.size).toBe(0)
    expect(root().querySelector('.daw-selection-controls')).toBeNull()
    expect(renderProject).toHaveBeenCalledTimes(4)
    expect(selectedRenderView).toHaveBeenCalledTimes(4)
    expect(download).not.toHaveBeenCalled()
    expectUnchanged(original, originalBefore)
  })
})
