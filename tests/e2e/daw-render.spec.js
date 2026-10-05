/**
 * Real browser OfflineAudioContext tests. These import the dev modules, never a
 * production window hook. Unit mock tests do not substitute for this DSP suite.
 */
import { test, expect } from '@playwright/test'

async function prepare(page) {
  await page.goto('/')
  await page.evaluate(async () => {
    const project = await import('/src/js/daw/project.js')
    const render = await import('/src/js/daw/render.js')
    window.dawTest = { ...project, ...render }
  })
}

test('split inside fades and trim preserve exact source audio and gain envelopes', async ({ page }) => {
  await prepare(page)
  const result = await page.evaluate(async () => {
    const { createProject, registerAudioBuffer, applyCommand, renderProject } = window.dawTest
    const source = new AudioBuffer({ length: 24000, sampleRate: 48000, numberOfChannels: 2 })
    for (let channel = 0; channel < 2; channel++) for (let i = 0; i < source.length; i++) {
      source.getChannelData(channel)[i] = Math.sin(2 * Math.PI * (channel ? 937 : 431) * i / source.sampleRate) * 0.25
    }
    const map = new Map()
    let project = registerAudioBuffer(createProject(), map, source, { id: 'source', name: 'original.wav' }).project
    project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
    project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: {
      id: 'clip', assetId: 'source', atSeconds: 0.125, offsetSeconds: 0.0625, durationSeconds: 0.375,
      fadeInSeconds: 0.125, fadeOutSeconds: 0.125,
    } })
    const original = (await renderProject(project, map)).buffer
    let split = applyCommand(project, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: 0.1875, newId: 'right' })
    split = applyCommand(split, { type: 'clip.split', trackId: 'track', clipId: 'right', atSeconds: 0.4375, newId: 'tail' })
    const splitMix = (await renderProject(split, map)).buffer
    const trimmed = applyCommand(project, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 0.1875, endSeconds: 0.4375 })
    const trimMix = (await renderProject(trimmed, map)).buffer
    let splitError = 0, trimError = 0, beforeTrimPeak = 0
    for (let channel = 0; channel < 2; channel++) {
      for (let i = 0; i < original.length; i++) splitError = Math.max(splitError, Math.abs(original.getChannelData(channel)[i] - splitMix.getChannelData(channel)[i]))
      for (let i = 0; i < trimMix.length; i++) {
        if (i < 0.1875 * 48000) beforeTrimPeak = Math.max(beforeTrimPeak, Math.abs(trimMix.getChannelData(channel)[i]))
        else trimError = Math.max(trimError, Math.abs(original.getChannelData(channel)[i] - trimMix.getChannelData(channel)[i]))
      }
    }
    return { splitError, trimError, beforeTrimPeak, originalFrames: original.length, splitFrames: splitMix.length,
      trimFrames: trimMix.length, offset: trimmed.tracks[0].clips[0].offsetSeconds, sameBuffer: map.get('source') === source }
  })
  expect(result.splitError).toBeLessThan(0.00001)
  expect(result.trimError).toBeLessThan(0.00001)
  expect(result.beforeTrimPeak).toBe(0)
  expect(result.splitFrames).toBe(result.originalFrames)
  expect(result.trimFrames).toBe(21000)
  expect(result.offset).toBe(0.125)
  expect(result.sameBuffer).toBe(true)
})

for (const outputRate of [44100, 48000]) {
  test(`44.1/48/96 kHz sources keep duration and pitch at ${outputRate} Hz output`, async ({ page }) => {
    await prepare(page)
    const result = await page.evaluate(async outputRate => {
      const { createProject, registerAudioBuffer, applyCommand, renderProject } = window.dawTest
      let project = createProject({ sampleRate: outputRate })
      const map = new Map()
      for (const sampleRate of [44100, 48000, 96000]) {
        const source = new AudioBuffer({ length: sampleRate / 4, sampleRate, numberOfChannels: 2 })
        for (let channel = 0; channel < 2; channel++) for (let i = 0; i < source.length; i++) source.getChannelData(channel)[i] = Math.sin(2 * Math.PI * 1000 * i / sampleRate) * 0.1
        const id = `source-${sampleRate}`, trackId = `track-${sampleRate}`
        project = registerAudioBuffer(project, map, source, { id, name: `${sampleRate}.wav` }).project
        project = applyCommand(project, { type: 'track.add', track: { id: trackId } })
        project = applyCommand(project, { type: 'clip.add', trackId, clip: { assetId: id } })
      }
      const { buffer } = await renderProject(project, map)
      const data = buffer.getChannelData(0)
      let maxError = 0, energy = 0
      const start = Math.ceil(outputRate * 0.02), end = Math.floor(outputRate * 0.23)
      for (let i = start; i < end; i++) {
        maxError = Math.max(maxError, Math.abs(data[i] - 0.3 * Math.sin(2 * Math.PI * 1000 * i / outputRate)))
        energy += data[i] ** 2
      }
      return { maxError, rms: Math.sqrt(energy / (end - start)), frames: buffer.length, sampleRate: buffer.sampleRate,
        sourceRates: [...map.values()].map(source => source.sampleRate) }
    }, outputRate)
    expect(result.frames).toBe(Math.ceil(outputRate / 4))
    expect(result.sampleRate).toBe(outputRate)
    expect(result.sourceRates).toEqual([44100, 48000, 96000])
    expect(result.maxError).toBeLessThan(0.002)
    expect(result.rms).toBeCloseTo(0.3 / Math.SQRT2, 3)
  })
}

test('track and clip gains, master gain, pan, mute and solo affect the actual samples', async ({ page }) => {
  await prepare(page)
  const result = await page.evaluate(async () => {
    const { createProject, registerAudioBuffer, applyCommand, renderProject } = window.dawTest
    const source = new AudioBuffer({ length: 4800, sampleRate: 48000, numberOfChannels: 1 })
    source.getChannelData(0).fill(0.1)
    const map = new Map()
    let project = registerAudioBuffer(createProject({ masterGainDb: -6 }), map, source, { id: 'source' }).project
    project = applyCommand(project, { type: 'track.add', track: { id: 'track', gainDb: -6, pan: -1 } })
    project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'source', gainDb: -6 } })
    const take = async p => {
      const { buffer } = await renderProject(p, map)
      return [buffer.getChannelData(0)[1000], buffer.getChannelData(1)[1000]]
    }
    const base = await take(project)
    const doubled = applyCommand(project, { type: 'track.duplicate', trackId: 'track', newId: 'other' })
    const sum = await take(doubled)
    const solo = applyCommand(doubled, { type: 'track.update', trackId: 'track', patch: { solo: true } })
    const soloSamples = await take(solo)
    const muted = applyCommand(solo, { type: 'track.update', trackId: 'track', patch: { mute: true } })
    const silence = await take(muted)
    const right = applyCommand(project, { type: 'track.update', trackId: 'track', patch: { pan: 1 } })
    const rightSamples = await take(right)
    return { base, sum, soloSamples, silence, rightSamples }
  })
  const expected = 0.1 * 10 ** (-18 / 20)
  expect(result.base[0]).toBeCloseTo(expected, 6)
  expect(Math.abs(result.base[1])).toBeLessThan(1e-7)
  expect(result.sum[0]).toBeCloseTo(expected * 2, 6)
  expect(result.soloSamples).toEqual(result.base)
  expect(result.silence).toEqual([0, 0])
  expect(Math.abs(result.rightSamples[0])).toBeLessThan(1e-7)
  expect(result.rightSamples[1]).toBeCloseTo(expected, 6)
})

test('overload is reported without normalization and memory limits reject before rendering', async ({ page }) => {
  await prepare(page)
  const result = await page.evaluate(async () => {
    const { createProject, registerAudioBuffer, applyCommand, renderProject, buildRenderPlan } = window.dawTest
    const source = new AudioBuffer({ length: 4800, sampleRate: 48000, numberOfChannels: 2 })
    source.getChannelData(0).fill(0.75); source.getChannelData(1).fill(0.75)
    const map = new Map()
    let project = registerAudioBuffer(createProject(), map, source, { id: 'source' }).project
    project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
    project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'source' } })
    project = applyCommand(project, { type: 'track.duplicate', trackId: 'track', newId: 'other' })
    const loud = await renderProject(project, map)
    const lowered = applyCommand(project, { type: 'project.update', patch: { masterGainDb: -12 } })
    const safe = await renderProject(lowered, map)
    let memoryError = ''
    let tooLong = applyCommand(project, { type: 'clip.move', trackId: 'track', clipId: 'clip', atSeconds: 599 })
    tooLong = applyCommand(tooLong, { type: 'project.update', patch: { sampleRate: 96000 } })
    try { buildRenderPlan(tooLong) } catch (error) { memoryError = error.message }
    return { loudSample: loud.buffer.getChannelData(0)[100], loudPeak: loud.peaks.samplePeakDb,
      truePeak: loud.peaks.truePeakDb, clipped: loud.clippedSamples, safeSample: safe.buffer.getChannelData(0)[100], safePeak: safe.peaks.truePeakDb, memoryError }
  })
  expect(result.loudSample).toBeCloseTo(1.5, 6)
  expect(result.loudPeak).toBeCloseTo(20 * Math.log10(1.5), 5)
  expect(result.truePeak).toBeGreaterThanOrEqual(result.loudPeak)
  expect(result.clipped).toBeGreaterThan(0)
  expect(result.safeSample).toBeCloseTo(1.5 * 10 ** (-12 / 20), 6)
  expect(result.safePeak).toBeLessThan(0)
  expect(result.memoryError).toMatch(/memory limit/)
})
