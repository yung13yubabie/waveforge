import { describe, it, expect } from 'vitest'
import { createProject, applyCommand, validateProject, DAW_LIMITS, envelopeValueAt, getClipEnvelope, getClipVolumeAutomation } from '../../src/js/daw/project.js'
import { getClipGainRegionSegments, getGainRegionEnvelope } from '../../src/js/daw/gain-regions.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { ProjectHistory } from '../../src/js/daw/history.js'

const copy = value => JSON.parse(JSON.stringify(value))
const clipOf = project => project.tracks[0].clips[0]
const command = (project, type, fields = {}) => applyCommand(project, { type: `clip.gainRegion.${type}`, trackId: 'vocal', clipId: 'clip', ...fields })
const region = (id, startSeconds, endSeconds, gain = 0, fades = .125) => ({ id, label: '指定人聲', startSeconds, endSeconds, gain, fadeInSeconds: fades, fadeOutSeconds: fades })
function fixture() {
  return createProject({ assets: [{ id: 'source', name: 'isolated vocal.wav', sampleRate: 48000, channels: 1, duration: 6, length: 288000 }],
    tracks: [{ id: 'vocal', name: 'Vocal', gainDb: 0, pan: 0, mute: false, solo: false, clips: [
      { id: 'clip', assetId: 'source', name: 'Vocal take', atSeconds: 10, offsetSeconds: 1, durationSeconds: 4, gainDb: -3, fadeInSeconds: .5, fadeOutSeconds: .5 },
    ] }, { id: 'backing', name: 'Accompaniment', gainDb: 0, pan: 0, mute: false, solo: false, clips: [] }] })
}
function compiledAt(segments, seconds) {
  const segment = segments.find(part => seconds >= part.startSeconds && seconds < part.endSeconds) ?? segments.at(-1)
  return segment.startGain + (segment.endGain - segment.startGain) * (seconds - segment.startSeconds) / (segment.endSeconds - segment.startSeconds)
}
function oracleAt(regions, seconds) {
  return Math.min(1, ...regions.map(r => {
    if (seconds < r.startSeconds || seconds >= r.endSeconds) return 1
    const local = seconds - r.startSeconds, remaining = r.endSeconds - seconds
    const strength = Math.min(1, r.fadeInSeconds ? local / r.fadeInSeconds : 1, r.fadeOutSeconds ? remaining / r.fadeOutSeconds : 1)
    return 1 - (1 - r.gain) * strength
  }))
}
function multiplier(clip, local) {
  return compiledAt(getClipGainRegionSegments(clip), local) * envelopeValueAt(getClipEnvelope(clip), local) * envelopeValueAt(getClipVolumeAutomation(clip), local)
}

describe('reversible bounded clip-local gain regions', () => {
  it('leaves legacy projects, original sources, other clips and accompaniment unchanged', () => {
    let original = fixture()
    original = applyCommand(original, { type: 'clip.duplicate', trackId: 'vocal', clipId: 'clip', toTrackId: 'backing', newId: 'backing-clip', atSeconds: 10 })
    const before = copy(original)
    const result = command(original, 'add', { region: { startSeconds: .25, endSeconds: .75, gain: 0 } })
    expect(result.assets).toEqual(before.assets)
    expect(result.tracks[1]).toEqual(before.tracks[1])
    expect(original).toEqual(before)
    expect(clipOf(result).gainRegions[0]).toMatchObject({ gain: 0, fadeInSeconds: .01, fadeOutSeconds: .01 })
    expect(clipOf(result).gainRegions[0].id).toMatch(/^region-/)
    expect(getClipGainRegionSegments(clipOf(original))).toEqual([{ startSeconds: 0, endSeconds: 4, startGain: 1, endGain: 1 }])
    expect(command(result, 'reset').tracks).toEqual(original.tracks)
  })
  it('adds one atomic batch, edits and removes stable IDs, and restores every change with undo/redo', () => {
    const original = fixture(), history = new ProjectHistory(original)
    const added = command(original, 'addMany', { regions: [region('a', .25, .75), region('b', 1, 2, .5)] })
    history.push(added)
    expect(added.revision).toBe(original.revision + 1)
    expect(history.undo()).toEqual(original)
    expect(history.redo()).toEqual(added)
    const edited = command(added, 'update', { regionId: 'b', patch: { label: '第二句', gain: .25 } })
    history.push(edited)
    expect(clipOf(edited).gainRegions[1]).toMatchObject({ id: 'b', gain: .25, label: '第二句' })
    const removed = command(edited, 'remove', { regionId: 'a' })
    history.push(removed)
    expect(clipOf(removed).gainRegions.map(r => r.id)).toEqual(['b'])
    expect(history.undo()).toEqual(edited)
    expect(history.redo()).toEqual(removed)
    expect(clipOf(command(removed, 'remove', { regionId: 'b' })).gainRegions).toBeUndefined()
  })
  it('moves, duplicates and replaces sources with clip-local regions independently editable', () => {
    const original = command(fixture(), 'add', { region: region('a', .25, .75) })
    const moved = applyCommand(original, { type: 'clip.move', trackId: 'vocal', clipId: 'clip', atSeconds: 20 })
    expect(clipOf(moved).gainRegions).toEqual(clipOf(original).gainRegions)
    const duplicated = applyCommand(moved, { type: 'clip.duplicate', trackId: 'vocal', clipId: 'clip', newId: 'copy' })
    expect(duplicated.tracks[0].clips[1].gainRegions).toEqual(clipOf(original).gainRegions)
    const edited = command(duplicated, 'update', { regionId: 'a', patch: { gain: .5 } })
    expect(edited.tracks[0].clips[1].gainRegions[0].gain).toBe(0)
    const trackCopy = applyCommand(original, { type: 'track.duplicate', trackId: 'vocal', newId: 'copy-track' })
    expect(trackCopy.tracks[2].clips[0].gainRegions).toEqual(clipOf(original).gainRegions)
    const replaced = applyCommand(original, { type: 'clip.replaceSource', trackId: 'vocal', clipId: 'clip', assetId: 'source', offsetSeconds: 0 })
    expect(clipOf(replaced).gainRegions).toEqual(clipOf(original).gainRegions)
  })
  it('preserves cropped fade strengths through gain=1 edits, and rebuilds only on explicit geometry edits', () => {
    let project = command(fixture(), 'add', { region: region('a', .25, 2.25, .2, .5) })
    project = applyCommand(project, { type: 'clip.trim', trackId: 'vocal', clipId: 'clip', startSeconds: 10.5, endSeconds: 12 })
    const cropped = clipOf(project).gainRegions[0], shape = copy(cropped.attenuationEnvelope)
    expect(getGainRegionEnvelope(cropped)[0].value).toBeCloseTo(.6)
    expect(getGainRegionEnvelope(cropped).at(-1).value).toBeCloseTo(.6)
    project = command(project, 'update', { regionId: 'a', patch: { gain: 1, label: 'kept shape' } })
    expect(getGainRegionEnvelope(clipOf(project).gainRegions[0]).every(point => point.value === 1)).toBe(true)
    project = command(project, 'update', { regionId: 'a', patch: { gain: 0 } })
    expect(clipOf(project).gainRegions[0].attenuationEnvelope).toEqual(shape)
    expect(getGainRegionEnvelope(clipOf(project).gainRegions[0])[0].value).toBe(.5)
    project = command(project, 'update', { regionId: 'a', patch: { fadeInSeconds: .1 } })
    expect(clipOf(project).gainRegions[0].attenuationEnvelope).toBeUndefined()
  })
  it('preserves region data through clip fade and automation changes, reset does not touch those curves', () => {
    let project = command(fixture(), 'add', { region: region('a', .25, 1.75) })
    project = applyCommand(project, { type: 'clip.automation.add', trackId: 'vocal', clipId: 'clip', point: { timeSeconds: 1.25, value: .6 } })
    const regions = copy(clipOf(project).gainRegions)
    project = applyCommand(project, { type: 'clip.update', trackId: 'vocal', clipId: 'clip', patch: { fadeInSeconds: .25 } })
    expect(clipOf(project).gainRegions).toEqual(regions)
    const before = copy(clipOf(project)), reset = command(project, 'reset')
    delete before.gainRegions
    expect(clipOf(reset)).toEqual(before)
  })
})

describe('piecewise linear lower-envelope sample geometry', () => {
  it.each([44100, 48000, 96000])('matches independent expected gains at every synthetic %i Hz sample, including crossing ramps', rate => {
    const regions = [region('a', .25, 2.25, 0, .5), region('b', 1.75, 3.75, .2, .75), region('same-as-a', .25, 2.25, 0, .5)]
    const project = command(fixture(), 'addMany', { regions }), clip = clipOf(project)
    const segments = getClipGainRegionSegments(clip)
    let maxError = 0
    for (let frame = 0; frame < 4 * rate; frame++) {
      const t = frame / rate
      // .125 DC input makes this an exact synthetic PCM amplitude comparison.
      maxError = Math.max(maxError, Math.abs(.125 * compiledAt(segments, t) - .125 * oracleAt(regions, t)))
    }
    expect(maxError).toBeLessThan(1e-14)
    expect(segments.some(segment => segment.startSeconds > 1.75 && segment.startSeconds < 2.25)).toBe(true)
    expect(buildRenderPlan(project).tracks[0].clips[0].gainRegions).toEqual(segments)
    const reversed = { ...clip, gainRegions: [...clip.gainRegions].reverse() }
    for (let t = 0; t < 4; t += .0037) expect(compiledAt(getClipGainRegionSegments(reversed), t)).toBeCloseTo(compiledAt(segments, t), 12)
  })
  it('preserves true steps, touching boundaries, very short regions and unvoiced gaps', () => {
    const regions = [region('first', .5, 1, .2, 0), region('adjacent', 1, 1.5, .4, 0), region('after-gap', 1.75, 2, 0, 0), region('short', 3, 3 + 1 / 96000, 0, 0)]
    const segments = getClipGainRegionSegments(clipOf(command(fixture(), 'addMany', { regions })))
    for (const [t, expected] of [[.499, 1], [.5, .2], [.999, .2], [1, .4], [1.5, 1], [1.749, 1], [1.75, 0], [2, 1], [3, 0], [3 + 1 / 96000, 1]]) expect(compiledAt(segments, t)).toBeCloseTo(expected, 12)
  })
  it('never compounds duplicate/overlapping regions and never amplifies', () => {
    const regions = Array.from({ length: DAW_LIMITS.maxGainRegionsPerClip }, (_, i) => region(`r-${i}`, .5, 2.5, .4, .5))
    const clip = clipOf(command(fixture(), 'addMany', { regions })), segments = getClipGainRegionSegments(clip)
    expect(compiledAt(segments, 1.5)).toBeCloseTo(.4)
    expect(segments.length).toBeLessThanOrEqual(5)
    for (const segment of segments) for (const gain of [segment.startGain, segment.endGain]) { expect(gain).toBeGreaterThanOrEqual(0); expect(gain).toBeLessThanOrEqual(1) }
  })
  it.each([10.375, 10.75, 11.9375, 12.875, 13.875])('retains the product of region, volume and clip fades through split at %s', atSeconds => {
    let project = command(fixture(), 'addMany', { regions: [region('a', .25, 2.25, .2, .5), region('b', 1.75, 3.75, 0, .75)] })
    project = applyCommand(project, { type: 'clip.automation.add', trackId: 'vocal', clipId: 'clip', point: { timeSeconds: 1.5, value: 1.8 } })
    const result = applyCommand(project, { type: 'clip.split', trackId: 'vocal', clipId: 'clip', atSeconds, newId: 'right' })
    const cut = atSeconds - 10, [left, right] = result.tracks[0].clips
    for (let frame = 0; frame < 4 * 8000; frame++) {
      const t = frame / 8000, clip = t < cut ? left : right, local = t < cut ? t : t - cut
      expect(multiplier(clip, local)).toBeCloseTo(multiplier(clipOf(project), t), 11)
    }
    expect(validateProject(result)).toBe(result)
    for (const clip of [left, right]) for (const r of clip.gainRegions) expect(r.attenuationEnvelope?.length ?? 0).toBeLessThanOrEqual(4)
  })
  it('retains exact attenuation on repeated fractional trims and discards only out-of-range regions', () => {
    const original = command(fixture(), 'addMany', { regions: [region('a', .1, .8, .2, .3), region('b', 1.75, 3.8, 0, .75)] })
    let project = original
    for (const [startSeconds, endSeconds] of [[10.13, 13.7], [10.17, 13.5], [10.21, 13.4]]) project = applyCommand(project, { type: 'clip.trim', trackId: 'vocal', clipId: 'clip', startSeconds, endSeconds })
    const clip = clipOf(project)
    for (let t = 0; t < clip.durationSeconds; t += .0013) expect(multiplier(clip, t)).toBeCloseTo(multiplier(clipOf(original), t + .21), 10)
    const gap = applyCommand(original, { type: 'clip.trim', trackId: 'vocal', clipId: 'clip', startSeconds: 10.9, endSeconds: 11.5 })
    expect(clipOf(gap).gainRegions).toEqual([])
  })
  it('keeps fractional late-timeline split/trim geometry and randomized overlaps within numerical roundoff', () => {
    let seed = 732193
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let iteration = 0; iteration < 80; iteration++) {
      const regions = Array.from({ length: 12 }, (_, index) => {
        const start = random() * 3.8, end = start + .001 + random() * (3.999 - start)
        const duration = end - start, fadeInSeconds = duration * random(), fadeOutSeconds = (duration - fadeInSeconds) * random()
        return { ...region(`r-${index}`, start, end, random()), fadeInSeconds, fadeOutSeconds }
      })
      const project = applyCommand(command(fixture(), 'addMany', { regions }), { type: 'clip.move', trackId: 'vocal', clipId: 'clip', atSeconds: 500.3 })
      const startSeconds = 500.3 + random(), endSeconds = 503.3 + random()
      const trimmed = applyCommand(project, { type: 'clip.trim', trackId: 'vocal', clipId: 'clip', startSeconds, endSeconds })
      const atSeconds = startSeconds + (endSeconds - startSeconds) * (.1 + .8 * random())
      const split = applyCommand(trimmed, { type: 'clip.split', trackId: 'vocal', clipId: 'clip', atSeconds, newId: 'right' })
      const source = getClipGainRegionSegments(clipOf(project))
      let error = 0
      for (const clip of split.tracks[0].clips) {
        const segments = getClipGainRegionSegments(clip)
        for (let index = 0; index < 200; index++) {
          const local = clip.durationSeconds * index / 200
          error = Math.max(error, Math.abs(compiledAt(segments, local) - compiledAt(source, clip.atSeconds - 500.3 + local)))
        }
      }
      expect(error).toBeLessThan(1e-9)
      for (let t = 0; t < 4; t += .017) expect(compiledAt(source, t)).toBeCloseTo(oracleAt(regions, t), 12)
    }
  })
})

describe('transactional gain region validation and bounded metadata', () => {
  it.each([
    { gain: -1 }, { gain: 1.01 }, { gain: NaN }, { gain: Infinity }, { gain: '0' },
    { startSeconds: -1 }, { startSeconds: 2 }, { endSeconds: 5 }, { endSeconds: .5 }, { endSeconds: NaN },
    { fadeInSeconds: .8, fadeOutSeconds: .8 }, { fadeOutSeconds: -1 },
    { label: 'x'.repeat(121) }, { label: 'newline\ntext' }, { id: 'bad id' }, { asr: {} },
  ])('rejects invalid additions atomically: %j', patch => {
    const project = fixture(), before = copy(project)
    expect(() => command(project, 'add', { region: { ...region('a', .5, 1.5), ...patch } })).toThrow()
    expect(project).toEqual(before)
  })
  it('rejects invalid batches, duplicate IDs and unknown edits without erasing a redo branch', () => {
    const project = command(fixture(), 'add', { region: region('a', .5, 1.5) }), before = copy(project), history = new ProjectHistory(project)
    history.push(command(project, 'remove', { regionId: 'a' })); history.undo()
    for (const [type, fields] of [
      ['addMany', { regions: [] }], ['addMany', { regions: [region('b', 2, 3), region('bad', 4, 5)] }],
      ['add', { region: region('a', 2, 3) }], ['update', { regionId: 'missing', patch: { gain: 0 } }],
      ['update', { regionId: 'a', patch: { gain: undefined } }], ['update', { regionId: 'a', patch: { id: 'changed' } }],
      ['remove', { regionId: 'missing' }],
    ]) {
      expect(() => history.push(command(project, type, fields))).toThrow()
      expect(project).toEqual(before); expect(history.canRedo).toBe(true)
    }
  })
  it('enforces per-clip and project limits while keeping the maximum envelope bounded', () => {
    const regions = Array.from({ length: 64 }, (_, i) => region(`r-${i}`, i / 32, i / 32 + .02, .2, .005))
    const project = command(fixture(), 'addMany', { regions })
    expect(getClipGainRegionSegments(clipOf(project)).length).toBeLessThanOrEqual(4 * 64 + 1)
    expect(() => command(project, 'add', { region: region('extra', 3, 4) })).toThrow(/64/)
    const maximum = copy(project)
    maximum.tracks[0].clips = Array.from({ length: 16 }, (_, i) => ({ ...copy(clipOf(project)), id: `c-${i}` }))
    expect(validateProject(maximum)).toBe(maximum)
    expect(new ProjectHistory(maximum).bytes).toBeLessThan(1024 * 1024)
    maximum.tracks[0].clips.push({ ...copy(clipOf(project)), id: 'extra' })
    expect(() => validateProject(maximum)).toThrow(/1024/)
  })
  it.each([
    r => { r.remoteUrl = 'https://example.invalid/audio' }, r => { r.attenuationEnvelope = [] },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 2 }] },
    r => { r.attenuationEnvelope = [{ timeSeconds: .1, value: 0 }, { timeSeconds: 1, value: 1 }] },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: .5, value: 1 }] },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: 0, value: 1 }, { timeSeconds: 1, value: 0 }] },
    r => { r.attenuationEnvelope = Array.from({ length: 5 }, (_, i) => ({ timeSeconds: i / 4, value: 1 })) },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0, confidence: .9 }, { timeSeconds: 1, value: 1 }] },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1 + 1e-10, value: 1 }] },
  ])('rejects malformed saved region envelopes', mutate => {
    const project = command(fixture(), 'add', { region: region('a', .5, 1.5) })
    mutate(clipOf(project).gainRegions[0])
    expect(() => validateProject(project)).toThrow()
    expect(() => new ProjectHistory(project)).toThrow()
  })
})
