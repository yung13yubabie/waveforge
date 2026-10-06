import { describe, it, expect } from 'vitest'
import { applyCommand, createProject, validateProject } from '../../src/js/daw/project.js'
import { getClipGainRegionSegments } from '../../src/js/daw/gain-regions.js'
import { ProjectHistory } from '../../src/js/daw/history.js'

const copy = value => JSON.parse(JSON.stringify(value))
function fixture(intervals = [[0, 1], [1, 1]]) {
  const clip = (id, atSeconds, durationSeconds) => ({ id, assetId: 'source', name: id, atSeconds, offsetSeconds: 0, durationSeconds, gainDb: 0, fadeInSeconds: 0, fadeOutSeconds: 0 })
  return createProject({ assets: [{ id: 'source', name: 'isolated vocal.wav', sampleRate: 48000, channels: 1, duration: 6, length: 288000 }],
    tracks: [
      { id: 'vocal', name: 'Vocal', gainDb: 0, pan: 0, mute: false, solo: false, clips: intervals.map(([at, duration], index) => clip(`clip-${index}`, at, duration)) },
      { id: 'backing', name: 'Accompaniment', gainDb: 0, pan: 0, mute: false, solo: false, clips: [clip('backing', 0, 4)] },
    ] })
}
const region = (patch = {}) => ({ id: 'line', label: '一句', startSeconds: .25, endSeconds: 1.75, gain: 0, fadeInSeconds: .1, fadeOutSeconds: .1, ...patch })
const add = (project, input = region()) => applyCommand(project, { type: 'track.gainRegion.add', trackId: 'vocal', region: input })
function compiledAt(segments, time) {
  const part = segments.find(segment => segment.startSeconds <= time && segment.endSeconds > time)
  if (!part) return 1
  return part.startGain + (part.endGain - part.startGain) * (time - part.startSeconds) / (part.endSeconds - part.startSeconds)
}
function expectedAt(input, time) {
  if (time < input.startSeconds || time >= input.endSeconds) return 1
  const strength = Math.min(1, input.fadeInSeconds ? (time - input.startSeconds) / input.fadeInSeconds : 1,
    input.fadeOutSeconds ? (input.endSeconds - time) / input.fadeOutSeconds : 1)
  return 1 - (1 - input.gain) * strength
}
function maximumError(project, input) {
  let error = 0
  for (const clip of project.tracks[0].clips) {
    const segments = getClipGainRegionSegments(clip)
    for (let i = 0; i < 4000; i++) {
      const local = clip.durationSeconds * i / 4000
      error = Math.max(error, Math.abs(compiledAt(segments, local) - expectedAt(input, clip.atSeconds + local)))
    }
  }
  return error
}

describe('atomic timeline gain region creation across one track', () => {
  it('crops one envelope across contiguous clips without restarting fades or changing sources', () => {
    const project = fixture(), before = copy(project), input = region(), result = add(project, input)
    const [left, right] = result.tracks[0].clips
    expect(compiledAt(getClipGainRegionSegments(left), .95)).toBe(0)
    expect(compiledAt(getClipGainRegionSegments(right), .05)).toBe(0)
    expect(left.gainRegions[0]).toMatchObject({ id: 'line', startSeconds: .25, endSeconds: 1, fadeOutSeconds: 0 })
    expect(right.gainRegions[0]).toMatchObject({ id: 'line', startSeconds: 0, endSeconds: .75, fadeInSeconds: 0 })
    expect(maximumError(result, input)).toBeLessThan(1e-12)
    expect(result.revision).toBe(project.revision + 1)
    expect(result.assets).toEqual(project.assets); expect(result.tracks[1]).toEqual(project.tracks[1]); expect(project).toEqual(before)
    for (let index = 0; index < 2; index++) {
      const { gainRegions: _regions, ...clip } = result.tracks[0].clips[index]
      expect(clip).toEqual(project.tracks[0].clips[index])
    }
    const history = new ProjectHistory(project)
    history.push(result); expect(history.undo()).toEqual(project); expect(history.redo()).toEqual(result)
  })
  it('retains the partially consumed entrance ramp after a gap', () => {
    const input = region({ startSeconds: .5, endSeconds: 3.5, gain: .2, fadeInSeconds: 1.5, fadeOutSeconds: .4 })
    const result = add(fixture([[0, 1], [1.75, 2.25]]), input), resumed = result.tracks[0].clips[1]
    expect(resumed.gainRegions[0].attenuationEnvelope[0].value).toBeCloseTo(1.25 / 1.5, 12)
    expect(compiledAt(getClipGainRegionSegments(resumed), 0)).toBeCloseTo(1 - .8 * 1.25 / 1.5, 12)
    expect(maximumError(result, input)).toBeLessThan(1e-12)
  })
  it('crops both overlapping clips to the same timeline envelope', () => {
    const input = region({ startSeconds: .25, endSeconds: 2.75, gain: .25, fadeInSeconds: .5, fadeOutSeconds: .5 })
    const result = add(fixture([[0, 2], [1, 2]]), input)
    expect(result.tracks[0].clips.map(clip => clip.gainRegions.length)).toEqual([1, 1])
    expect(maximumError(result, input)).toBeLessThan(1e-12)
    const [left, right] = result.tracks[0].clips
    const overlappingOutput = .125 * compiledAt(getClipGainRegionSegments(left), 1.5) + .125 * compiledAt(getClipGainRegionSegments(right), .5)
    expect(overlappingOutput).toBe(.25 * .25)
  })
  it('includes requested leading/trailing gaps in the one canonical fade clock', () => {
    const input = region({ startSeconds: 0, endSeconds: 4, gain: 0, fadeInSeconds: 1, fadeOutSeconds: 1 })
    const result = add(fixture([[.5, 3]]), input), clip = result.tracks[0].clips[0]
    expect(clip.gainRegions[0].attenuationEnvelope[0].value).toBe(.5)
    expect(clip.gainRegions[0].attenuationEnvelope.at(-1).value).toBe(.5)
    expect(maximumError(result, input)).toBeLessThan(1e-12)
  })
  it('does not create microscopic regions at touching-edge roundoff', () => {
    const input = region({ startSeconds: .3, endSeconds: 1, fadeInSeconds: .05, fadeOutSeconds: .05 })
    const result = add(fixture([[.1, .2], [.3, .7]]), input)
    expect(result.tracks[0].clips[0].gainRegions).toBeUndefined()
    expect(result.tracks[0].clips[1].gainRegions).toHaveLength(1)
    expect(result.tracks[0].clips[1].gainRegions[0]).toMatchObject({ startSeconds: 0, endSeconds: .7 })
    expect(maximumError(result, input)).toBeLessThan(1e-12)
  })
  it.each([599.3, 599.37, 599.481234567])('normalizes late timeline clip bounds without shifting fade strengths at %s', at => {
    const input = region({ startSeconds: at - .02, endSeconds: at + .37, fadeInSeconds: .2, fadeOutSeconds: .19 })
    const result = add(fixture([[at, .1], [at + .1, .123456789]]), input)
    expect(validateProject(result)).toBe(result)
    for (const clip of result.tracks[0].clips) {
      const r = clip.gainRegions[0]
      expect(r.startSeconds).toBe(0); expect(r.endSeconds).toBe(clip.durationSeconds)
      expect(r.attenuationEnvelope.at(-1).timeSeconds).toBe(r.endSeconds - r.startSeconds)
    }
    expect(maximumError(result, input)).toBeLessThan(1e-11)
  })
  it('generates one stable ID and defaults fades once for the entire requested interval', () => {
    const result = add(fixture(), { startSeconds: .99, endSeconds: 1.01, gain: .2 })
    const [left, right] = result.tracks[0].clips.map(clip => clip.gainRegions[0])
    expect(left.id).toMatch(/^region-/); expect(right.id).toBe(left.id)
    expect(left.fadeInSeconds).toBeCloseTo(.01, 12); expect(right.fadeInSeconds).toBe(0)
    expect(right.fadeOutSeconds).toBeCloseTo(.01, 12); expect(left.fadeOutSeconds).toBe(0)
  })
  it('rejects a later clip limit atomically and preserves the history redo branch', () => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.gainRegion.addMany', trackId: 'vocal', clipId: 'clip-1', regions:
      Array.from({ length: 64 }, (_, i) => ({ id: `existing-${i}`, startSeconds: 0, endSeconds: 1, gain: .5 })) })
    const before = copy(project), history = new ProjectHistory(project)
    history.push(applyCommand(project, { type: 'project.update', patch: { name: 'redo me' } })); history.undo()
    expect(() => history.push(add(project))).toThrow(/64/)
    expect(project).toEqual(before); expect(project.tracks[0].clips[0].gainRegions).toBeUndefined(); expect(history.canRedo).toBe(true)
  })
  it('rejects later duplicate IDs and total project limits without partial insertion', () => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.gainRegion.add', trackId: 'vocal', clipId: 'clip-1', region: { id: 'line', startSeconds: 0, endSeconds: 1, gain: .5 } })
    const before = copy(project)
    expect(() => add(project)).toThrow(/duplicate/); expect(project).toEqual(before)
    const maximum = fixture(Array.from({ length: 16 }, () => [0, 1]))
    for (const clip of maximum.tracks[0].clips) clip.gainRegions = Array.from({ length: 64 }, (_, i) => ({ id: `r-${i}`, startSeconds: 0, endSeconds: 1, gain: .5, fadeInSeconds: .01, fadeOutSeconds: .01 }))
    maximum.tracks[0].clips.push({ ...copy(maximum.tracks[1].clips[0]), id: 'new-clip', atSeconds: 2, durationSeconds: 1 })
    expect(validateProject(maximum)).toBe(maximum)
    const snapshot = copy(maximum)
    expect(() => add(maximum, region({ startSeconds: 2.1, endSeconds: 2.9 }))).toThrow(/1024/)
    expect(maximum).toEqual(snapshot)
  })
  it.each([
    region({ startSeconds: 1, endSeconds: 1 }), region({ startSeconds: 2, endSeconds: 3 }),
    region({ startSeconds: -1 }), region({ endSeconds: 601 }), region({ gain: NaN }),
    region({ fadeInSeconds: 1, fadeOutSeconds: 1 }), region({ attenuationEnvelope: [] }),
  ])('rejects invalid or all-gap requests transactionally: %j', input => {
    const project = fixture(), before = copy(project)
    expect(() => add(project, input)).toThrow(); expect(project).toEqual(before)
  })
  it('rejects an empty track', () => {
    expect(() => add(fixture([]))).toThrow(/does not intersect/)
  })
})
