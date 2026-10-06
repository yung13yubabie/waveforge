// @vitest-environment node
// Synthetic rendered PCM tests: native Web Audio DSP is covered separately.
import { describe, it, expect, vi } from 'vitest'
import { applyCommand, createProject, getProjectDuration, validateProject } from '../../src/js/daw/project.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { timelineSelectionFrameBounds, selectedRenderView } from '../../src/js/daw/selection.js'
import { measurePeaks } from '../../src/js/audio/measure.js'
import { encodeWAV } from '../../src/js/audio/wav.js'

const rates = [44100, 48000, 96000]
const copy = value => JSON.parse(JSON.stringify(value))
const setRange = (project, startSeconds, endSeconds) => applyCommand(project, {
  type: 'timelineSelection.set', selection: { startSeconds, endSeconds },
})
function fixture(rate = 48000) {
  let project = createProject({ id: 'range-project', sampleRate: rate, assets: [
    { id: 'voice', name: 'native-44k.wav', duration: 1, sampleRate: 44100, channels: 1, length: 44100 },
    { id: 'backing', name: 'native-96k.wav', duration: 1, sampleRate: 96000, channels: 2, length: 96000 },
  ] })
  for (const id of ['voice', 'backing']) {
    project = applyCommand(project, { type: 'track.add', track: { id } })
    project = applyCommand(project, { type: 'clip.add', trackId: id, clip: { id: `${id}-clip`, assetId: id } })
  }
  return project
}
function renderedFixture(project, fill = (frame, channel) => (channel ? -.2 : .3) * Math.sin(frame / 17)) {
  const plan = buildRenderPlan(project)
  const channels = Array.from({ length: 2 }, (_, channel) => Float32Array.from({ length: plan.frames }, (_, frame) => fill(frame, channel)))
  const buffer = { length: plan.frames, sampleRate: plan.sampleRate, numberOfChannels: 2,
    duration: plan.frames / plan.sampleRate, getChannelData: channel => channels[channel] }
  return { buffer, plan, revision: project.revision, peak: 5, clippedSamples: 9876,
    peaks: { samplePeakDb: 10, truePeakDb: 12, clipped: true } }
}

describe('saved timeline range commands', () => {
  it('keeps old projects valid and changes only bounded range metadata in one undoable command', () => {
    const project = fixture(), before = copy(project), history = new ProjectHistory(project)
    const selection = { startSeconds: .125, endSeconds: .8 }
    const selected = applyCommand(project, { type: 'timelineSelection.set', selection })
    selection.startSeconds = .4
    expect(project).toEqual(before)
    expect(selected.revision).toBe(project.revision + 1)
    expect(selected.timelineSelection).toEqual({ startSeconds: .125, endSeconds: .8 })
    expect({ ...selected, revision: project.revision, timelineSelection: undefined }).toEqual({ ...project, timelineSelection: undefined })
    history.push(selected)
    const cleared = applyCommand(selected, { type: 'timelineSelection.clear' })
    expect(cleared).not.toHaveProperty('timelineSelection')
    expect(cleared.revision).toBe(selected.revision + 1)
    history.push(cleared)
    expect(history.undo()).toEqual(selected)
    expect(history.undo()).toEqual(project)
    expect(history.redo()).toEqual(selected)
    expect(history.redo()).toEqual(cleared)
  })

  it.each([
    null, undefined, [], new Date(), Object.create({ startSeconds: 0, endSeconds: .5 }),
    { startSeconds: 0 }, { endSeconds: 1 }, { startSeconds: '0', endSeconds: 1 },
    { startSeconds: 0, endSeconds: '1' }, { startSeconds: NaN, endSeconds: 1 },
    { startSeconds: 0, endSeconds: Infinity }, { startSeconds: -1, endSeconds: 1 },
    { startSeconds: .5, endSeconds: .5 }, { startSeconds: .6, endSeconds: .5 },
    { startSeconds: 0, endSeconds: 1.00001 }, { startSeconds: 0, endSeconds: 601 },
    { startSeconds: 0, endSeconds: Number.EPSILON },
    { startSeconds: 0, endSeconds: 1, trackId: 'voice' },
    JSON.parse('{"startSeconds":0,"endSeconds":1,"__proto__":{}}'),
  ])('rejects malformed/out-of-bounds metadata without a revision or history change: %j', selection => {
    const project = fixture(), before = copy(project), history = new ProjectHistory(project)
    expect(() => history.push(applyCommand(project, { type: 'timelineSelection.set', selection }))).toThrow()
    expect(project).toEqual(before)
    expect(history.current).toEqual(project)
    expect(history.canUndo).toBe(false)
    expect(() => validateProject({ ...project, timelineSelection: selection })).toThrow()
  })

  it('requires actual project bounds and rejects extra command metadata before changing a saved range', () => {
    expect(() => setRange(createProject(), 0, .1)).toThrow(/timeline selection/)
    const project = setRange(fixture(), .1, .5)
    expect(() => applyCommand(project, { type: 'timelineSelection.set', selection: { startSeconds: .2, endSeconds: .6 }, secret: true })).toThrow(/unsupported/)
    expect(() => applyCommand(project, { type: 'timelineSelection.clear', secret: true })).toThrow(/unsupported/)
    expect(project.timelineSelection).toEqual({ startSeconds: .1, endSeconds: .5 })
  })

  it.each([
    { type: 'clip.remove', trackId: 'backing', clipId: 'backing-clip' },
    { type: 'track.remove', trackId: 'backing' },
    { type: 'clip.move', trackId: 'backing', clipId: 'backing-clip', atSeconds: 0 },
    { type: 'clip.trim', trackId: 'backing', clipId: 'backing-clip', startSeconds: 1, endSeconds: 1.4 },
  ])('clears a range invalidated by $type in the same undoable edit, without clamping', command => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.move', trackId: 'backing', clipId: 'backing-clip', atSeconds: 1 })
    project = setRange(project, .25, 1.8)
    const history = new ProjectHistory(project), before = copy(project)
    const next = applyCommand(project, command)
    expect(getProjectDuration(next)).toBeLessThan(1.8)
    expect(next).not.toHaveProperty('timelineSelection')
    expect(next.revision).toBe(project.revision + 1)
    expect(project).toEqual(before)
    history.push(next)
    expect(history.undo()).toEqual(project)
    expect(history.redo()).toEqual(next)
  })

  it('keeps ranges through edits that preserve their bounds, mute/solo, gain regions, automation and tempo', () => {
    const original = setRange(fixture(), .125, 1)
    let project = original
    for (const command of [
      { type: 'project.update', patch: { tempo: 76, sampleRate: 96000 } },
      { type: 'track.update', trackId: 'voice', patch: { mute: true, solo: true } },
      { type: 'clip.automation.add', trackId: 'voice', clipId: 'voice-clip', point: { timeSeconds: .5, value: .6 } },
      { type: 'clip.gainRegion.add', trackId: 'voice', clipId: 'voice-clip', region: { id: 'line', startSeconds: .2, endSeconds: .7, gain: 0 } },
      { type: 'clip.split', trackId: 'backing', clipId: 'backing-clip', atSeconds: .5, newId: 'backing-tail' },
    ]) {
      project = applyCommand(project, command)
      expect(project.timelineSelection).toEqual(original.timelineSelection)
    }
    expect(project.tracks[0].clips[0].volumeAutomation).toHaveLength(3)
    expect(project.tracks[0].clips[0].gainRegions).toHaveLength(1)
    expect(getProjectDuration(project)).toBe(1)
  })
})

describe('half-open selection output frame bounds', () => {
  it.each(rates)('preserves exact start/end frames and output rate for mixed native inputs at %i Hz', rate => {
    for (const [first, last] of [[0, 1], [1, 2], [97, 5518], [6007, 12001], [rate - 1, rate]]) {
      const bounds = timelineSelectionFrameBounds(setRange(fixture(rate), first / rate, last / rate))
      expect(bounds).toEqual({ firstFrame: first, lastFrame: last, length: last - first, sampleRate: rate,
        startSeconds: first / rate, endSeconds: last / rate, durationSeconds: (last - first) / rate })
    }
  })

  it.each(rates)('covers genuine fractional edges and normalizes only roundoff at %i Hz', rate => {
    for (const delta of [.000001, .1, .5, -.000001, -.1, -.5]) {
      const selection = setRange(fixture(rate), (100 + delta) / rate, (200 + delta) / rate)
      expect(timelineSelectionFrameBounds(selection)).toMatchObject({ firstFrame: delta > 0 ? 100 : 99, lastFrame: delta > 0 ? 201 : 200, length: 101 })
    }
    const selection = setRange(fixture(rate), .35 - .25, .3)
    expect(timelineSelectionFrameBounds(selection)).toMatchObject({ firstFrame: rate / 10, lastFrame: rate * .3 })
  })

  it.each(rates)('retains small fractional and one-frame ranges near the 600-second limit at %i Hz', rate => {
    let project = fixture(rate)
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'voice-clip', atSeconds: 599 })
    const last = 600 * rate
    expect(timelineSelectionFrameBounds(setRange(project, (last - 1) / rate, 600))).toMatchObject({ firstFrame: last - 1, lastFrame: last, length: 1 })
    expect(timelineSelectionFrameBounds(setRange(project, (last - 1.5) / rate, (last - .25) / rate))).toMatchObject({ firstFrame: last - 2, lastFrame: last, length: 2 })
  })
})

describe('selected view of the actual full mix', () => {
  it.each(rates)('reuses exact per-channel full-render samples for audition and WAV at %i Hz', async rate => {
    const project = setRange(fixture(rate), 97 / rate, 6007 / rate), before = copy(project)
    const rendered = renderedFixture(project)
    const fullBefore = [rendered.buffer.getChannelData(0).slice(), rendered.buffer.getChannelData(1).slice()]
    const view = await selectedRenderView(project, rendered)
    expect(view.buffer).toBe(rendered.buffer)
    expect(view).toMatchObject({ firstFrame: 97, lastFrame: 6007, length: 5910, sampleRate: rate, projectId: project.id, revision: project.revision })
    expect(view.selection).toEqual(project.timelineSelection)
    expect(view.selection).not.toBe(project.timelineSelection)
    for (let channel = 0; channel < 2; channel++) {
      const full = rendered.buffer.getChannelData(channel), selected = view.channels[channel]
      expect(selected.buffer).toBe(full.buffer)
      expect(selected.byteOffset).toBe(full.byteOffset + 97 * 4)
      expect(selected).toEqual(fullBefore[channel].subarray(97, 6007))
      expect(full).toEqual(fullBefore[channel])
    }
    const fullWav = new Uint8Array(encodeWAV(fullBefore, rate, 24))
    const selectedWav = new Uint8Array(encodeWAV(view.channels, view.sampleRate, 24))
    expect(new DataView(selectedWav.buffer).getUint32(24, true)).toBe(rate)
    expect(new DataView(selectedWav.buffer).getUint32(40, true)).toBe(view.length * 2 * 3)
    // 24-bit conversion is deterministic: the interleaved payload is exactly
    // the corresponding part of a full WAV, with no timing/pitch processing.
    expect(selectedWav.subarray(44)).toEqual(fullWav.subarray(44 + 97 * 6, 44 + 6007 * 6))
    expect(Math.round(view.startSeconds * rate)).toBe(97)
    expect(Math.round(view.durationSeconds * rate)).toBe(5910)
    expect(project).toEqual(before)
  })

  it('measures only the selected quiet samples, independently of full-mix overload elsewhere', async () => {
    const project = setRange(fixture(), .25, .5)
    const rendered = renderedFixture(project, (frame, channel) => frame < 12000 || frame >= 24000 ? 3 : channel ? -.125 : .25)
    const result = await selectedRenderView(project, rendered)
    expect(result.peak).toBe(.25)
    expect(result.clippedSamples).toBe(0)
    expect(result.peaks).toEqual(measurePeaks(result.channels))
    expect(result.peaks.samplePeakDb).toBeLessThan(0)
    expect(result.peaks.truePeakDb).toBeLessThan(0)
    expect(result.peaks.clipped).toBe(false)
    expect(rendered.peak).toBe(5)
    expect(rendered.buffer.getChannelData(0)[11999]).toBe(3)
    expect(rendered.buffer.getChannelData(1)[24000]).toBe(3)
  })

  it('retains overload inside either selected channel and recomputes cut-edge true peaks', async () => {
    const project = setRange(fixture(), 10 / 48000, 15 / 48000)
    const rendered = renderedFixture(project, () => 0)
    rendered.buffer.getChannelData(1)[14] = -1.5
    const result = await selectedRenderView(project, rendered)
    expect(result.peak).toBe(1.5)
    expect(result.clippedSamples).toBe(1)
    expect(result.channels[1][4]).toBe(-1.5)
    expect(result.peaks).toEqual(measurePeaks([new Float32Array(5), Float32Array.of(0, 0, 0, 0, -1.5)]))
    expect(result.peaks.truePeakDb).toBeGreaterThanOrEqual(result.peaks.samplePeakDb)
    expect(result.peaks.samplePeakDb).toBeGreaterThan(0)
  })

  it('accepts silent gaps and a one-frame tail without moving clips or dropping an existing timeline tail', async () => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'voice-clip', atSeconds: 2 })
    project = setRange(project, 1.25, 1.75)
    const before = copy(project), gap = await selectedRenderView(project, renderedFixture(project, () => 0))
    expect(gap.length).toBe(24000)
    expect(gap.peak).toBe(0)
    expect(gap.peaks).toEqual({ samplePeakDb: -Infinity, truePeakDb: -Infinity, clipped: false })
    expect(project).toEqual(before)
    project = setRange(project, 3 - 1 / 48000, 3)
    const full = renderedFixture(project, () => 0)
    full.buffer.getChannelData(1)[full.buffer.length - 1] = .4
    const tail = await selectedRenderView(project, full)
    expect(tail.length).toBe(1)
    expect(tail.channels[1][0]).toBeCloseTo(.4)
    expect(tail.lastFrame).toBe(full.buffer.length)
  })

  it.each([
    ['different project ID', (project, result) => { result.plan.projectId = 'wrong-project' }],
    ['old revision', (project, result) => { result.revision-- }],
    ['old plan revision', (project, result) => { result.plan.revision-- }],
    ['different mix recipe in the same revision', (project, result) => { result.plan.masterGain = .5 }],
    ['different sample rate', (project, result) => { result.buffer.sampleRate = 44100 }],
    ['truncated buffer', (project, result) => { result.buffer.length-- }],
    ['wrong channels', (project, result) => { result.buffer.numberOfChannels = 1 }],
    ['wrong duration', (project, result) => { result.buffer.duration += .1 }],
  ])('rejects %s before reading or slicing audio', async (_name, mutate) => {
    const project = setRange(fixture(), .1, .5), result = renderedFixture(project)
    result.buffer.getChannelData = vi.fn(result.buffer.getChannelData)
    mutate(project, result)
    await expect(selectedRenderView(project, result)).rejects.toThrow(/current full project render|valid full mix buffer/)
    expect(result.buffer.getChannelData).not.toHaveBeenCalled()
  })

  it('rejects a missing selection and an over-budget native full render before channel access', async () => {
    const project = fixture(), result = renderedFixture(project)
    result.buffer.getChannelData = vi.fn(result.buffer.getChannelData)
    await expect(selectedRenderView(project, result)).rejects.toThrow(/select a timeline range/)
    let huge = applyCommand(fixture(96000), { type: 'clip.move', trackId: 'voice', clipId: 'voice-clip', atSeconds: 599 })
    huge = setRange(huge, .1, .2)
    await expect(selectedRenderView(huge, result)).rejects.toThrow(/memory limit/)
    expect(result.buffer.getChannelData).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong PCM type', () => new Float64Array(48000)],
    ['wrong PCM length', () => new Float32Array(47999)],
    ['non-finite samples', () => { const data = new Float32Array(48000); data[2400] = NaN; return data }],
  ])('rejects %s within a selection', async (_name, getChannelData) => {
    const project = setRange(fixture(), 0, .1), result = renderedFixture(project)
    result.buffer.getChannelData = getChannelData
    await expect(selectedRenderView(project, result)).rejects.toThrow(/invalid mix channel|non-finite/)
  })

  it('checks cancellation and currentness before any channel access or slicing', async () => {
    const project = setRange(fixture(), .1, .2), result = renderedFixture(project), controller = new AbortController()
    result.buffer.getChannelData = vi.fn(result.buffer.getChannelData)
    controller.abort()
    await expect(selectedRenderView(project, result, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    await expect(selectedRenderView(project, result, { isCurrent: () => false })).rejects.toHaveProperty('name', 'AbortError')
    expect(result.buffer.getChannelData).not.toHaveBeenCalled()
    const second = new AbortController(), data = new Float32Array(48000)
    data.subarray = vi.fn(data.subarray)
    result.buffer.getChannelData = () => { second.abort(); return data }
    await expect(selectedRenderView(project, result, { signal: second.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(data.subarray).not.toHaveBeenCalled()
  })

  it('lets queued cancellation win after a synchronous peak scan', async () => {
    const project = setRange(fixture(), .1, .2), result = renderedFixture(project), controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 0)
    try { await expect(selectedRenderView(project, result, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError') }
    finally { clearTimeout(timer) }
  })

  it.each([
    project => { project.revision++ },
    project => { project.timelineSelection.startSeconds = .11 },
    project => { project.masterGainDb = -12 },
  ])('discards a selected view superseded during measurement', async mutate => {
    const project = setRange(fixture(), .1, .2), result = renderedFixture(project)
    const pending = selectedRenderView(project, result)
    mutate(project)
    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
  })
})
