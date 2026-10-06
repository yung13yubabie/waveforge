import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { renderProject, getPendingNativeRenderBytes } from '../../src/js/daw/render.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
vi.mock('../../src/js/audio/sha256.js', () => ({ sha256Hex: vi.fn(async () => 'a'.repeat(64)) }))
vi.mock('../../src/js/daw/render.js', () => ({ renderProject: vi.fn(), getPendingNativeRenderBytes: vi.fn(() => 0) }))
vi.mock('../../src/js/daw/archive.js', () => ({ exportProjectArchive: vi.fn(async () => new Blob(['zip'])), importProjectArchive: vi.fn(), archiveFileName: () => 'project.zip', ARCHIVE_LIMITS: { archiveBytes: 256 * 1024 * 1024, manifestBytes: 1024 * 1024 } }))
const html = readFileSync('index.html', 'utf8'), el = id => document.getElementById(`daw-${id}`), action = id => document.querySelector(`[data-daw="${id}"]`)
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const click = async id => { action(id).click(); await tick() }
const change = async (id, value, type = 'input') => { el(id).value = String(value); el(id).dispatchEvent(new Event(type, { bubbles: true })); await tick() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const file = { name: 'source.wav', size: 8, arrayBuffer: async () => new ArrayBuffer(8) }
function audio(rate = 48000, count = 2) { const buffer = new AudioContext().createBuffer(count, rate, rate); for (let c = 0; c < count; c++) buffer.getChannelData(c).fill(c ? -.125 : .25); return buffer }
function result(channels, rate, options) { return { channels: channels.map(data => data.map(value => value * 2)), sampleRate: rate, sourceToken: options.sourceToken,
  metadata: { semitones: (options.semitones || 0) + (options.cents || 0) / 100, formantSemitones: options.formantSemitones || 0, formantCompensation: options.formantCompensation || false, outputPeak: .5 } } }
let panel, client, original, download, ctx
async function setup(rate = 48000, count = 2) {
  document.body.replaceChildren(new DOMParser().parseFromString(html, 'text/html').getElementById('app'))
  document.getElementById('mode-editor').hidden = false
  original = audio(rate, count); ctx = new AudioContext(); vi.spyOn(ctx, 'createBufferSource')
  client = { render: vi.fn(async (...args) => result(...args)), dispose: vi.fn() }; download = vi.fn()
  panel = initDawPanel({ decodeAsset: async () => original, downloadFile: download, confirmAction: () => true, pitchClientFactory: () => client, AudioContextClass: function () { return ctx } })
  await panel.importFiles([file]); return panel
}
beforeEach(() => { vi.clearAllMocks(); renderProject.mockImplementation(async (project, buffers) => ({ buffer: buffers.get(project.tracks[0].clips[0].assetId), peak: .5, peaks: { truePeakDb: -6 } })) })
afterEach(() => { panel?.destroy(); document.body.replaceChildren(); vi.restoreAllMocks() })
const clip = () => panel.getProject().tracks[0].clips[0]

describe('contextual clip transpose transaction', () => {
  it('keeps controls collapsed with honest optional formants/limits and no global orphan controls', async () => {
    await setup()
    expect(el('transpose-details').open).toBe(false)
    expect(el('transpose-details').querySelector('summary').textContent).toBe('片段移調（試用）')
    expect(el('transpose-source').textContent).toBe('先 A/B 試聽，再接受；可回到原音')
    expect(el('transpose-limits').textContent).toContain('每次最多 30 秒')
    expect(el('transpose-details').closest('fieldset')).toBe(el('clip-fields'))
    expect(el('transpose-help').open).toBe(false); expect(el('transpose-timbre').open).toBe(false)
    expect(el('transpose-limits').textContent).toContain('不是自動音準校正')
    expect(el('transpose-limits').textContent).toContain('補償是近似處理，音色仍可能改變')
    expect(el('transpose-limits').textContent).not.toContain('保留音色')
    await click('delete'); expect(el('clip-fields').hidden).toBe(true)
  })
  it.each([44100, 48000, 96000])('stages one native %i Hz result, previews it, accepts it once and retains original/Float32 file for Undo/ZIP', async rate => {
    await setup(rate)
    const old = panel.getProject(), originalBytes = original.getChannelData(0).slice()
    await change('transpose-semitones', 1); await change('transpose-cents', 25); await change('transpose-formants', -1)
    el('transpose-compensation').checked = true
    await panel.prepareTranspose()
    expect(client.render).toHaveBeenCalledOnce(); expect(client.render.mock.calls[0][2]).toMatchObject({ semitones: 1, cents: 25, formantSemitones: -1, formantCompensation: true })
    expect(panel.getProject()).toEqual(old)
    expect(el('replacement-review').parentElement).toBe(el('transpose-details'))
    await click('replacement-preview'); const staged = renderProject.mock.calls[0], stagedBuffer = staged[1].get(staged[0].tracks[0].clips[0].assetId)
    expect(ctx.createBufferSource.mock.results[0].value.buffer).toBe(stagedBuffer)
    await click('stop'); await click('replacement-original'); expect(renderProject.mock.calls.at(-1)[1].get(old.assets[0].id)).toBe(original)
    await click('stop'); action('replacement-confirm').focus(); await click('replacement-confirm')
    expect(document.activeElement).toBe(action('transpose-render'))
    expect(clip()).toEqual({ ...old.tracks[0].clips[0], assetId: clip().assetId, offsetSeconds: 0, transpose: clip().transpose })
    expect(clip().assetId).not.toBe(old.assets[0].id)
    await click('play'); expect(renderProject.mock.calls.at(-1)[1].get(clip().assetId)).toBe(stagedBuffer)
    await click('stop'); await click('save')
    const [saved, files] = exportProjectArchive.mock.calls.at(-1)
    expect(saved.assets.at(-1)).toMatchObject({ sampleRate: rate, channels: 2, decodeBackend: 'generated-float32-wav' })
    expect(files.get(old.assets[0].id)).toBe(file); expect(files.get(clip().assetId).size).toBe(stagedBuffer.length * 8 + 58)
    await click('undo'); expect(panel.getProject()).toEqual(old)
    await click('redo'); expect(panel.getProject()).toEqual(saved)
    expect(client.render).toHaveBeenCalledOnce(); expect(original.getChannelData(0)).toEqual(originalBytes)
  })
  it('preserves precise clip placement, fractional offset, fades, gains and automation', async () => {
    await setup(44100, 1)
    el('snap').checked = false
    await change('trim-start', (100.5 / 44100), 'change'); await change('trim-end', .75, 'change'); await click('trim')
    await change('clip-gain', -3, 'change'); await change('fade-in', .03, 'change'); await change('fade-out', .02, 'change'); await click('fades'); await click('automation-add')
    const old = clip(); await panel.prepareTranspose(); await click('replacement-confirm')
    expect(clip()).toEqual({ ...old, assetId: clip().assetId, offsetSeconds: old.offsetSeconds - Math.floor(old.offsetSeconds * 44100) / 44100, transpose: clip().transpose })
    expect(client.render.mock.calls[0][0][0].length).toBe(Math.ceil((old.offsetSeconds + old.durationSeconds) * 44100) - Math.floor(old.offsetSeconds * 44100))
    expect(() => panel.confirmReplacement()).toThrow('請先選擇')
  })
  it.each(['settings', 'navigation', 'selection', 'project', 'source', 'undo', 'cancel', 'destroy'])('rejects stale worker completion after %s without adding an asset', async interruption => {
    await setup(); await panel.importFiles([{ ...file, name: 'second.wav' }]); const pending = deferred()
    client.render.mockImplementation((...args) => pending.promise.then(() => result(...args)))
    const task = panel.prepareTranspose(), rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' }); await tick()
    if (interruption === 'settings') await change('transpose-cents', 10)
    else if (interruption === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (interruption === 'selection') { document.querySelector('.daw-clip').click(); await tick() }
    else if (interruption === 'project') await change('tempo', 90, 'change')
    else if (interruption === 'source') { await click('delete') }
    else if (interruption === 'undo') await click('undo')
    else if (interruption === 'destroy') panel.destroy()
    else await click('cancel')
    const accepted = panel.getProject(); pending.resolve(); await rejected
    expect(panel.getProject()).toEqual(accepted); expect(panel.getProject().assets).toHaveLength(interruption === 'undo' ? 1 : 2)
    expect(el('replacement-review').hidden).toBe(true)
  })
  it('invalidates a ready result on uncommitted settings and supports repeated cancel/retry without leaking accepted assets', async () => {
    await setup(); const before = panel.getProject()
    for (let i = 0; i < 3; i++) {
      await panel.prepareTranspose(); action('replacement-cancel').focus(); await click('replacement-cancel')
      expect(document.activeElement).toBe(action('transpose-render')); expect(panel.getProject()).toEqual(before)
    }
    await panel.prepareTranspose(); el('transpose-cents').value = '10'
    expect(() => panel.confirmReplacement()).toThrow(); expect(panel.getProject()).toEqual(before)
    await change('transpose-cents', 20); expect(el('replacement-review').hidden).toBe(true)
    await panel.prepareTranspose(); await click('replacement-confirm'); expect(panel.getProject().assets).toHaveLength(2)
  })
  it('restores bounded lineage and controls from fresh ZIP, recovers original in one step and rerenders from original without stacking', async () => {
    await setup(44100, 1); const before = clip(), originalPcm = original.getChannelData(0).slice()
    await change('transpose-semitones', 1); await change('transpose-cents', 25); await change('transpose-formants', -.5)
    el('transpose-compensation').checked = true
    await panel.prepareTranspose(); await click('replacement-preview'); await click('stop'); await click('replacement-confirm'); await click('save')
    const accepted = panel.getProject(), maps = new Map(renderProject.mock.calls[0][1]), files = new Map(exportProjectArchive.mock.calls.at(-1)[1])
    const recipe = clip().transpose
    expect(recipe).toMatchObject({ version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: before.assetId, sourceOffsetSeconds: 0, sourceDurationSeconds: 1, cropFirstFrame: 0, cropLastFrame: 44100, semitones: 1, cents: 25, formantSemitones: -.5, formantCompensation: true })
    panel.destroy(); await setup(48000, 2)
    importProjectArchive.mockResolvedValueOnce({ project: accepted, buffers: maps, files })
    await panel.openArchive(new Blob(['archive'])); document.querySelector('.daw-clip').click(); await tick()
    expect(action('undo').disabled).toBe(true)
    expect(action('transpose-original').hidden).toBe(false)
    expect(el('transpose-source').textContent).toContain('先 A/B 試聽，再接受；可回到原音')
    expect(el('transpose-source').textContent).toContain('再產生會從原音開始')
    expect(el('transpose-semitones').value).toBe('1'); expect(el('transpose-cents').value).toBe('25')
    expect(el('transpose-formants').value).toBe('-0.5'); expect(el('transpose-compensation').checked).toBe(true)
    await click('transpose-original'); expect(clip()).toEqual(before); expect(action('transpose-original').hidden).toBe(true)
    await click('undo'); expect(clip()).toEqual(accepted.tracks[0].clips[0])
    await panel.prepareTranspose()
    expect(client.render).toHaveBeenCalledOnce(); expect(client.render.mock.calls[0][0][0]).toEqual(originalPcm)
    await click('replacement-confirm'); expect(clip().transpose).toEqual(recipe)
    expect(clip().transpose.sourceAssetId).toBe(before.assetId)
  })
  it('rejects before worker/native/serialized allocation when an outstanding native job consumes the shared budget', async () => {
    await setup(); const before = panel.getProject()
    getPendingNativeRenderBytes.mockReturnValueOnce(500 * 1024 * 1024)
    await expect(panel.prepareTranspose()).rejects.toThrow('記憶體預算')
    expect(client.render).not.toHaveBeenCalled(); expect(panel.getProject()).toEqual(before)
    await panel.prepareTranspose(); expect(client.render).toHaveBeenCalledOnce()
  })
  it('holds uncancellable hashing ownership and its budget through Cancel, then allows retry', async () => {
    await setup(); const pending = deferred(), before = panel.getProject()
    sha256Hex.mockReturnValueOnce(pending.promise)
    const task = panel.prepareTranspose(), rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(sha256Hex).toHaveBeenCalledTimes(2))
    await click('cancel'); await expect(panel.prepareTranspose()).rejects.toThrow('仍在整理')
    pending.resolve('f'.repeat(64)); await rejected
    expect(panel.getProject()).toEqual(before)
    await panel.prepareTranspose(); expect(el('replacement-review').hidden).toBe(false)
  })
  it('keeps the accepted project on worker timeout/failure and allows retry', async () => {
    await setup(); const before = panel.getProject()
    client.render.mockRejectedValueOnce(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
    await expect(panel.prepareTranspose()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(panel.getProject()).toEqual(before); expect(el('replacement-review').hidden).toBe(true)
    await panel.prepareTranspose(); expect(el('replacement-review').hidden).toBe(false)
  })
  it('rejects invalid/empty settings before starting a worker', async () => {
    await setup()
    for (const [id, value] of [['semitones', 3], ['semitones', ''], ['semitones', 2]]) {
      await change(`transpose-${id}`, value); await change('transpose-cents', 1)
      await expect(panel.prepareTranspose()).rejects.toThrow()
    }
    expect(client.render).not.toHaveBeenCalled()
  })
  it('can cancel unsafe pending audio, lower master gain and regenerate a safe audition without accepting', async () => {
    await setup(); original.getChannelData(0).fill(.75)
    const before = panel.getProject(), originalSamples = original.getChannelData(0).slice()
    client.render.mockImplementation(async (...args) => ({ ...result(...args), metadata: { ...result(...args).metadata, outputPeak: 1.5 } }))
    // This test covers the UI path with an explicit gain-aware mix double; real
    // native rendering remains covered by the separate browser workflow suite.
    renderProject.mockImplementation(async (project, buffers) => {
      const source = buffers.get(project.tracks[0].clips[0].assetId), gain = 10 ** (project.masterGainDb / 20)
      const mixed = ctx.createBuffer(source.numberOfChannels, source.length, source.sampleRate)
      for (let c = 0; c < source.numberOfChannels; c++) mixed.copyToChannel(source.getChannelData(c).map(sample => sample * gain), c)
      return { buffer: mixed, peak: 1.5 * gain, peaks: { truePeakDb: 20 * Math.log10(1.5 * gain) } }
    })
    await panel.prepareTranspose(); await click('replacement-preview')
    expect(ctx.createBufferSource).not.toHaveBeenCalled(); expect(panel.getProject()).toEqual(before)
    await click('replacement-cancel'); expect(panel.getProject()).toEqual(before)
    await change('master-gain', -6, 'change'); await panel.prepareTranspose()
    // Above-unity source headroom is retained even though the actual mix is safe.
    expect(el('replacement-summary').textContent).toContain('來源峰值超過 0 dBFS，未截幅')
    await click('replacement-preview'); expect(el('status').textContent).toContain('B：正在試聽')
    expect(ctx.createBufferSource).toHaveBeenCalledOnce()
    expect(ctx.createBufferSource.mock.results[0].value.buffer.getChannelData(0)[0]).toBeCloseTo(1.5 * 10 ** (-6 / 20), 6)
    expect(panel.getProject().assets).toEqual(before.assets); expect(clip().assetId).toBe(before.tracks[0].clips[0].assetId)
    expect(panel.getProject().masterGainDb).toBe(-6); expect(client.render).toHaveBeenCalledTimes(2)
    expect(original.getChannelData(0)).toEqual(originalSamples)
  })
  it('keeps above-unity PCM and blocks unsafe B audition/WAV without hidden gain changes', async () => {
    await setup(); original.getChannelData(0).fill(.75)
    client.render.mockImplementation(async (...args) => ({ ...result(...args), metadata: { ...result(...args).metadata, outputPeak: 1.5 } }))
    await panel.prepareTranspose(); expect(el('replacement-summary').textContent).toContain('未截幅')
    expect(el('replacement-summary').textContent).toContain('若混音也過載，請取消並保留原音')
    expect(el('replacement-summary').textContent).not.toContain('須接受')
    renderProject.mockImplementation(async (project, buffers) => ({ buffer: buffers.get(project.tracks[0].clips[0].assetId), peak: 1.5, peaks: { truePeakDb: 4 } }))
    await click('replacement-preview'); expect(ctx.createBufferSource).not.toHaveBeenCalled(); expect(el('status').textContent).toContain('停止試聽')
    expect(el('status').textContent).toContain('取消並保留原音，降低片段或總音量後重新產生試聽')
    expect(el('status').textContent).not.toContain('先接受')
    const candidate = renderProject.mock.calls[0]; expect(candidate[1].get(candidate[0].tracks[0].clips[0].assetId).getChannelData(0)[0]).toBe(1.5)
    await click('replacement-confirm'); await click('export'); expect(download).not.toHaveBeenCalled(); expect(el('status').textContent).toContain('停止 WAV')
    expect(panel.getProject().masterGainDb).toBe(0)
  })
})
