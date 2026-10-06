import { readFileSync } from 'node:fs'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDawPanel } from '../../src/js/daw/panel.js'
import { renderProject, getPendingNativeRenderBytes } from '../../src/js/daw/render.js'
import { importProjectArchive } from '../../src/js/daw/archive.js'
import { encodeGeneratedFloatWav } from '../../src/js/audio/generated-float-wav.js'
import { createPitchAnalysisClient } from '../../src/js/pitch/analysis-client.js'
import { analyzePitch } from '../../src/js/pitch/analysis.js'
import { tone, seededNoise } from '../audio/pitch-analysis-fixtures.js'

// Real DOM, YIN, analysis-client validation, planner, history, Float32 encoder,
// hashing and ZIP round trip. Web Audio nodes, worker transport and pitch/mix
// rendering are explicit test doubles: these tests do not prove browser audio
// behavior, Signalsmith quality, singing accuracy or real worker termination.
vi.mock('../../src/js/daw/render.js', () => ({ renderProject: vi.fn(), getPendingNativeRenderBytes: vi.fn(() => 0) }))

const html = readFileSync('index.html', 'utf8')
const el = id => document.getElementById(`daw-${id}`)
const action = id => document.querySelector(`[data-daw="${id}"]`)
const tick = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }
const click = async id => { action(id).click(); await tick() }
const change = async (id, value, type = 'change') => {
  el(id).value = String(value); el(id).dispatchEvent(new Event(type, { bubbles: true })); await tick()
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const idle = () => vi.waitFor(() => expect(document.getElementById('mode-editor').getAttribute('aria-busy')).toBe('false'))
const runAction = async id => { await click(id); await idle() }
const selectedClip = () => {
  const id = document.querySelector('.daw-clip[aria-pressed="true"]')?.dataset.clipId
  return panel.getProject().tracks.flatMap(track => track.clips).find(clip => clip.id === id)
}

let panel, ctx, original, sourceFile, pitchClient, analysisFactory, clients, workers, workerTasks, download

function makeBuffer(channels, rate = 48000) {
  const buffer = new AudioContext().createBuffer(channels.length, channels[0].length, rate)
  channels.forEach((data, channel) => buffer.copyToChannel(data, channel))
  return buffer
}

// This parser only reads our own synthetic IEEE_FLOAT fixtures. It deliberately
// bypasses native audio decoding, while archive structure/hash checks stay real.
function decodeFixture(bytes) {
  const view = new DataView(bytes), channels = view.getUint16(22, true), rate = view.getUint32(24, true)
  const length = view.getUint32(54, true) / (channels * 4)
  return makeBuffer(Array.from({ length: channels }, (_, c) => Float32Array.from({ length }, (_, i) => view.getFloat32(58 + (i * channels + c) * 4, true))), rate)
}

function analysisClient() {
  const worker = { terminated: false, controller: new AbortController() }
  worker.postMessage = vi.fn(request => {
    const task = analyzePitch(request.samples, request.sampleRate, { start: request.start, signal: worker.controller.signal })
      .then(result => { if (!worker.terminated) worker.onmessage?.({ data: { type: 'result', id: request.id, result } }) })
      .catch(error => { if (!worker.terminated) worker.onmessage?.({ data: { type: 'error', id: request.id, error: { name: error.name, message: error.message } } }) })
    workerTasks.push(task)
  })
  worker.terminate = vi.fn(() => { worker.terminated = true; worker.controller.abort() })
  workers.push(worker)
  const client = createPitchAnalysisClient({ workerFactory: () => worker })
  vi.spyOn(client, 'analyze'); vi.spyOn(client, 'dispose'); clients.push(client)
  return client
}

function renderDouble(channels, sampleRate, options) {
  return { channels: channels.map(channel => channel.map(sample => sample * .8)), sampleRate, sourceToken: options.sourceToken,
    metadata: { semitones: options.semitones + options.cents / 100, formantSemitones: options.formantSemitones,
      formantCompensation: options.formantCompensation, outputPeak: .3 } }
}

async function setup({ rate = 48000, cents = 23, duration = .8, channels, beforePlayback } = {}) {
  document.body.replaceChildren(new DOMParser().parseFromString(html, 'text/html').getElementById('app'))
  document.getElementById('mode-editor').hidden = false
  const samples = channels || [tone({ sampleRate: rate, duration, frequency: 440 * 2 ** (cents / 1200) })]
  original = makeBuffer(samples, rate)
  sourceFile = new File([await encodeGeneratedFloatWav(samples, rate)], 'synthetic-single-note.wav', { type: 'audio/wav', lastModified: 1234 })
  ctx = new AudioContext(); vi.spyOn(ctx, 'createBufferSource'); vi.spyOn(ctx, 'createGain'); vi.spyOn(ctx, 'close')
  ctx.createOscillator = vi.fn(() => ({ type: 'sine', frequency: { value: 440 }, onended: null,
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }))
  pitchClient = { render: vi.fn(async (...args) => renderDouble(...args)), dispose: vi.fn() }
  analysisFactory = vi.fn(analysisClient); download = vi.fn()
  panel = initDawPanel({ decodeAsset: async bytes => decodeFixture(bytes), downloadFile: download, confirmAction: () => true,
    pitchClientFactory: () => pitchClient, noteAnalysisClientFactory: analysisFactory, AudioContextClass: function () { return ctx }, beforePlayback })
  await panel.importFiles([sourceFile])
  // Use the actual retained decoded object, rather than the separately encoded fixture.
  await runAction('play'); original = renderProject.mock.calls.at(-1)[1].get(selectedClip().assetId); await click('stop')
  renderProject.mockClear(); ctx.createBufferSource.mockClear()
}

async function analyzeViaUi() {
  const count = analysisFactory.mock.calls.length
  await runAction('note-center-analyze')
  expect(analysisFactory).toHaveBeenCalledTimes(count + 1)
  expect(el('note-center-result').textContent).not.toBe('尚未分析')
}

async function readyCandidate() { await analyzeViaUi(); await runAction('note-center-render'); expect(el('replacement-review').hidden).toBe(false) }

async function analysisFor(buffer = original, channel = 0) {
  const result = await analyzePitch(buffer.getChannelData(channel), buffer.sampleRate)
  return { ...result, channel, analyzedChannel: channel }
}

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile); vi.stubGlobal('crypto', webcrypto)
  clients = []; workers = []; workerTasks = []
  getPendingNativeRenderBytes.mockReturnValue(0)
  renderProject.mockImplementation(async (project, buffers) => ({ buffer: buffers.get(project.tracks[0].clips[0].assetId), peak: .3, peaks: { truePeakDb: -10 } }))
})
afterEach(async () => {
  panel?.destroy(); await Promise.all(workerTasks); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

describe('single-note center controls and real analysis integration', () => {
  it('keeps every note control contextual and unavailable until a selected clip is analyzed', async () => {
    await setup()
    expect(el('note-center-details').open).toBe(false)
    expect(el('note-center-details').parentElement).toBe(el('transpose-details'))
    expect(el('note-center-details').closest('fieldset')).toBe(el('clip-fields'))
    expect(el('note-center-result').getAttribute('role')).toBe('status')
    expect(el('note-center-details').textContent).toContain('不逐音修正')
    expect(el('note-center-details').textContent).toContain('參考音不是樂譜答案')
    expect(action('note-center-analyze').disabled).toBe(false)
    expect(el('note-center-target').disabled).toBe(true)
    expect(action('note-center-render').disabled).toBe(true)
    expect(action('note-center-reference').disabled).toBe(true)
    await click('delete')
    expect(el('clip-fields').hidden).toBe(true); expect(action('note-center-analyze').disabled).toBe(true)
  })

  it.each([44100, 48000, 96000])('runs actual YIN at %i Hz into the existing A/B transaction, Accept, Undo and real ZIP', async rate => {
    await setup({ rate })
    const before = panel.getProject(), sourceId = selectedClip().assetId, originalPcm = original.getChannelData(0).slice()
    await analyzeViaUi()
    expect(el('note-center-result').textContent).toContain('目標 A4：整段降低')
    expect(action('note-center-render').disabled).toBe(false)
    expect(clients[0].analyze).toHaveBeenCalledWith(original, expect.objectContaining({ start: 0, duration: .8, channel: 0 }))
    expect(workers[0].postMessage).toHaveBeenCalledOnce(); expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[0].postMessage.mock.calls[0][0].samples).not.toBe(original.getChannelData(0))
    expect(panel.getProject()).toEqual(before)
    await runAction('note-center-render')
    expect(pitchClient.render).toHaveBeenCalledOnce()
    expect(pitchClient.render.mock.calls[0][2].cents).toBeCloseTo(-23, 0)
    expect(el('replacement-review').parentElement).toBe(el('transpose-details'))
    expect(panel.getProject()).toEqual(before)
    await runAction('replacement-preview')
    const [candidate, stagedBuffers] = renderProject.mock.calls.at(-1), candidateClip = candidate.tracks[0].clips[0]
    const staged = stagedBuffers.get(candidateClip.assetId)
    expect(ctx.createBufferSource.mock.results.at(-1).value.buffer).toBe(staged)
    expect(staged).not.toBe(original); expect(staged.sampleRate).toBe(rate)
    await click('stop'); await runAction('replacement-original')
    expect(ctx.createBufferSource.mock.results.at(-1).value.buffer).toBe(original)
    await click('stop'); await runAction('save')
    const pendingArchive = await importProjectArchive(download.mock.calls.at(-1)[0], { decodeAsset: decodeFixture })
    expect(pendingArchive.project).toEqual(before); expect(pendingArchive.files.size).toBe(1)
    await click('replacement-confirm')
    const accepted = panel.getProject(), acceptedClip = selectedClip()
    expect(acceptedClip.transpose).toMatchObject({ version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: sourceId,
      sourceOffsetSeconds: 0, sourceDurationSeconds: .8, cropFirstFrame: 0, cropLastFrame: Math.round(.8 * rate), formantSemitones: 0, formantCompensation: false })
    expect(acceptedClip.assetId).toBe(candidateClip.assetId); expect(accepted.assets).toHaveLength(2)
    await runAction('play'); expect(ctx.createBufferSource.mock.results.at(-1).value.buffer).toBe(staged)
    await click('stop'); await runAction('save')
    const archive = download.mock.calls.at(-1)[0]
    const restored = await importProjectArchive(archive, { decodeAsset: decodeFixture })
    expect(restored.project).toEqual(accepted)
    expect(restored.project.assets.at(-1)).toMatchObject({ sampleRate: rate, channels: 1, decodeBackend: 'generated-float32-wav' })
    expect(await restored.files.get(sourceId).arrayBuffer()).toEqual(await sourceFile.arrayBuffer())
    expect(restored.buffers.get(acceptedClip.assetId).getChannelData(0)).toEqual(staged.getChannelData(0))
    await click('undo'); expect(panel.getProject()).toEqual(before)
    await click('redo'); expect(panel.getProject()).toEqual(accepted)
    await panel.openArchive(archive); document.querySelector('.daw-clip').click(); await tick()
    expect(selectedClip().transpose).toEqual(acceptedClip.transpose)
    expect(action('undo').disabled).toBe(true)
    await click('transpose-original'); expect(selectedClip()).toEqual(before.tracks[0].clips[0])
    expect(original.getChannelData(0)).toEqual(originalPcm); expect(pitchClient.render).toHaveBeenCalledOnce()
  })

  it('analyzes only the current trimmed source window and preserves clip placement and envelope', async () => {
    await setup({ duration: 1 })
    await change('trim-start', .1); await change('trim-end', .8); await click('trim')
    await change('clip-gain', -3); await change('fade-in', .02); await change('fade-out', .03); await click('fades'); await click('automation-add')
    const before = selectedClip()
    await readyCandidate()
    expect(clients[0].analyze.mock.calls[0][1]).toMatchObject({ start: .1, duration: before.durationSeconds, channel: 0 })
    expect(pitchClient.render.mock.calls[0][0][0]).toEqual(original.getChannelData(0).subarray(4800, 38400))
    await click('replacement-confirm')
    expect(selectedClip()).toEqual({ ...before, assetId: selectedClip().assetId, offsetSeconds: 0, transpose: selectedClip().transpose })
  })

  it('recalculates an accepted total from the retained original instead of stacking another pass', async () => {
    await setup()
    const initial = selectedClip(), pcm = original.getChannelData(0).slice()
    // A known synthetic output models an already accepted audible +1 semitone.
    // It is a lifecycle fixture, not an implementation of pitch shifting.
    pitchClient.render.mockImplementationOnce(async (channels, rate, options) => ({ ...renderDouble(channels, rate, options),
      channels: [tone({ sampleRate: rate, duration: .8, frequency: 440 * 2 ** (123 / 1200) })] }))
    await change('transpose-semitones', 1, 'input'); await change('transpose-formants', -.5, 'input')
    el('transpose-compensation').checked = true
    await panel.prepareTranspose(); await click('replacement-confirm')
    const accepted = panel.getProject(), audibleSource = selectedClip().assetId
    await analyzeViaUi(); await runAction('note-center-render')
    expect(clients[0].analyze.mock.calls[0][0]).not.toBe(original)
    expect(el('note-center-result').textContent).toContain('目標 A♯4')
    const [input, rate, options] = pitchClient.render.mock.calls[1]
    expect(input[0]).toEqual(pcm); expect(rate).toBe(48000)
    expect(options).toMatchObject({ semitones: 1, formantSemitones: -.5, formantCompensation: true })
    expect(options.cents).toBeCloseTo(-23, 0)
    expect(panel.getProject()).toEqual(accepted)
    await click('replacement-confirm')
    expect(selectedClip().transpose.sourceAssetId).toBe(initial.assetId)
    expect(selectedClip().assetId).not.toBe(audibleSource)
    await click('undo'); expect(panel.getProject()).toEqual(accepted)
  })

  it.each([-3, 0, 3])('advises retaining a %+i-cent note, allows reference listening and disables one-click processing', async cents => {
    await setup({ cents }); const before = panel.getProject()
    await analyzeViaUi()
    expect(el('note-center-result').textContent).toContain('已很接近，建議保留目前聲音')
    expect(action('note-center-render').disabled).toBe(true)
    expect(action('note-center-reference').disabled).toBe(false)
    await expect(panel.prepareCenteredNote()).rejects.toThrow('建議先保留')
    expect(pitchClient.render).not.toHaveBeenCalled(); expect(panel.getProject()).toEqual(before)
    await change('note-center-target', 70)
    expect(action('note-center-render').disabled).toBe(false)
    expect(el('note-center-result').textContent).toContain('目標 A♯4')
  })

  it('analyzes both anti-phase stereo channels independently and renders one shared correction', async () => {
    const left = tone({ duration: .8, frequency: 440 * 2 ** (.23 / 12) })
    await setup({ channels: [left, left.map(value => -value)] })
    await readyCandidate()
    expect(clients[0].analyze.mock.calls.map(call => call[1].channel)).toEqual([0, 1])
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2)
    expect(pitchClient.render).toHaveBeenCalledOnce(); expect(pitchClient.render.mock.calls[0][0]).toHaveLength(2)
    expect(pitchClient.render.mock.calls[0][2].cents).toBeCloseTo(-23, 0)
  })

  it.each([
    ['different stereo voices', () => [tone({ duration: .8, frequency: 440 }), tone({ duration: .8, frequency: 466.164 })], '左右聲道的音高中心不一致'],
    ['silent right channel', () => [tone({ duration: .8 }), new Float32Array(38400)], '沒有足夠可靠'],
    ['silence', () => [new Float32Array(38400)], '沒有足夠可靠'],
    ['noise', () => [seededNoise({ duration: .8 })], '沒有足夠可靠'],
    ['two sequential notes', () => {
      const data = new Float32Array(48000); data.set(tone({ duration: .5, frequency: 440 })); data.set(tone({ duration: .5, frequency: 523.251 }), 24000); return [data]
    }, '片段可能含多個音高中心'],
  ])('refuses %s without proposing or staging audio', async (_label, channels, message) => {
    await setup({ channels: channels() }); const before = panel.getProject()
    await analyzeViaUi()
    expect(el('note-center-result').textContent).toContain(message)
    expect(el('note-center-target').disabled).toBe(true)
    expect(action('note-center-render').disabled).toBe(true); expect(action('note-center-reference').disabled).toBe(true)
    expect(el('replacement-review').hidden).toBe(true)
    await expect(panel.prepareCenteredNote()).rejects.toThrow()
    expect(pitchClient.render).not.toHaveBeenCalled(); expect(panel.getProject()).toEqual(before)
  })

  it('requires a shared explicit target when close stereo channels straddle nearest notes', async () => {
    await setup({ channels: [45, 55].map(cents => tone({ duration: .8, frequency: 440 * 2 ** (cents / 1200) })) })
    await analyzeViaUi()
    expect(el('note-center-result').textContent).toContain('左右聲道的最近參考音不同')
    expect(action('note-center-render').disabled).toBe(true)
    await change('note-center-target', 69)
    expect(action('note-center-render').disabled).toBe(false)
    await runAction('note-center-render')
    const settings = pitchClient.render.mock.calls[0][2]
    expect(settings.semitones + settings.cents / 100).toBeCloseTo(-.5, 2)
  })

  it('refuses a malformed contour and an out-of-range target without replacing original audio', async () => {
    await setup(); const before = panel.getProject(), result = await analysisFor()
    const invalid = { analyze: vi.fn(async () => ({ ...result, frames: result.frames.slice(1) })), dispose: vi.fn() }
    analysisFactory.mockReturnValueOnce(invalid)
    await analyzeViaUi()
    expect(el('note-center-result').textContent).toContain('音高分析資料不完整')
    expect(action('note-center-render').disabled).toBe(true); expect(invalid.dispose).toHaveBeenCalledOnce()
    await analyzeViaUi(); await change('note-center-target', 72)
    expect(el('note-center-result').textContent).toContain('超過正負 2 半音')
    expect(action('note-center-render').disabled).toBe(true)
    expect(panel.getProject()).toEqual(before); expect(pitchClient.render).not.toHaveBeenCalled()
  })

  it('refuses an undersized clip and a memory over-budget analysis before creating a client', async () => {
    await setup({ duration: .2 })
    await expect(panel.analyzeNoteCenter()).rejects.toThrow('0.35–30 秒')
    expect(analysisFactory).not.toHaveBeenCalled()
    panel.destroy(); await setup()
    getPendingNativeRenderBytes.mockReturnValue(512 * 1024 * 1024)
    await expect(panel.analyzeNoteCenter()).rejects.toThrow('記憶體預算')
    expect(analysisFactory).not.toHaveBeenCalled()
    getPendingNativeRenderBytes.mockReturnValue(0)
    await analyzeViaUi(); expect(action('note-center-render').disabled).toBe(false)
  })
})

describe('note proposal invalidation and interrupted jobs', () => {
  it.each(['manual settings', 'target', 'project', 'selection', 'source', 'navigation', 'undo'])('invalidates a staged note render on %s', async reason => {
    await setup(); await panel.importFiles([new File([await sourceFile.arrayBuffer()], 'second.wav', { type: 'audio/wav' })])
    await readyCandidate()
    if (reason === 'manual settings') await change('transpose-cents', 12, 'input')
    else if (reason === 'target') await change('note-center-target', 70)
    else if (reason === 'project') await change('tempo', 90)
    else if (reason === 'selection') { document.querySelector('.daw-clip').click(); await tick() }
    else if (reason === 'source') await click('delete')
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else await click('undo')
    const after = panel.getProject()
    expect(el('replacement-review').hidden).toBe(true)
    expect(() => panel.confirmReplacement()).toThrow()
    expect(panel.getProject()).toEqual(after)
    expect(after.assets.every(asset => asset.decodeBackend !== 'generated-float32-wav')).toBe(true)
    if (reason === 'target') expect(el('note-center-result').textContent).toContain('目標 A♯4')
    else { expect(el('note-center-result').textContent).toBe('尚未分析'); expect(action('note-center-render').disabled).toBe(true) }
  })

  it.each(['manual settings', 'navigation'])('immediately disables cleared proposal controls after %s without a staged render', async reason => {
    await setup(); await analyzeViaUi()
    if (reason === 'manual settings') await change('transpose-cents', 12, 'input')
    else document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    expect(el('note-center-result').textContent).toBe('尚未分析')
    expect(el('note-center-target').disabled).toBe(true)
    expect(action('note-center-reference').disabled).toBe(true)
    expect(action('note-center-render').disabled).toBe(true)
  })

  it('rejects uncommitted target changes at the Accept boundary', async () => {
    await setup(); await readyCandidate(); const before = panel.getProject()
    el('note-center-target').value = '70'
    expect(() => panel.confirmReplacement()).toThrow()
    expect(panel.getProject()).toEqual(before)
  })

  it.each(['target', 'manual settings', 'project', 'navigation', 'cancel', 'destroy'])('rejects an old rendered completion after %s', async reason => {
    await setup(); await analyzeViaUi(); const gate = deferred()
    pitchClient.render.mockImplementationOnce((...args) => gate.promise.then(() => renderDouble(...args)))
    const pending = panel.prepareCenteredNote(), rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); expect(pitchClient.render).toHaveBeenCalledOnce()
    if (reason === 'target') await change('note-center-target', 70)
    else if (reason === 'manual settings') await change('transpose-cents', 12, 'input')
    else if (reason === 'project') await change('tempo', 90)
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (reason === 'destroy') panel.destroy()
    else await click('cancel')
    const before = panel.getProject(); gate.resolve(); await rejection
    expect(panel.getProject()).toEqual(before); expect(before.assets).toHaveLength(1)
    expect(el('replacement-review').hidden).toBe(true)
  })

  it('does not let a cancelled analysis finalizer dispose or unlock a newer analysis client', async () => {
    await setup(); const first = deferred(), second = deferred(), result = await analysisFor(), before = panel.getProject()
    const oldClient = { analyze: vi.fn(() => first.promise), dispose: vi.fn() }
    const newClient = { analyze: vi.fn(() => second.promise), dispose: vi.fn() }
    analysisFactory.mockReturnValueOnce(oldClient).mockReturnValueOnce(newClient)
    const oldTask = panel.analyzeNoteCenter(), rejected = expect(oldTask).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); await click('cancel')
    expect(oldClient.dispose).toHaveBeenCalled()
    const newTask = panel.analyzeNoteCenter(); await tick()
    first.resolve(result); await rejected
    expect(newClient.dispose).not.toHaveBeenCalled()
    expect(document.getElementById('mode-editor').getAttribute('aria-busy')).toBe('true')
    expect(action('note-center-analyze').disabled).toBe(true)
    expect(el('note-center-result').textContent).toBe('尚未分析')
    second.resolve(result); await newTask
    expect(newClient.dispose).toHaveBeenCalledOnce(); expect(action('note-center-render').disabled).toBe(false)
    expect(panel.getProject()).toEqual(before)
  })

  it.each(['manual settings', 'project', 'selection', 'source', 'navigation', 'clear', 'destroy'])('retires an in-flight analysis after %s and never publishes its old proposal', async reason => {
    await setup(); await panel.importFiles([new File([await sourceFile.arrayBuffer()], 'second.wav', { type: 'audio/wav' })])
    const task = panel.analyzeNoteCenter(), rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
    await tick(); expect(clients[0].analyze).toHaveBeenCalledOnce()
    if (reason === 'manual settings') await change('transpose-cents', 12, 'input')
    else if (reason === 'project') await change('tempo', 90)
    else if (reason === 'selection') { document.querySelector('.daw-clip').click(); await tick() }
    else if (reason === 'source') await click('delete')
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (reason === 'destroy') panel.destroy()
    else panel.clear()
    const after = panel.getProject(); await rejection; await Promise.all(workerTasks)
    expect(workers[0].terminate).toHaveBeenCalledOnce(); expect(clients[0].dispose).toHaveBeenCalled()
    expect(el('note-center-result').textContent).toBe('尚未分析')
    expect(action('note-center-render').disabled).toBe(true)
    expect(panel.getProject()).toEqual(after); expect(pitchClient.render).not.toHaveBeenCalled()
  })

  it('disposes cancelled real analysis clients and allows repeated retry and timeout recovery', async () => {
    await setup(); const before = panel.getProject()
    for (let i = 0; i < 2; i++) {
      const task = panel.analyzeNoteCenter(), rejection = expect(task).rejects.toMatchObject({ name: 'AbortError' })
      await click('cancel'); await rejection
      expect(workers.at(-1).terminate).toHaveBeenCalledOnce()
      expect(el('note-center-result').textContent).toBe('尚未分析')
    }
    const failed = { analyze: vi.fn(async () => { throw Object.assign(new Error('analysis timeout'), { name: 'TimeoutError' }) }), dispose: vi.fn() }
    analysisFactory.mockReturnValueOnce(failed)
    await expect(panel.analyzeNoteCenter()).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(failed.dispose).toHaveBeenCalledOnce(); expect(action('note-center-analyze').disabled).toBe(false)
    await analyzeViaUi(); expect(action('note-center-render').disabled).toBe(false)
    expect(panel.getProject()).toEqual(before)
  })
})

describe('short target-reference oscillator ownership', () => {
  it.each(['stop', 'target', 'navigation', 'destroy', 'natural end'])('stops and disconnects the reference on %s without modifying the project', async reason => {
    await setup(); await analyzeViaUi(); const before = panel.getProject()
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    await runAction('note-center-reference')
    const oscillator = ctx.createOscillator.mock.results[0].value, gain = ctx.createGain.mock.results.at(-1).value
    expect(oscillator.frequency.value).toBe(440)
    expect(oscillator.connect).toHaveBeenCalledWith(gain); expect(gain.connect).toHaveBeenCalledWith(ctx.destination)
    expect(oscillator.start).toHaveBeenCalledWith(0); expect(oscillator.stop).toHaveBeenCalledWith(.81)
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(.035, .02)
    expect(action('stop').disabled).toBe(false)
    clear.mockClear()
    if (reason === 'target') await change('note-center-target', 70)
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (reason === 'destroy') panel.destroy()
    else if (reason === 'natural end') oscillator.onended()
    else await click('stop')
    expect(oscillator.stop).toHaveBeenCalledTimes(2)
    expect(oscillator.disconnect).toHaveBeenCalledOnce(); expect(gain.disconnect).toHaveBeenCalledOnce()
    expect(oscillator.onended).toBeNull(); expect(clear).toHaveBeenCalled()
    expect(panel.getProject()).toEqual(before)
  })

  it('retires an old reference before replay and uses the current target pitch', async () => {
    await setup(); await analyzeViaUi(); await runAction('note-center-reference')
    const first = ctx.createOscillator.mock.results[0].value
    await change('note-center-target', 70); await runAction('note-center-reference')
    const second = ctx.createOscillator.mock.results[1].value
    expect(first.disconnect).toHaveBeenCalledOnce(); expect(second.frequency.value).toBeCloseTo(466.1638, 3)
    expect(ctx.createBufferSource).not.toHaveBeenCalled()
  })

  it('cleans up when the reference fallback timer fires without an ended event', async () => {
    await setup(); await analyzeViaUi(); vi.useFakeTimers()
    await click('note-center-reference')
    const oscillator = ctx.createOscillator.mock.results[0].value, gain = ctx.createGain.mock.results.at(-1).value
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(oscillator.disconnect).toHaveBeenCalledOnce(); expect(gain.disconnect).toHaveBeenCalledOnce()
    expect(oscillator.onended).toBeNull(); expect(vi.getTimerCount()).toBe(0)
    expect(action('stop').disabled).toBe(true)
  })

  it.each(['cancel', 'manual settings', 'navigation', 'destroy'])('cancels a queued reference on %s before the playback gate resolves', async reason => {
    const gate = deferred(); await setup(); await analyzeViaUi()
    // The injected context resume gate represents a suspended browser context.
    vi.spyOn(ctx, 'resume').mockReturnValueOnce(gate.promise)
    await click('note-center-reference')
    if (reason === 'manual settings') await change('transpose-cents', 12, 'input')
    else if (reason === 'navigation') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'lyrics' } }))
    else if (reason === 'destroy') panel.destroy()
    else await click('cancel')
    gate.resolve(); await tick()
    expect(ctx.createOscillator).not.toHaveBeenCalled()
    if (reason === 'cancel') { await runAction('note-center-reference'); expect(ctx.createOscillator).toHaveBeenCalledOnce() }
  })
})
