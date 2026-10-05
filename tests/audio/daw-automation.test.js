import { describe, it, expect } from 'vitest'
import { createProject, applyCommand, validateProject, getClipEnvelope, getClipVolumeAutomation, envelopeValueAt, DAW_LIMITS } from '../../src/js/daw/project.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'

const clipOf = project => project.tracks[0].clips[0]
const command = (project, type, extra = {}) => applyCommand(project, { type: `clip.automation.${type}`, trackId: 'track', clipId: 'clip', ...extra })
function fixture() {
  return createProject({ assets: [{ id: 'source', name: 'synthetic.wav', duration: 8, sampleRate: 48000, channels: 2 }],
    tracks: [{ id: 'track', name: 'Voice', gainDb: 0, pan: 0, mute: false, solo: false, clips: [
      { id: 'clip', assetId: 'source', name: 'Phrase', atSeconds: 10, offsetSeconds: 0, durationSeconds: 8, gainDb: -3, fadeInSeconds: 2, fadeOutSeconds: 2 },
    ] }] })
}
function automated() {
  let project = command(fixture(), 'add', { point: { timeSeconds: 1, value: .25 } })
  project = command(project, 'add', { point: { timeSeconds: 5, value: 2 } })
  return command(project, 'update', { index: 3, patch: { value: 0 } })
}
const amplitude = (clip, time) => envelopeValueAt(getClipEnvelope(clip), time) * envelopeValueAt(getClipVolumeAutomation(clip), time)

describe('bounded non-destructive clip volume automation', () => {
  it('reads old projects exactly, adding no implicit metadata and rendering unity automation', () => {
    const project = fixture(), before = JSON.stringify(project)
    expect(validateProject(project)).toBe(project)
    expect(getClipVolumeAutomation(clipOf(project))).toEqual([{ timeSeconds: 0, value: 1 }, { timeSeconds: 8, value: 1 }])
    expect(buildRenderPlan(project).tracks[0].clips[0].automation).toEqual(getClipVolumeAutomation(clipOf(project)))
    expect(JSON.stringify(project)).toBe(before)
    expect(clipOf(project)).not.toHaveProperty('volumeAutomation')
  })
  it('adds, edits, deletes and resets points independently of gain and fades', () => {
    const start = fixture(), original = JSON.stringify(start)
    let project = command(start, 'add', { point: { timeSeconds: 4, value: .5 } })
    expect(clipOf(project).volumeAutomation).toEqual([{ timeSeconds: 0, value: 1 }, { timeSeconds: 4, value: .5 }, { timeSeconds: 8, value: 1 }])
    project = command(project, 'update', { index: 1, patch: { timeSeconds: 3, value: 2 } })
    project = command(project, 'update', { index: 0, patch: { value: 0 } })
    expect(clipOf(project).volumeAutomation[1]).toEqual({ timeSeconds: 3, value: 2 })
    project = command(project, 'remove', { index: 1 })
    expect(clipOf(project).volumeAutomation).toEqual([{ timeSeconds: 0, value: 0 }, { timeSeconds: 8, value: 1 }])
    project = command(project, 'reset')
    expect(clipOf(project)).toEqual(clipOf(start))
    expect(JSON.stringify(start)).toBe(original)
  })
  it('supports editing unity endpoints before adding an interior point', () => {
    const project = command(fixture(), 'update', { index: 1, patch: { value: .25 } })
    expect(envelopeValueAt(getClipVolumeAutomation(clipOf(project)), 4)).toBe(.625)
  })
  it.each([.125, .5, 1, 1.5, 4, 5, 6.5, 7.875])('preserves both multiplied ramps exactly when split at local %s seconds', cut => {
    const project = automated(), clip = clipOf(project)
    const split = applyCommand(project, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: 10 + cut, newId: 'right' })
    const [left, right] = split.tracks[0].clips
    expect(left.volumeAutomation.at(-1).value).toBeCloseTo(right.volumeAutomation[0].value, 12)
    for (let local = 0; local <= 8; local += 1 / 64) {
      const sliced = local < cut ? left : right, time = local < cut ? local : local - cut
      expect(amplitude(sliced, time)).toBeCloseTo(amplitude(clip, local), 11)
    }
  })
  it('trims an automation ramp with interpolated boundary values, then preserves it when fades change', () => {
    const project = automated(), originalClip = clipOf(project)
    let trimmed = applyCommand(project, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 10.5, endSeconds: 16.5 })
    const points = clipOf(trimmed).volumeAutomation
    expect(points[0]).toEqual({ timeSeconds: 0, value: .625 })
    expect(points.at(-1)).toEqual({ timeSeconds: 6, value: 1 })
    for (let local = 0; local <= 6; local += .03125) expect(amplitude(clipOf(trimmed), local)).toBeCloseTo(amplitude(originalClip, local + .5), 11)
    trimmed = applyCommand(trimmed, { type: 'clip.update', trackId: 'track', clipId: 'clip', patch: { fadeInSeconds: 1, fadeOutSeconds: 1 } })
    expect(clipOf(trimmed).volumeAutomation).toEqual(points)
    expect(clipOf(trimmed).gainEnvelope).toBeUndefined()
    const reset = command(trimmed, 'reset')
    expect(getClipEnvelope(clipOf(reset))).toEqual(getClipEnvelope(clipOf(trimmed)))
  })
  it('moves and duplicates local automation without sharing mutable objects', () => {
    let project = automated(), points = clipOf(project).volumeAutomation
    project = applyCommand(project, { type: 'track.add', track: { id: 'other' } })
    project = applyCommand(project, { type: 'clip.duplicate', trackId: 'track', clipId: 'clip', toTrackId: 'other', newId: 'copy' })
    project = applyCommand(project, { type: 'clip.move', trackId: 'track', clipId: 'clip', atSeconds: 20, toTrackId: 'other' })
    expect(project.tracks[0].clips).toEqual([])
    expect(project.tracks[1].clips.map(clip => clip.volumeAutomation)).toEqual([points, points])
    expect(project.tracks[1].clips[0].volumeAutomation).not.toBe(project.tracks[1].clips[1].volumeAutomation)
  })
  it('undoes and redoes add/edit/delete/reset as independent history entries', () => {
    let project = fixture()
    const history = new ProjectHistory(project), states = [project]
    for (const [type, extra] of [['add', { point: { timeSeconds: 4, value: .5 } }], ['update', { index: 1, patch: { value: 2 } }], ['remove', { index: 1 }], ['reset', {}]]) {
      project = command(project, type, extra); states.push(project); history.push(project)
    }
    for (let index = states.length - 2; index >= 0; index--) expect(history.undo()).toEqual(states[index])
    for (let index = 1; index < states.length; index++) expect(history.redo()).toEqual(states[index])
  })
  it('allows exactly 32 points and preserves the bounded curve on split/trim', () => {
    let project = fixture()
    for (let index = 1; index <= 30; index++) project = command(project, 'add', { point: { timeSeconds: index / 4, value: index / 30 } })
    expect(clipOf(project).volumeAutomation).toHaveLength(DAW_LIMITS.maxAutomationPoints)
    expect(() => command(project, 'add', { point: { timeSeconds: 7.75, value: 1 } })).toThrow(/32/)
    for (const edit of [{ type: 'clip.trim', startSeconds: 10.125, endSeconds: 17.875 }, { type: 'clip.split', atSeconds: 14 }]) {
      const edited = applyCommand(project, { trackId: 'track', clipId: 'clip', ...edit })
      expect(edited.tracks[0].clips.every(clip => clip.volumeAutomation.length <= 32)).toBe(true)
    }
  })
  it.each([
    ['add', { point: { timeSeconds: 4, value: NaN } }],
    ['add', { point: { timeSeconds: Infinity, value: 1 } }],
    ['add', { point: { timeSeconds: 0, value: 1 } }],
    ['add', { point: { timeSeconds: 8, value: 1 } }],
    ['add', { point: { timeSeconds: 4, value: 2.0001 } }],
    ['add', { point: { timeSeconds: 4, value: -.01 } }],
    ['update', { index: 0, patch: { timeSeconds: .1 } }],
    ['update', { index: 1, patch: { timeSeconds: 4 } }],
    ['update', { index: 2, patch: { value: 1 } }],
    ['update', { index: 0, patch: { value: null } }],
    ['remove', { index: 0 }], ['remove', { index: 1 }],
  ])('rejects invalid %s commands atomically', (type, extra) => {
    const project = fixture(), original = JSON.stringify(project)
    expect(() => command(project, type, extra)).toThrow()
    expect(JSON.stringify(project)).toBe(original)
  })
  it.each([
    [], [{ timeSeconds: 0, value: 1 }],
    [{ timeSeconds: 0, value: 1 }, { timeSeconds: 8, value: NaN }],
    [{ timeSeconds: 0, value: 1 }, { timeSeconds: 8, value: 3 }],
    [{ timeSeconds: 0, value: 1 }, { timeSeconds: 4, value: 1 }],
    [{ timeSeconds: 0, value: 1 }, { timeSeconds: 0, value: 1 }, { timeSeconds: 8, value: 1 }],
    [{ timeSeconds: 0, value: 1, curve: 'unknown' }, { timeSeconds: 8, value: 1 }],
  ].map(points => ({ points })))('rejects malformed portable automation $points', ({ points }) => {
    const project = fixture(); clipOf(project).volumeAutomation = points
    expect(() => validateProject(project)).toThrow()
  })
})
