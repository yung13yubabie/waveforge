import { describe, it, expect } from 'vitest'
import { createProject, applyCommand, validateProject, registerAudioBuffer, getProjectDuration } from '../../src/js/daw/project.js'
import { ProjectHistory, cloneProjectMetadata } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { getDawGridOrigin, dawGridStepSeconds, snapDawGridTime, nextDawGridTime } from '../../src/js/daw/grid.js'

function fixture(sampleRate = 48000) {
  const length = Math.floor(sampleRate / 5) + 17
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index++) samples[index] = Math.sin(index * .091) * .2
  const buffer = { sampleRate, length, numberOfChannels: 1, duration: length / sampleRate, getChannelData: () => samples }
  const buffers = new Map()
  let project = registerAudioBuffer(createProject({ sampleRate }), buffers, buffer, { id: 'audio', name: 'synthetic.wav' }).project
  project = applyCommand(project, { type: 'track.add', track: { id: 'track', pan: -.23, gainDb: -3 } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'audio',
    atSeconds: 13 / sampleRate, offsetSeconds: 11 / sampleRate, durationSeconds: (length - 23) / sampleRate,
    fadeInSeconds: 19 / sampleRate, fadeOutSeconds: 31 / sampleRate } })
  return { project, buffers, buffer, samples }
}

describe('saved grid origin metadata', () => {
  it('keeps legacy v1 projects unchanged and treats an absent origin as zero', () => {
    const legacy = createProject()
    const serialized = JSON.stringify(legacy)
    expect(legacy).not.toHaveProperty('gridOriginSeconds')
    expect(getDawGridOrigin(legacy)).toBe(0)
    expect(validateProject(legacy)).toBe(legacy)
    expect(JSON.stringify(cloneProjectMetadata(legacy))).toBe(serialized)
    expect(getDawGridOrigin(applyCommand(legacy, { type: 'project.update', patch: { tempo: 87.5 } }))).toBe(0)
  })

  it.each([0, 11 / 44100, .137, 599.9999, 600])('saves origin %s even when there is no audio', gridOriginSeconds => {
    const project = createProject({ gridOriginSeconds })
    expect(getDawGridOrigin(project)).toBe(gridOriginSeconds)
    expect(getProjectDuration(project)).toBe(0)
    expect(cloneProjectMetadata(project)).toEqual(project)
  })

  it.each([undefined, null, NaN, Infinity, -Infinity, -Number.MIN_VALUE, 600.000001, '1', false, {}, []])('rejects malformed origin %s atomically on load and update', gridOriginSeconds => {
    const project = createProject({ gridOriginSeconds: .25 })
    const before = JSON.stringify(project)
    expect(() => createProject({ gridOriginSeconds })).toThrow(/grid origin/)
    expect(() => validateProject({ ...project, gridOriginSeconds })).toThrow(/grid origin/)
    expect(() => applyCommand(project, { type: 'project.update', patch: { gridOriginSeconds } })).toThrow(/grid origin/)
    expect(JSON.stringify(project)).toBe(before)
  })

  it('rejects inherited project/patch data and unsafe prototype keys', () => {
    const project = createProject()
    const inheritedProject = Object.assign(Object.create({ gridOriginSeconds: 2 }), project)
    expect(getDawGridOrigin(inheritedProject)).toBe(0)
    expect(() => validateProject(inheritedProject)).toThrow(/plain metadata/)
    expect(() => applyCommand(project, { type: 'project.update', patch: Object.create({ gridOriginSeconds: 2 }) })).toThrow(/plain metadata/)
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const patch = JSON.parse(`{"gridOriginSeconds":1,"${key}":{}}`)
      expect(() => applyCommand(project, { type: 'project.update', patch })).toThrow(/unsupported field/)
      expect(() => validateProject({ ...project, ...patch })).toThrow(/unsupported field/)
    }
    expect({}.gridOriginSeconds).toBeUndefined()
  })

  it('undoes/redoes an origin, returns to an absent legacy field, and retains phase after deleting audio', () => {
    const { project } = fixture()
    const history = new ProjectHistory(project)
    const aligned = applyCommand(project, { type: 'project.update', patch: { gridOriginSeconds: 13.137 } })
    history.push(aligned)
    expect(history.undo()).toEqual(project)
    expect(history.current).not.toHaveProperty('gridOriginSeconds')
    expect(history.redo()).toEqual(aligned)
    const cleared = applyCommand(aligned, { type: 'track.remove', trackId: 'track' })
    history.push(cleared)
    expect(getProjectDuration(cleared)).toBe(0)
    expect(getDawGridOrigin(cleared)).toBe(13.137)
    expect(history.undo()).toEqual(aligned)
    expect(history.redo()).toEqual(cleared)
    const reset = applyCommand(cleared, { type: 'project.update', patch: { gridOriginSeconds: 0 } })
    history.push(reset)
    expect(getDawGridOrigin(history.current)).toBe(0)
    expect(history.undo()).toEqual(cleared)
  })

  it.each([44100, 48000, 96000])('keeps source PCM, clip seconds and the entire render recipe unchanged at %s Hz', sampleRate => {
    const { project, buffers, buffer, samples } = fixture(sampleRate)
    const beforeBytes = new Uint8Array(samples.buffer.slice(0))
    const beforePlan = buildRenderPlan(project)
    const changed = applyCommand(project, { type: 'project.update', patch: { tempo: 87.375, timeSignature: [6, 8], gridOriginSeconds: 17 / sampleRate } })
    expect(changed.tracks).toEqual(project.tracks)
    expect(changed.assets).toEqual(project.assets)
    expect(buildRenderPlan(changed)).toEqual({ ...beforePlan, revision: project.revision + 1 })
    expect(buffers.get('audio')).toBe(buffer)
    expect(new Uint8Array(samples.buffer)).toEqual(beforeBytes)
  })
})

describe('pure offset grid geometry', () => {
  it('uses quarter notes for BPM and preserves fractional divisions', () => {
    expect(dawGridStepSeconds(120)).toBe(.5)
    expect(dawGridStepSeconds(87.5, .25)).toBe(60 / 87.5 / 4)
    const compound = createProject({ tempo: 120, timeSignature: [6, 8] })
    expect(dawGridStepSeconds(compound.tempo, 1)).toBe(.5)
  })

  it('keeps legacy zero-origin snapping and absolute 1 ms disabled snapping', () => {
    expect(snapDawGridTime(.74, 120)).toBe(.5)
    expect(snapDawGridTime(.76, 120)).toBe(1)
    expect(snapDawGridTime(.12, 120, .25)).toBe(.125)
    expect(snapDawGridTime(.1236, 87.5, .25, false, .137)).toBe(.124)
    expect(snapDawGridTime(.1234, 87.5, .25, false, .137)).toBe(.123)
    expect(snapDawGridTime(-.03, 120, 1, false, .137)).toBe(0)
  })

  it('snaps both sides of origin and clamps negative boundaries and project ends', () => {
    expect(snapDawGridTime(.7, 120, 1, true, .2)).toBe(.7)
    expect(snapDawGridTime(.3, 120, 1, true, 1.2)).toBeCloseTo(.2, 14)
    expect(snapDawGridTime(.01, 120, 1, true, .4)).toBe(0)
    expect(snapDawGridTime(-.2, 120, 1, true, .1)).toBe(0)
    expect(snapDawGridTime(-.01, 120, 1, true, .2)).toBe(0)
    expect(snapDawGridTime(0, 120, 1, true, .2)).toBe(0)
    expect(snapDawGridTime(599.99, 120, 1, true, .2)).toBe(600)
    expect(snapDawGridTime(1.04, 120, 1, true, .2, .8)).toBe(.8)
    expect(snapDawGridTime(0, 120, 1, true, .2, 0)).toBe(0)
    expect(Object.is(snapDawGridTime(0, 120), -0)).toBe(false)
  })

  it('nudges off-grid positions directly to the nearest boundary in either direction', () => {
    expect(nextDawGridTime(.3, 1, 120, 1, .2)).toBe(.7)
    expect(nextDawGridTime(.3, -1, 120, 1, .2)).toBe(.2)
    expect(nextDawGridTime(.69, 1, 120, 1, .2)).toBe(.7)
    expect(nextDawGridTime(.71, -1, 120, 1, .2)).toBe(.7)
    expect(nextDawGridTime(.7, 1, 120, 1, .2)).toBe(1.2)
    expect(nextDawGridTime(.7, -1, 120, 1, .2)).toBe(.2)
    expect(nextDawGridTime(.15, 1, 120, 1, 1.2)).toBeCloseTo(.2, 14)
    expect(nextDawGridTime(.15, -1, 120, 1, 1.2)).toBe(0)
  })

  it('saturates nudges at project/clip bounds, even when a bound is off-grid', () => {
    expect(nextDawGridTime(0, -1, 120, 1, .2)).toBe(0)
    expect(nextDawGridTime(0, 1, 120, 1, .2)).toBe(.2)
    expect(nextDawGridTime(.75, 1, 120, 1, .2, .8)).toBe(.8)
    expect(nextDawGridTime(.8, 1, 120, 1, .2, .8)).toBe(.8)
    expect(nextDawGridTime(.8, -1, 120, 1, .2, .8)).toBe(.7)
    expect(nextDawGridTime(600, 1, 120, 1, .2)).toBe(600)
  })

  it.each([44100, 48000, 96000])('does not round sample-based origins or fractional grids at %s Hz', sampleRate => {
    for (const tempo of [20, 87.5, 119.997, 300]) for (const beats of [4, 1, .5, .25, 1 / 3]) {
      const step = dawGridStepSeconds(tempo, beats)
      for (const origin of [17 / sampleRate, 599 + 29 / sampleRate]) {
        const index = Math.floor((351.123 - origin) / step)
        const time = origin + index * step
        expect(snapDawGridTime(time, tempo, beats, true, origin)).toBeCloseTo(time, 11)
        expect(nextDawGridTime(time, 1, tempo, beats, origin)).toBeCloseTo(origin + (index + 1) * step, 11)
        expect(nextDawGridTime(time, -1, tempo, beats, origin)).toBeCloseTo(origin + (index - 1) * step, 11)
        // A real source-frame displacement must not disappear in the numeric tolerance.
        expect(nextDawGridTime(time + 1 / sampleRate, -1, tempo, beats, origin)).toBeCloseTo(time, 11)
        expect(nextDawGridTime(time - 1 / sampleRate, 1, tempo, beats, origin)).toBeCloseTo(time, 11)
      }
    }
  })

  it('never skips or stalls when repeatedly nudging across fractional beat boundaries', () => {
    const tempo = 123.4567, beats = 1 / 3, origin = 17 / 44100
    const step = dawGridStepSeconds(tempo, beats)
    let time = origin
    for (let index = 1; index <= 3000; index++) {
      const next = nextDawGridTime(time, 1, tempo, beats, origin)
      expect(next).toBeGreaterThan(time)
      expect(next).toBeCloseTo(origin + index * step, 11)
      time = next
    }
  })

  it('rejects non-finite or unusable grid inputs instead of producing NaN', () => {
    for (const tempo of [0, -1, 19, 301, NaN, Infinity, '120']) expect(() => dawGridStepSeconds(tempo)).toThrow()
    for (const beats of [0, -1, NaN, Infinity, '1']) expect(() => dawGridStepSeconds(120, beats)).toThrow()
    for (const time of [NaN, Infinity, '1']) expect(() => snapDawGridTime(time, 120)).toThrow()
    expect(() => snapDawGridTime(1, 120, Number.MIN_VALUE)).toThrow()
    expect(() => snapDawGridTime(1, 120, 1, true, NaN)).toThrow()
    expect(() => snapDawGridTime(1, 120, 1, true, 0, 601)).toThrow()
    expect(() => nextDawGridTime(1, 0, 120)).toThrow(/direction/)
    expect(() => nextDawGridTime(1, 1, 120, 1, -1)).toThrow()
  })
})
