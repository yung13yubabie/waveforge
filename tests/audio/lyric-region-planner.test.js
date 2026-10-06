import { describe, expect, it } from 'vitest'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { planLyricRegion } from '../../src/js/daw/lyric-region-planner.js'

const clip = (id, atSeconds, durationSeconds, offsetSeconds = 0) => ({
  id, assetId: 'vocal-source', name: id, atSeconds, durationSeconds, offsetSeconds,
  gainDb: -3, fadeInSeconds: 0, fadeOutSeconds: 0,
})
function projectWith(clips = [clip('first', 10, 4, 6), clip('second', 14, 4, 1)]) {
  return createProject({ id: 'project', assets: [
    { id: 'vocal-source', name: 'independently-imported-vocal.wav', hash: 'b'.repeat(64), duration: 30, sampleRate: 48000, channels: 1 },
  ], tracks: [
    { id: 'vocal', name: 'Designated vocal', gainDb: 0, pan: 0, mute: false, solo: false, clips },
    { id: 'accompaniment', name: 'Accompaniment', gainDb: 0, pan: 0, mute: false, solo: false, clips: [clip('music', 0, 30)] },
  ] })
}
const selection = () => ({ version: 1, token: 'selected-1', ready: true, blocker: '', precision: 'sentence', sessionRevision: 3,
  source: { name: 'lyric-master.wav', hash: 'a'.repeat(64), duration: 20 },
  line: { id: 'line-2', text: 'A timed sentence', sung: true, start: 2, end: 6, confirmed: false, timingOrigin: 'automatic' },
})
const options = (extra = {}) => ({ trackId: 'vocal', timelineOffsetSeconds: 10, ...extra })

describe('explicit sentence-clock to designated-track region planning', () => {
  it('maps every intersecting clip with its own local range, ignoring file hashes and source offsets', () => {
    const project = projectWith(), selected = selection(), before = JSON.stringify({ project, selected })
    const result = planLyricRegion(project, selected, options())
    expect(result).toEqual({ version: 1, projectId: 'project', projectRevision: 0, selectionToken: 'selected-1',
      trackId: 'vocal', lineId: 'line-2', sourceHash: 'a'.repeat(64),
      sourceRange: { startSeconds: 2, endSeconds: 6 }, timelineOffsetSeconds: 10,
      timelineRange: { startSeconds: 12, endSeconds: 16 },
      intersections: [{ clipId: 'first', startSeconds: 2, endSeconds: 4 }, { clipId: 'second', startSeconds: 0, endSeconds: 2 }],
      gaps: [], coveredDurationSeconds: 4, completeCoverage: true })
    expect(JSON.stringify({ project, selected })).toBe(before)
    result.intersections[0].startSeconds = 0
    result.sourceRange.startSeconds = 0
    expect(JSON.stringify({ project, selected })).toBe(before)
  })

  it('uses an explicitly supplied zero offset and manual source-clock boundaries without rewriting lyric timing', () => {
    const project = projectWith([clip('voice', 0, 10)]), selected = selection()
    // Subtitle export offset is deliberately ignored even if passed by a caller.
    selected.displayOffsetMs = 9000
    const result = planLyricRegion(project, selected, options({ timelineOffsetSeconds: 0, startSeconds: 3.25, endSeconds: 4.125 }))
    expect(result.timelineRange).toEqual({ startSeconds: 3.25, endSeconds: 4.125 })
    expect(result.intersections).toEqual([{ clipId: 'voice', startSeconds: 3.25, endSeconds: 4.125 }])
    expect(selected.line).toMatchObject({ start: 2, end: 6, text: 'A timed sentence' })
  })

  it('supports an explicit negative offset when the entire mapped range is inside the timeline', () => {
    const result = planLyricRegion(projectWith([clip('voice', 0, 10)]), selection(), options({ timelineOffsetSeconds: -2 }))
    expect(result.timelineRange).toEqual({ startSeconds: 0, endSeconds: 4 })
  })

  it('reports leading, internal and trailing gaps while counting overlapping clips only once', () => {
    const project = projectWith([clip('late', 15, .5), clip('overlap', 13.5, .5), clip('early', 13, .75)])
    const result = planLyricRegion(project, selection(), options())
    expect(result.intersections.map(item => item.clipId)).toEqual(['late', 'overlap', 'early'])
    expect(result.gaps).toEqual([
      { startSeconds: 12, endSeconds: 13 }, { startSeconds: 14, endSeconds: 15 }, { startSeconds: 15.5, endSeconds: 16 },
    ])
    expect(result.coveredDurationSeconds).toBe(1.5)
    expect(result.completeCoverage).toBe(false)
  })

  it('maps touching split clips without phantom boundary intersections', () => {
    const selected = selection(); selected.line.start = .3; selected.line.end = .5
    const project = projectWith([clip('before', .1, .2), clip('inside', .3, .2), clip('after', .5, .2)])
    const result = planLyricRegion(project, selected, options({ timelineOffsetSeconds: 0 }))
    expect(result.intersections).toEqual([{ clipId: 'inside', startSeconds: 0, endSeconds: .2 }])
    expect(result.gaps).toEqual([])
  })

  it('preserves coverage after the target clip is trimmed and split, independently of tempo/grid', () => {
    let project = projectWith([clip('voice', 10, 10, 5)])
    project = applyCommand(project, { type: 'clip.trim', trackId: 'vocal', clipId: 'voice', startSeconds: 11, endSeconds: 19 })
    project = applyCommand(project, { type: 'clip.split', trackId: 'vocal', clipId: 'voice', atSeconds: 14.5, newId: 'right' })
    project = applyCommand(project, { type: 'project.update', patch: { tempo: 233 } })
    const result = planLyricRegion(project, selection(), options())
    expect(result.projectRevision).toBe(3)
    expect(result.intersections).toEqual([{ clipId: 'voice', startSeconds: 1, endSeconds: 3.5 }, { clipId: 'right', startSeconds: 0, endSeconds: 1.5 }])
    expect(result.coveredDurationSeconds).toBe(4)
  })

  it.each([undefined, null, NaN, Infinity, '0'])('does not infer a missing or invalid offset (%s)', timelineOffsetSeconds => {
    expect(() => planLyricRegion(projectWith(), selection(), options({ timelineOffsetSeconds }))).toThrow(/偏移/)
  })

  it.each([
    { startSeconds: null }, { endSeconds: null }, { startSeconds: -1 }, { endSeconds: 21 },
    { startSeconds: 6 }, { endSeconds: Infinity }, { startSeconds: NaN },
  ])('rejects invalid manual source ranges without mutating the project: %j', patch => {
    const project = projectWith(), before = JSON.stringify(project)
    expect(() => planLyricRegion(project, selection(), options(patch))).toThrow(/原音檔/)
    expect(JSON.stringify(project)).toBe(before)
  })

  it.each([-3, 595, Number.MAX_VALUE])('does not clamp an out-of-timeline mapping (%s)', timelineOffsetSeconds => {
    expect(() => planLyricRegion(projectWith(), selection(), options({ timelineOffsetSeconds }))).toThrow(/時間軸/)
  })

  it.each([
    selected => { selected.ready = false; selected.blocker = '來源尚未核對' },
    selected => { selected.line.start = null }, selected => { selected.line.end = null },
    selected => { selected.line.sung = false }, selected => { selected.source.hash = '' },
    selected => { selected.precision = 'word' }, selected => { selected.token = '' },
  ])('rejects stale/unverified or incomplete selection metadata', change => {
    const selected = selection(); change(selected)
    expect(() => planLyricRegion(projectWith(), selected, options())).toThrow()
  })

  it('requires a designated existing track and rejects empty or gap-only mappings', () => {
    expect(() => planLyricRegion(projectWith(), selection(), { timelineOffsetSeconds: 10 })).toThrow(/人聲軌/)
    expect(() => planLyricRegion(projectWith(), selection(), options({ trackId: 'missing' }))).toThrow(/人聲軌/)
    expect(() => planLyricRegion(projectWith([]), selection(), options())).toThrow(/交集/)
    expect(() => planLyricRegion(projectWith([clip('outside', 20, 2)]), selection(), options())).toThrow(/交集/)
  })
})
