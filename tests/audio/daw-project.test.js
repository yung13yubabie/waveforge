import { describe, it, expect } from 'vitest'
import { createProject, applyCommand, validateProject, getClipEnvelope, envelopeValueAt, getProjectDuration, registerAudioBuffer, DAW_LIMITS } from '../../src/js/daw/project.js'

const asset = { id: 'audio', name: 'original.wav', hash: '', sampleRate: 48000, channels: 1, duration: 10, length: 480000 }
function fixture() {
  let project = applyCommand(createProject(), { type: 'asset.add', asset })
  project = applyCommand(project, { type: 'track.add', track: { id: 'track', name: 'Voice' } })
  return applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'audio', atSeconds: 20, offsetSeconds: 1, durationSeconds: 8, fadeInSeconds: 3, fadeOutSeconds: 2 } })
}
const clipOf = project => project.tracks[0].clips[0]

describe('bounded immutable DAW project commands', () => {
  it('creates serializable defaults and grid-only tempo changes', () => {
    const project = fixture(), serialized = JSON.stringify(project)
    const updated = applyCommand(project, { type: 'project.update', patch: { tempo: 87.5, timeSignature: [3, 4], masterGainDb: -6 } })
    expect(updated.tempo).toBe(87.5)
    expect(updated.masterGainDb).toBe(-6)
    expect(updated.tracks).toEqual(project.tracks)
    expect(updated.tracks).not.toBe(project.tracks)
    expect(JSON.stringify(project)).toBe(serialized)
    expect(validateProject(JSON.parse(JSON.stringify(updated)))).toEqual(updated)
  })
  it('registers the exact original buffer separately only after validation', () => {
    const samples = new Float32Array(8000), buffer = { sampleRate: 8000, numberOfChannels: 1, length: 8000, duration: 1, getChannelData: () => samples }
    const original = createProject(), buffers = new Map()
    const result = registerAudioBuffer(original, buffers, buffer, { name: 'source.wav', id: 'source', sourceSampleRate: 8000 })
    expect(result.project.assets[0]).toMatchObject({ length: 8000, duration: 1, sourceSampleRate: 8000 })
    expect(buffers.get('source')).toBe(buffer)
    expect(original.assets).toEqual([])
    samples[2] = NaN
    expect(() => registerAudioBuffer(original, buffers, buffer, { id: 'bad' })).toThrow(/non-finite/)
    expect(buffers.has('bad')).toBe(false)
  })
  it('adds, updates, duplicates and removes tracks without losing source metadata', () => {
    const start = fixture()
    let project = applyCommand(start, { type: 'track.update', trackId: 'track', patch: { gainDb: -12, pan: -1, mute: true, solo: true } })
    project = applyCommand(project, { type: 'track.duplicate', trackId: 'track', newId: 'copy' })
    expect(project.tracks[1]).toMatchObject({ gainDb: -12, pan: -1, mute: true, solo: true })
    expect(project.tracks[1].clips[0].id).not.toBe('clip')
    project = applyCommand(project, { type: 'track.remove', trackId: 'track' })
    expect(project.tracks).toHaveLength(1)
    expect(project.assets).toEqual(start.assets)
  })
  it('moves and duplicates clips between tracks with true source offsets intact', () => {
    let project = applyCommand(fixture(), { type: 'track.add', track: { id: 'destination' } })
    project = applyCommand(project, { type: 'clip.move', trackId: 'track', clipId: 'clip', toTrackId: 'destination', atSeconds: 30 })
    expect(project.tracks[0].clips).toHaveLength(0)
    expect(project.tracks[1].clips[0]).toMatchObject({ atSeconds: 30, offsetSeconds: 1, durationSeconds: 8 })
    project = applyCommand(project, { type: 'clip.duplicate', trackId: 'destination', clipId: 'clip', toTrackId: 'track', newId: 'duplicate' })
    expect(clipOf(project)).toMatchObject({ id: 'duplicate', atSeconds: 38, offsetSeconds: 1, durationSeconds: 8 })
    expect(getProjectDuration(project)).toBe(46)
    project = applyCommand(project, { type: 'clip.remove', trackId: 'track', clipId: 'duplicate' })
    expect(project.tracks[0].clips).toHaveLength(0)
    expect(project.assets).toHaveLength(1)
  })
  it.each([20.5, 22, 24, 27.5])('splits at %s without restarting a partially consumed fade', atSeconds => {
    const original = fixture(), before = clipOf(original)
    const result = applyCommand(original, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds, newId: 'right' })
    const [left, right] = result.tracks[0].clips
    expect(left.offsetSeconds).toBe(1)
    expect(right.offsetSeconds).toBe(1 + atSeconds - 20)
    expect(left.durationSeconds + right.durationSeconds).toBe(8)
    for (let seconds = 0; seconds < 8; seconds += 0.03125) {
      const sliced = seconds < left.durationSeconds ? left : right
      const local = seconds < left.durationSeconds ? seconds : seconds - left.durationSeconds
      expect(envelopeValueAt(getClipEnvelope(sliced), local)).toBeCloseTo(envelopeValueAt(getClipEnvelope(before), seconds), 10)
    }
    expect(original.tracks[0].clips).toHaveLength(1)
  })
  it('trims at absolute timeline boundaries and retains exact fade amplitudes', () => {
    const original = fixture()
    const result = applyCommand(original, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 21, endSeconds: 27 })
    const clip = clipOf(result)
    expect(clip).toMatchObject({ atSeconds: 21, offsetSeconds: 2, durationSeconds: 6 })
    expect(clip.gainEnvelope[0].value).toBeCloseTo(1 / 3)
    expect(clip.gainEnvelope.at(-1).value).toBeCloseTo(0.5)
    for (let seconds = 0; seconds <= 6; seconds += 0.125) expect(envelopeValueAt(getClipEnvelope(clip), seconds)).toBeCloseTo(envelopeValueAt(getClipEnvelope(clipOf(original)), seconds + 1), 10)
  })
  it('preserves sliced envelopes on gain changes but replaces them when fades are explicitly edited', () => {
    let project = applyCommand(fixture(), { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 21, endSeconds: 27 })
    const originalEnvelope = clipOf(project).gainEnvelope
    project = applyCommand(project, { type: 'clip.update', trackId: 'track', clipId: 'clip', patch: { gainDb: -4 } })
    expect(clipOf(project).gainEnvelope).toEqual(originalEnvelope)
    project = applyCommand(project, { type: 'clip.update', trackId: 'track', clipId: 'clip', patch: { fadeInSeconds: 1, fadeOutSeconds: 1 } })
    expect(clipOf(project).gainEnvelope).toBeUndefined()
    expect(getClipEnvelope(clipOf(project))).toEqual([{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 1 }, { timeSeconds: 5, value: 1 }, { timeSeconds: 6, value: 0 }])
  })
  it.each([
    { type: 'clip.move', trackId: 'track', clipId: 'clip', atSeconds: 595 },
    { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: 20 },
    { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 19, endSeconds: 26 },
    { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 22, endSeconds: 22 },
    { type: 'clip.update', trackId: 'track', clipId: 'clip', patch: { fadeInSeconds: 7 } },
    { type: 'clip.update', trackId: 'track', clipId: 'clip', patch: { playbackRate: 2 } },
    { type: 'track.update', trackId: 'track', patch: { pan: NaN } },
    { type: 'track.update', trackId: 'track', patch: { mute: 1 } },
    { type: 'project.update', patch: { masterGainDb: 30 } },
    { type: 'project.update', patch: { sampleRate: 12345 } },
    { type: 'asset.add', asset: { ...asset, channels: 6, id: 'six' } },
  ])('fails atomically on invalid command $type', command => {
    const project = fixture(), serialized = JSON.stringify(project)
    expect(() => applyCommand(project, command)).toThrow()
    expect(JSON.stringify(project)).toBe(serialized)
  })
  it('enforces track, clip, decoded-memory and identity bounds', () => {
    let project = fixture()
    while (project.tracks.length < DAW_LIMITS.maxTracks) project = applyCommand(project, { type: 'track.add' })
    expect(() => applyCommand(project, { type: 'track.add' })).toThrow(/16/)
    expect(() => applyCommand(fixture(), { type: 'asset.add', asset })).toThrow(/duplicate/)
    const bad = fixture(); bad.tracks[0].clips[0].assetId = 'missing'
    expect(() => validateProject(bad)).toThrow(/missing asset/)
    expect(() => createProject({ assets: [{ ...asset, duration: 600, length: 115200000, sampleRate: 192000, channels: 2 }] })).toThrow(/256 MiB/)
  })
  it('rejects oversized decoded data before mutating the buffer registry', () => {
    const buffer = { sampleRate: 192000, numberOfChannels: 2, length: 115200000, duration: 600, getChannelData: () => { throw new Error('should not allocate') } }
    const map = new Map()
    expect(() => registerAudioBuffer(createProject(), map, buffer)).toThrow(/256 MiB/)
    expect(map.size).toBe(0)
  })
})

describe('serialized metadata rejection', () => {
  it.each([
    project => { project.extra = true },
    project => { project.assets[0].hash = 'no-fingerprint' },
    project => { project.assets[0].duration = 1e-12 },
    project => { project.assets[0].length = 100 },
    project => { project.timeSignature = [4, 3] },
    project => { project.timeSignature = [4] },
    project => { project.tempo = Infinity },
    project => { clipOf(project).gainEnvelope = [{ timeSeconds: 1, value: 1 }, { timeSeconds: 8, value: 0 }] },
    project => { clipOf(project).gainEnvelope = [{ timeSeconds: 0, value: 1 }, { timeSeconds: 0, value: 0 }] },
    project => { clipOf(project).gainEnvelope = [{ timeSeconds: 0, value: -1 }, { timeSeconds: 8, value: 0 }] },
    project => { clipOf(project).gainEnvelope = [] },
    project => { clipOf(project).offsetSeconds = 9 },
    project => { project.tracks[0].clips = Array.from({ length: 257 }, (_, index) => ({ ...clipOf(project), id: `clip-${index}` })) },
  ])('rejects malformed metadata instead of silently changing the sound', mutate => {
    const project = fixture(); mutate(project)
    expect(() => validateProject(project)).toThrow()
  })
  it('retains orphan undo PCM in the runtime memory accounting', () => {
    const huge = { length: DAW_LIMITS.maxDecodedBytes / 4, numberOfChannels: 1 }
    const map = new Map([['retained-for-undo', huge]])
    const buffer = { sampleRate: 8000, numberOfChannels: 1, length: 8000, duration: 1, getChannelData: () => new Float32Array(8000) }
    expect(() => registerAudioBuffer(createProject(), map, buffer)).toThrow(/retained audio/)
    expect(map.size).toBe(1)
  })
})
