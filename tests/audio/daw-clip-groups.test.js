import { describe, expect, it, vi } from 'vitest'
import { applyCommand, createProject, DAW_LIMITS, getProjectDuration, validateProject } from '../../src/js/daw/project.js'
import { describeClipGroup, getClipGroupOverlaps, planClipGroupDuplicate } from '../../src/js/daw/clip-groups.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { dawGridStepSeconds, getDawGridOrigin, snapDawGridTime } from '../../src/js/daw/grid.js'

const copy = value => JSON.parse(JSON.stringify(value))
const refs = [{ trackId: 'voice', clipId: 'a' }, { trackId: 'voice', clipId: 'b' }, { trackId: 'music', clipId: 'c' }]
const allClips = project => project.tracks.flatMap(track => track.clips)
const clipOf = (project, id) => allClips(project).find(clip => clip.id === id)
function fixture(sampleRate = 44100, outputRate = 48000) {
  const asset = { id: 'source', name: 'native.wav', hash: 'a'.repeat(64), sampleRate, sourceSampleRate: sampleRate,
    decodeBackend: 'native-rate-wav', duration: 2, length: sampleRate * 2, channels: 1 }
  let project = createProject({ assets: [asset], sampleRate: outputRate, gridOriginSeconds: 17 / sampleRate, tempo: 93.125 })
  project = applyCommand(project, { type: 'track.add', track: { id: 'voice', gainDb: -3, pan: -.25 } })
  project = applyCommand(project, { type: 'track.add', track: { id: 'music', gainDb: -8, pan: .5 } })
  for (const [trackId, id, atSeconds, durationSeconds] of [['voice', 'a', .25, .75], ['voice', 'b', 1.5, .5], ['music', 'c', 2.25, .25], ['voice', 'untouched', 5, .5]]) {
    project = applyCommand(project, { type: 'clip.add', trackId, clip: { id, assetId: 'source', atSeconds, durationSeconds,
      offsetSeconds: 11.5 / sampleRate, gainDb: -2, fadeInSeconds: .0625, fadeOutSeconds: .125,
      gainEnvelope: [{ timeSeconds: 0, value: .3 }, { timeSeconds: durationSeconds / 2, value: 1 }, { timeSeconds: durationSeconds, value: .7 }],
      volumeAutomation: [{ timeSeconds: 0, value: .8 }, { timeSeconds: durationSeconds / 2, value: .5 }, { timeSeconds: durationSeconds, value: 1.2 }],
    } })
  }
  // The same track-level ramp is cropped across the two selected voice clips.
  project = applyCommand(project, { type: 'track.gainRegion.add', trackId: 'voice', region: {
    id: 'common-ramp', label: 'one shared ramp', startSeconds: .25, endSeconds: 2, gain: .4, fadeInSeconds: .75, fadeOutSeconds: .75,
  } })
  return project
}
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) }
  return value
}

describe('atomic clip group metadata edits', () => {
  it('describes one common bounding box and independent reference values', () => {
    const project = fixture(), group = describeClipGroup(project, refs)
    expect(group).toEqual({ refs, count: 3, trackCount: 2, startSeconds: .25, endSeconds: 2.5,
      durationSeconds: 2.25, minDeltaSeconds: -.25, maxDeltaSeconds: 597.5 })
    group.refs[0].clipId = 'changed'
    expect(refs[0].clipId).toBe('a')
    expect(clipOf(project, 'a')).toBeDefined()
  })

  it.each([8000, 44100, 48000, 96000, 192000])('moves by one fractional delta and preserves every native %i Hz recipe field', rate => {
    const project = frozen(fixture(rate)), before = copy(project), deltaSeconds = 7 / rate + 2
    const next = applyCommand(project, { type: 'clips.move', refs: frozen(copy(refs)), deltaSeconds })
    expect(next.revision).toBe(project.revision + 1)
    expect(project).toEqual(before)
    expect(next.assets).toEqual(project.assets)
    expect(next.assets).not.toBe(project.assets)
    for (const { trackId, clipId } of refs) {
      const original = clipOf(project, clipId), moved = clipOf(next, clipId)
      expect(moved).toEqual({ ...original, atSeconds: original.atSeconds + deltaSeconds })
      expect(next.tracks.find(track => track.id === trackId).clips).toContain(moved)
      expect(moved.gainEnvelope).not.toBe(original.gainEnvelope)
      expect(moved.volumeAutomation).not.toBe(original.volumeAutomation)
    }
    expect(clipOf(next, 'untouched')).toEqual(clipOf(project, 'untouched'))
    const oldPlan = buildRenderPlan(project), newPlan = buildRenderPlan(next)
    for (const track of newPlan.tracks) {
      const original = oldPlan.tracks.find(item => item.id === track.id)
      expect(track).toEqual({ ...original, clips: original.clips.map(clip => ({ ...clip,
        atSeconds: refs.some(ref => ref.clipId === clip.id) ? clip.atSeconds + deltaSeconds : clip.atSeconds })) })
    }
  })

  it('deep-copies selected clips on their original tracks with globally unique IDs and shared media', () => {
    const project = frozen(fixture()), before = copy(project)
    const next = applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 7, newIds: ['copy-a', 'copy-b', 'copy-c'] })
    expect(project).toEqual(before)
    expect(next.revision).toBe(project.revision + 1)
    expect(next.assets).toEqual(project.assets)
    expect(new Set(allClips(next).map(clip => clip.id)).size).toBe(7)
    refs.forEach(({ trackId, clipId }, index) => {
      const original = clipOf(project, clipId), duplicate = clipOf(next, `copy-${clipId}`)
      expect(duplicate).toEqual({ ...original, id: `copy-${clipId}`, atSeconds: original.atSeconds + 7 })
      expect(next.tracks.find(track => track.id === trackId).clips).toContain(duplicate)
      expect(duplicate).not.toBe(clipOf(next, clipId))
      expect(duplicate.volumeAutomation).not.toBe(clipOf(next, clipId).volumeAutomation)
      if (index < 2) {
        expect(duplicate.gainRegions).not.toBe(clipOf(next, clipId).gainRegions)
        expect(duplicate.gainRegions[0].attenuationEnvelope).not.toBe(clipOf(next, clipId).gainRegions[0].attenuationEnvelope)
      }
    })
    const originalPlan = buildRenderPlan(project), copiedPlan = buildRenderPlan(next)
    for (const { trackId, clipId } of refs) {
      const original = originalPlan.tracks.find(track => track.id === trackId).clips.find(clip => clip.id === clipId)
      expect(copiedPlan.tracks.find(track => track.id === trackId).clips.find(clip => clip.id === `copy-${clipId}`))
        .toEqual({ ...original, id: `copy-${clipId}`, atSeconds: original.atSeconds + 7 })
    }
  })

  it('generates unique clip IDs while leaving original clip order stable', () => {
    const project = fixture(), next = applyCommand(project, { type: 'clips.duplicate', refs: [...refs].reverse(), deltaSeconds: 7 })
    expect(allClips(next)).toHaveLength(7)
    expect(new Set(allClips(next).map(clip => clip.id)).size).toBe(7)
    expect(next.tracks[0].clips.slice(0, 3)).toEqual(project.tracks[0].clips)
    expect(next.tracks[0].clips.slice(3).map(clip => clip.name)).toEqual([clipOf(project, 'b').name, clipOf(project, 'a').name])
  })

  it('removes selected clips only and keeps empty tracks, sources and grid metadata', () => {
    const project = frozen(fixture()), next = applyCommand(project, { type: 'clips.remove', refs })
    expect(allClips(next).map(clip => clip.id)).toEqual(['untouched'])
    expect(next.tracks).toHaveLength(2)
    expect(next.tracks[1]).toEqual({ ...project.tracks[1], clips: [] })
    expect(next.assets).toEqual(project.assets)
    expect(next.gridOriginSeconds).toBe(project.gridOriginSeconds)
    expect(next.revision).toBe(project.revision + 1)
  })

  it.each(['clips.move', 'clips.duplicate', 'clips.remove'])('%s is a single undo/redo action and retains source assets', type => {
    const project = fixture(), history = new ProjectHistory(project)
    const next = applyCommand(project, type === 'clips.remove' ? { type, refs } : { type, refs, deltaSeconds: 7 })
    history.push(next)
    expect(history.length).toBe(2)
    expect(history.undo()).toEqual(project)
    expect(history.canUndo).toBe(false)
    expect(history.redo()).toEqual(next)
    expect(history.canRedo).toBe(false)
    expect([...history.retainedAssetIds()]).toEqual(['source'])
  })

  it('clears an out-of-range timeline selection in the same atomic removal', () => {
    const project = applyCommand(fixture(), { type: 'timelineSelection.set', selection: { startSeconds: 3, endSeconds: 5.5 } })
    const next = applyCommand(project, { type: 'clips.remove', refs: [{ trackId: 'voice', clipId: 'untouched' }] })
    expect(next).not.toHaveProperty('timelineSelection')
    expect(next.revision).toBe(project.revision + 1)
    expect(project.timelineSelection.endSeconds).toBe(5.5)
  })
})

describe('same-track overlap protection', () => {
  it('reports concrete conflicts and rejects the whole edit unless this command allows overlap', () => {
    const project = fixture(), before = copy(project)
    const overlaps = getClipGroupOverlaps(project, refs, 4)
    expect(overlaps).toEqual([])
    const collisions = getClipGroupOverlaps(project, refs, 4.1)
    expect(collisions).toHaveLength(1)
    expect(collisions[0]).toMatchObject({ trackId: 'voice', clipId: 'a', otherClipId: 'untouched' })
    let error
    try { applyCommand(project, { type: 'clips.move', refs, deltaSeconds: 4.1 }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'CLIP_GROUP_OVERLAP', overlaps: collisions })
    expect(project).toEqual(before)
    const allowed = applyCommand(project, { type: 'clips.move', refs, deltaSeconds: 4.1, allowOverlap: true })
    expect(clipOf(allowed, 'a').atSeconds).toBe(.25 + 4.1)
    expect(clipOf(allowed, 'untouched')).toEqual(clipOf(project, 'untouched'))
    expect(() => applyCommand(project, { type: 'clips.move', refs, deltaSeconds: 4.1 })).toThrow(/overlap/)
  })

  it('preserves group-internal overlaps while ignoring audio on other tracks', () => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'b', atSeconds: .5 })
    const selected = refs.slice(0, 2)
    const next = applyCommand(project, { type: 'clips.move', refs: selected, deltaSeconds: 2 })
    expect(clipOf(next, 'a').atSeconds).toBe(2.25)
    expect(clipOf(next, 'b').atSeconds).toBe(2.5)
    expect(clipOf(next, 'c').atSeconds).toBe(2.25)
    const duplicate = applyCommand(project, { type: 'clips.duplicate', refs: selected, deltaSeconds: 7 })
    expect(duplicate.tracks[0].clips.slice(-2).map(clip => clip.atSeconds)).toEqual([7.25, 7.5])
  })

  it('counts selected originals as obstacles for copying and allows explicitly approved stacking', () => {
    const project = fixture()
    expect(getClipGroupOverlaps(project, refs, 0)).toEqual([])
    expect(getClipGroupOverlaps(project, refs, 0, { duplicate: true })).toHaveLength(3)
    expect(() => applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 0 })).toThrow(/overlap/)
    expect(allClips(applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 0, allowOverlap: true }))).toHaveLength(7)
  })

  it.each([44100, 48000, 96000, 192000])('permits touching endpoints but catches a one-frame overlap at %i Hz', rate => {
    let project = fixture(rate)
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'untouched', atSeconds: 500.3 })
    const selected = [refs[0]], boundary = 500.3 - .75 - .25
    expect(getClipGroupOverlaps(project, selected, boundary)).toEqual([])
    expect(() => applyCommand(project, { type: 'clips.move', refs: selected, deltaSeconds: boundary })).not.toThrow()
    expect(getClipGroupOverlaps(project, selected, boundary + 1 / rate)).toHaveLength(1)
    expect(() => applyCommand(project, { type: 'clips.move', refs: selected, deltaSeconds: boundary + 1 / rate })).toThrow(/overlap/)
  })
})

describe('bounded group placement and end-copy planning', () => {
  it('uses the exact project end without snapping, preserving offsets between tracks', () => {
    const project = fixture(), plan = planClipGroupDuplicate(project, refs)
    expect(plan.atSeconds).toBe(5.5)
    expect(plan.deltaSeconds).toBe(5.25)
    const next = applyCommand(project, { type: 'clips.duplicate', refs: plan.refs, deltaSeconds: plan.deltaSeconds, newIds: ['d', 'e', 'f'] })
    expect(clipOf(next, 'd').atSeconds).toBe(5.5)
    expect(clipOf(next, 'e').atSeconds - clipOf(next, 'd').atSeconds).toBe(1.25)
    expect(clipOf(next, 'f').atSeconds - clipOf(next, 'd').atSeconds).toBe(2)
  })

  it.each([44100, 48000, 96000])('snaps at or after the end with a shifted fractional grid at %i Hz', sampleRate => {
    for (const tempo of [20, 87.5, 119.997, 300]) for (const gridBeats of [4, 1, .25, 1 / 3]) {
      const project = applyCommand(fixture(sampleRate), { type: 'project.update', patch: { tempo } })
      const plan = planClipGroupDuplicate(project, refs, { snapEnabled: true, gridBeats })
      const end = getProjectDuration(project), origin = getDawGridOrigin(project), step = dawGridStepSeconds(tempo, gridBeats)
      expect(plan.atSeconds).toBeGreaterThanOrEqual(end)
      expect(plan.atSeconds).toBeLessThan(end + step + 1e-12)
      expect(snapDawGridTime(plan.atSeconds, tempo, gridBeats, true, origin)).toBeCloseTo(plan.atSeconds, 12)
      expect(getClipGroupOverlaps(project, refs, plan.deltaSeconds, { duplicate: true })).toEqual([])
      expect(() => applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: plan.deltaSeconds })).not.toThrow()
    }
  })

  it('keeps an already on-grid end and never snaps an off-grid end backwards', () => {
    const project = applyCommand(fixture(), { type: 'project.update', patch: { tempo: 120, gridOriginSeconds: 0 } })
    expect(planClipGroupDuplicate(project, refs, { snapEnabled: true }).atSeconds).toBe(5.5)
    const offset = applyCommand(project, { type: 'project.update', patch: { gridOriginSeconds: .2 } })
    expect(planClipGroupDuplicate(offset, refs, { snapEnabled: true }).atSeconds).toBe(5.7)
    const late = applyCommand(offset, { type: 'clip.move', trackId: 'voice', clipId: 'untouched', atSeconds: 599 })
    expect(() => planClipGroupDuplicate(late, refs, { snapEnabled: true })).toThrow(/600/)
    expect(() => planClipGroupDuplicate(late, refs)).toThrow(/600/)
  })

  it('keeps the actual copied anchor at/after the end when common-delta subtraction rounds backwards', () => {
    let project = fixture()
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'a', atSeconds: 2.12105373 })
    project = applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'untouched', atSeconds: 400.18984267 })
    const selected = [refs[0]], end = getProjectDuration(project), start = clipOf(project, 'a').atSeconds
    expect(start + (end - start)).toBeLessThan(end) // Regression fixture actually loses an ULP.
    const plan = planClipGroupDuplicate(project, selected)
    const next = applyCommand(project, { type: 'clips.duplicate', refs: selected, deltaSeconds: plan.deltaSeconds, newIds: ['copy-a'] })
    expect(clipOf(next, 'copy-a').atSeconds).toBeGreaterThanOrEqual(end)
    expect(clipOf(next, 'copy-a').atSeconds).toBe(plan.atSeconds)
    expect(plan.atSeconds - end).toBeLessThan(1e-12)
  })

  it('enforces the shared start/end bounds without independently clamping members', () => {
    const project = fixture(), group = describeClipGroup(project, refs)
    const first = applyCommand(project, { type: 'clips.move', refs, deltaSeconds: group.minDeltaSeconds })
    expect(clipOf(first, 'a').atSeconds).toBe(0)
    const last = applyCommand(project, { type: 'clips.move', refs, deltaSeconds: group.maxDeltaSeconds })
    expect(getProjectDuration(last)).toBe(600)
    for (const deltaSeconds of [group.minDeltaSeconds - 1 / 192000, group.maxDeltaSeconds + 1 / 192000]) {
      expect(() => applyCommand(project, { type: 'clips.move', refs, deltaSeconds, allowOverlap: true })).toThrow(/delta/)
    }
  })

  it('accepts 256 references for movement/removal but atomically rejects copy over the project limit', () => {
    const project = fixture(), original = clipOf(project, 'a')
    project.tracks[0].clips = Array.from({ length: DAW_LIMITS.maxClips }, (_, index) => ({ ...copy(original), id: `clip-${index}`, atSeconds: index * 2 }))
    project.tracks[1].clips = []
    validateProject(project)
    const selected = project.tracks[0].clips.map(clip => ({ trackId: 'voice', clipId: clip.id })), before = copy(project)
    expect(allClips(applyCommand(project, { type: 'clips.move', refs: selected, deltaSeconds: .125 }))).toHaveLength(256)
    expect(allClips(applyCommand(project, { type: 'clips.remove', refs: selected }))).toHaveLength(0)
    expect(() => applyCommand(project, { type: 'clips.duplicate', refs: selected, deltaSeconds: 0, allowOverlap: true })).toThrow(/256/)
    expect(() => planClipGroupDuplicate(project, selected)).toThrow(/256/)
    expect(project).toEqual(before)
  })

  it('does not publish a partial copy when gain-region totals exceed their bound', () => {
    const project = fixture(), original = clipOf(project, 'a')
    original.gainRegions = Array.from({ length: 64 }, (_, i) => ({ id: `region-${i}`, startSeconds: 0, endSeconds: .5, gain: .5, fadeInSeconds: 0, fadeOutSeconds: 0 }))
    project.tracks[0].clips = Array.from({ length: 16 }, (_, i) => ({ ...copy(original), id: `clip-${i}`, atSeconds: i * 2 }))
    project.tracks[1].clips = []
    validateProject(project)
    const before = copy(project)
    expect(() => applyCommand(project, { type: 'clips.duplicate', refs: [{ trackId: 'voice', clipId: 'clip-0' }], deltaSeconds: 40 })).toThrow(/1024/)
    expect(project).toEqual(before)
  })
})

describe('hostile commands fail without mutation or partial history', () => {
  const badRefs = [undefined, null, [], {}, 'a', [null], [{}], [refs[0], refs[0]],
    [{ trackId: 'missing', clipId: 'a' }], [{ trackId: 'music', clipId: 'a' }], [{ trackId: 'voice', clipId: 'missing' }],
    [{ ...refs[0], atSeconds: 1 }], [{ ...refs[0], clipId: '../escape' }],
    [Object.create(refs[0])], [JSON.parse('{"trackId":"voice","clipId":"a","__proto__":{}}')],
    Array(2), Array.from({ length: 257 }, () => refs[0])]
  it.each(badRefs.map((value, index) => [index, value]))('rejects invalid reference case %i for every group command', (_index, invalidRefs) => {
    const project = fixture(), before = copy(project), history = new ProjectHistory(project)
    for (const type of ['clips.move', 'clips.duplicate', 'clips.remove']) {
      const command = type === 'clips.remove' ? { type, refs: invalidRefs } : { type, refs: invalidRefs, deltaSeconds: 7 }
      expect(() => history.push(applyCommand(project, command))).toThrow()
      expect(project).toEqual(before)
      expect(history.length).toBe(1)
    }
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, '7', true, {}, []])('rejects nonnumeric/nonfinite delta %s before JSON cloning can conceal it', deltaSeconds => {
    const project = fixture(), before = copy(project)
    for (const type of ['clips.move', 'clips.duplicate']) expect(() => applyCommand(project, { type, refs, deltaSeconds })).toThrow()
    expect(project).toEqual(before)
  })

  it.each([null, [], ['one'], ['a', 'new-b', 'new-c'], ['same', 'same', 'other'], ['one', 'two', '../escape']])('rejects malformed or colliding requested IDs %s atomically', newIds => {
    const project = fixture(), before = copy(project)
    expect(() => applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 7, newIds })).toThrow()
    expect(project).toEqual(before)
  })

  it('rejects a generated ID collision without retrying or appending any member', () => {
    const project = fixture(), before = copy(project), uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('same')
    try { expect(() => applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 7 })).toThrow(/duplicate clip ID/) }
    finally { uuid.mockRestore() }
    expect(project).toEqual(before)
  })

  it('rejects unsupported/unsafe keys, nonboolean flags, accessors and nonstandard arrays without reading accessors', () => {
    const project = fixture(), before = copy(project), getter = vi.fn(() => refs[0])
    const accessorRef = Object.defineProperty({ clipId: 'a' }, 'trackId', { enumerable: true, get: getter })
    const accessorArray = Object.defineProperty([refs[0]], '0', { enumerable: true, get: getter })
    const hiddenRef = Object.defineProperty({ ...refs[0] }, 'hidden', { value: 1 })
    const symbolRef = { ...refs[0], [Symbol('hidden')]: 1 }
    const extraArray = Object.assign([refs[0]], { extra: 1 })
    class RefArray extends Array {}
    const badCommands = [
      { type: 'clips.move', refs, deltaSeconds: 7, toTrackId: 'music' },
      { type: 'clips.remove', refs, deltaSeconds: 7 },
      ...['true', 1, null, undefined].map(allowOverlap => ({ type: 'clips.move', refs, deltaSeconds: 7, allowOverlap })),
      ...[[accessorRef], accessorArray, [hiddenRef], [symbolRef], extraArray, new RefArray(refs[0])].map(invalidRefs => ({ type: 'clips.remove', refs: invalidRefs })),
      Object.defineProperty({ refs }, 'type', { enumerable: true, get: getter }),
      Object.defineProperty({ type: 'clips.remove' }, 'refs', { enumerable: true, get: getter }),
      JSON.parse('{"type":"clips.remove","refs":[],"constructor":{}}'),
    ]
    for (const command of badCommands) expect(() => applyCommand(project, command)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(project).toEqual(before)
    expect({}.extra).toBeUndefined()
  })

  it('rejects invalid planning and overlap options', () => {
    const project = fixture()
    for (const options of [null, [], { extra: true }, { snapEnabled: 'true' }, { gridBeats: 0 }, { gridBeats: Infinity }, { gridBeats: NaN }]) {
      expect(() => planClipGroupDuplicate(project, refs, options)).toThrow()
    }
    expect(() => getClipGroupOverlaps(project, refs, 0, { duplicate: 'true' })).toThrow()
    expect(() => getClipGroupOverlaps(project, refs, 0, { arbitrary: true })).toThrow()
  })

  it('leaves the existing single-clip overlap and track-routing behavior intact', () => {
    const project = fixture()
    expect(clipOf(applyCommand(project, { type: 'clip.move', trackId: 'voice', clipId: 'a', atSeconds: 5.1 }), 'a').atSeconds).toBe(5.1)
    const routed = applyCommand(project, { type: 'clip.duplicate', trackId: 'voice', clipId: 'a', toTrackId: 'music', atSeconds: 2.25, newId: 'routed' })
    expect(routed.tracks[1].clips.some(clip => clip.id === 'routed')).toBe(true)
  })
})
