// @vitest-environment node
// Real file bytes, hashes and ZIP round-trip. The sample oracle below evaluates
// the shared render recipe; native browser DSP is exercised by the e2e spec.
import { describe, it, expect } from 'vitest'
import { createProject, applyCommand, registerAudioBuffer, envelopeValueAt } from '../../src/js/daw/project.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'

function tone(frequency, sampleRate, duration) {
  const data = new Float32Array(Math.round(duration * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = .2 * Math.sin(2 * Math.PI * frequency * i / sampleRate)
  return { numberOfChannels: 2, sampleRate, length: data.length, duration: data.length / sampleRate, getChannelData: () => data }
}
function decodeFixtureWav(bytes) {
  const view = new DataView(bytes), sampleRate = view.getUint32(24, true), channels = view.getUint16(22, true)
  expect(view.getUint16(34, true)).toBe(24)
  const length = view.getUint32(40, true) / (channels * 3)
  const pcm = Array.from({ length: channels }, () => new Float32Array(length))
  for (let i = 0; i < length; i++) for (let c = 0; c < channels; c++) {
    const at = 44 + (i * channels + c) * 3
    const value = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)
    pcm[c][i] = value / 8388608
  }
  return { sampleRate, numberOfChannels: channels, length, duration: length / sampleRate, getChannelData: c => pcm[c] }
}
async function register(project, buffers, files, raw, id) {
  const encoded = encodeWAV([raw.getChannelData(0), raw.getChannelData(1)], raw.sampleRate, 24)
  const file = new File([encoded], `${id}.wav`, { type: 'audio/wav' })
  const decoded = decodeFixtureWav(await file.arrayBuffer())
  const result = registerAudioBuffer(project, buffers, decoded, { id, name: file.name, hash: await sha256Hex(encoded), sourceSampleRate: raw.sampleRate, decodeBackend: 'native-rate-wav' })
  files.set(id, file)
  return result.project
}
function referenceSamples(project, buffers) {
  const plan = buildRenderPlan(project), samples = new Float32Array(plan.frames)
  for (const track of plan.tracks) for (const clip of track.clips) {
    const source = buffers.get(clip.assetId), data = source.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      const local = i / plan.sampleRate - clip.atSeconds
      if (local < 0 || local >= clip.durationSeconds) continue
      const position = (clip.offsetSeconds + local) * source.sampleRate, left = Math.floor(position), f = position - left
      const value = data[left] * (1 - f) + (data[Math.min(left + 1, data.length - 1)] || 0) * f
      samples[i] += value * clip.gain * track.gain * plan.masterGain * envelopeValueAt(clip.envelope, local) * envelopeValueAt(clip.automation, local)
    }
  }
  return samples
}
function magnitude(data, rate, frequency, start, end) {
  let re = 0, im = 0
  for (let i = Math.round(start * rate); i < Math.round(end * rate); i++) {
    re += data[i] * Math.cos(2 * Math.PI * frequency * i / rate)
    im -= data[i] * Math.sin(2 * Math.PI * frequency * i / rate)
  }
  return Math.hypot(re, im)
}

async function fixture() {
  const buffers = new Map(), files = new Map()
  let project = await register(createProject({ masterGainDb: -3, sampleRate: 48000 }), buffers, files, tone(220, 48000, 2), 'original')
  project = applyCommand(project, { type: 'track.add', track: { id: 'vocal', gainDb: -2 } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'vocal', clip: { id: 'phrase', assetId: 'original', atSeconds: .25, offsetSeconds: .125, durationSeconds: 1.5, gainDb: -4, fadeInSeconds: .25, fadeOutSeconds: .25 } })
  project = applyCommand(project, { type: 'clip.automation.add', trackId: 'vocal', clipId: 'phrase', point: { timeSeconds: .75, value: .5 } })
  const original = project, history = new ProjectHistory(project)
  project = await register(project, buffers, files, tone(660, 44100, 3), 'replacement')
  project = applyCommand(project, { type: 'clip.replaceSource', trackId: 'vocal', clipId: 'phrase', assetId: 'replacement', offsetSeconds: .5 })
  history.push(project)
  return { original, project, history, buffers, files }
}

describe('replacement original-media / recipe / WAV sample contract', () => {
  it('changes the actual selected source frequency while preserving timing, fades and automation', async () => {
    const { project, original, buffers } = await fixture()
    const before = referenceSamples(original, buffers), after = referenceSamples(project, buffers)
    expect(project.tracks[0].clips[0]).toEqual({ ...original.tracks[0].clips[0], assetId: 'replacement', offsetSeconds: .5 })
    expect(before.length).toBe(after.length)
    expect(before.length).toBe(84000)
    expect(after.subarray(0, 12000).every(value => value === 0)).toBe(true)
    expect(magnitude(after, 48000, 660, .5, 1.5)).toBeGreaterThan(1000 * magnitude(after, 48000, 220, .5, 1.5))
    expect(magnitude(before, 48000, 220, .5, 1.5)).toBeGreaterThan(1000 * magnitude(before, 48000, 660, .5, 1.5))
    const clip = project.tracks[0].clips[0], plan = buildRenderPlan(project), sampleIndex = 24113, local = sampleIndex / 48000 - clip.atSeconds
    const value = .2 * Math.sin(2 * Math.PI * 660 * (.5 + local)) * 10 ** (-9 / 20) * envelopeValueAt(plan.tracks[0].clips[0].automation, local)
    expect(after[sampleIndex]).toBeCloseTo(value, 4)
  })
  it('keeps native rates, original byte hashes and replacement samples through Undo/Redo and portable ZIP reload', async () => {
    const { project, original, history, buffers, files } = await fixture()
    const beforeBytes = await files.get('original').arrayBuffer(), newBytes = await files.get('replacement').arrayBuffer()
    const expected = referenceSamples(project, buffers)
    const expectedWav = encodeWAV([expected, expected], project.sampleRate, 24)
    expect(history.undo()).toEqual(original)
    expect(referenceSamples(history.current, buffers)).toEqual(referenceSamples(original, buffers))
    expect(history.redo()).toEqual(project)
    expect(referenceSamples(history.current, buffers)).toEqual(expected)
    const zip = await exportProjectArchive(project, files)
    const restored = await importProjectArchive(zip, { decodeAsset: bytes => decodeFixtureWav(bytes) })
    expect(restored.project).toEqual(project)
    expect(restored.buffers.get('original').sampleRate).toBe(48000)
    expect(restored.buffers.get('replacement').sampleRate).toBe(44100)
    expect(await restored.files.get('original').arrayBuffer()).toEqual(beforeBytes)
    expect(await restored.files.get('replacement').arrayBuffer()).toEqual(newBytes)
    expect(await sha256Hex(beforeBytes)).not.toBe(await sha256Hex(newBytes))
    const after = referenceSamples(restored.project, restored.buffers)
    expect(after).toEqual(expected)
    expect(encodeWAV([after, after], restored.project.sampleRate, 24)).toEqual(expectedWav)
    expect(new ProjectHistory(restored.project).canUndo).toBe(false)
    // The archive includes full original takes, even though only a subrange of
    // the replacement is heard and the old take is currently unreferenced.
    expect(restored.project.assets.map(asset => asset.id)).toEqual(['original', 'replacement'])
    expect(restored.files.size).toBe(2)
  })
})
