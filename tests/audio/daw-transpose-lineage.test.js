// @vitest-environment node
// Real project/ZIP bytes and an independent float decoder; not browser evidence.
import { describe, expect, it, vi } from 'vitest'
import { createProject, applyCommand, registerAudioBuffer, validateProject, getClipOriginalSource, CLIP_TRANSPOSE_ENGINE } from '../../src/js/daw/project.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { planClipTranspose } from '../../src/js/daw/transpose.js'
import { encodeGeneratedFloatWav } from '../../src/js/audio/generated-float-wav.js'
import { createZip } from '../../src/js/audio/zip.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'
const clone = value => JSON.parse(JSON.stringify(value))
const getClip = project => project.tracks[0].clips[0]
function native(channels, rate) { return { length: channels[0].length, sampleRate: rate, numberOfChannels: channels.length, duration: channels[0].length / rate, getChannelData: c => channels[c] } }
function decodeFloat(bytes) {
  const view = new DataView(bytes), rate = view.getUint32(24, true), count = view.getUint16(22, true), length = view.getUint32(54, true) / count / 4
  expect(view.getUint16(20, true)).toBe(3)
  return native(Array.from({ length: count }, (_, c) => Float32Array.from({ length }, (_, i) => view.getFloat32(58 + (i * count + c) * 4, true))), rate)
}
async function fixture(rate = 44100, { frames = rate, offsetSeconds = 100.5 / rate, durationSeconds = .5, atSeconds = .25, edit } = {}) {
  const files = new Map(), buffers = new Map(), samples = Float32Array.from({ length: frames }, (_, i) => .2 * Math.sin(i * Math.PI * 440 / rate))
  const input = native([samples], rate)
  async function register(project, buffer, id, backend) {
    const bytes = await encodeGeneratedFloatWav([buffer.getChannelData(0)], rate, { yieldControl: async () => {} })
    files.set(id, new File([bytes], `${id}.wav`, { type: 'audio/wav' }))
    return registerAudioBuffer(project, buffers, buffer, { id, name: `${id}.wav`, hash: await sha256Hex(bytes), sourceSampleRate: rate, decodeBackend: backend }).project
  }
  let project = await register(createProject(), input, 'original', 'native-rate-wav')
  project = applyCommand(project, { type: 'track.add', track: { id: 'track' } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'original', atSeconds, offsetSeconds, durationSeconds, gainDb: -2, fadeInSeconds: .02, fadeOutSeconds: .03 } })
  project = applyCommand(project, { type: 'clip.automation.add', trackId: 'track', clipId: 'clip', point: { timeSeconds: durationSeconds * .4, value: .5 } })
  if (edit) project = edit(project)
  const original = project, clip = getClip(project), settings = { semitones: 1, cents: 25, formantSemitones: -.5, formantCompensation: true }
  const plan = planClipTranspose(input, clip, settings)
  const generated = native(plan.channels.map(channel => channel.map(value => value * .75)), rate)
  project = await register(project, generated, 'processed', 'generated-float32-wav')
  const transpose = { version: 1, engine: CLIP_TRANSPOSE_ENGINE, sourceAssetId: 'original', sourceOffsetSeconds: clip.offsetSeconds, sourceDurationSeconds: clip.durationSeconds, cropFirstFrame: plan.first, cropLastFrame: plan.last, ...settings }
  project = applyCommand(project, { type: 'clip.replaceSource', trackId: 'track', clipId: clip.id, assetId: 'processed', offsetSeconds: plan.offsetSeconds, transpose })
  return { project, original, files, buffers, transpose }
}
const recover = (project, clipId = 'clip') => {
  const clip = project.tracks[0].clips.find(clip => clip.id === clipId), source = project.assets.find(asset => asset.id === clip.transpose.sourceAssetId)
  return applyCommand(project, { type: 'clip.replaceSource', trackId: 'track', clipId, ...getClipOriginalSource(clip, source.sampleRate) })
}
async function malformedZip(archive, mutate) {
  const bytes = new Uint8Array(await archive.arrayBuffer()), view = new DataView(bytes.buffer), entries = []
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true), dataAt = at + 30 + nameLength + view.getUint16(at + 28, true)
    entries.push({ name: new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)), data: bytes.slice(dataAt, dataAt + size) })
    at = dataAt + size
  }
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].data)); mutate(manifest.project)
  entries[0].data = new TextEncoder().encode(JSON.stringify(manifest))
  return new Blob([createZip(entries)], { type: 'application/zip' })
}

describe('bounded versioned generated-take lineage', () => {
  it.each([44100, 48000, 96000])('round-trips persisted parameters and exact original recovery after fresh ZIP restore at %i Hz', async rate => {
    const { project, original, files, buffers, transpose } = await fixture(rate)
    const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
    expect(restored.project).toEqual(project); expect(getClip(restored.project).transpose).toEqual(transpose)
    for (const id of ['original', 'processed']) {
      expect(await restored.files.get(id).arrayBuffer()).toEqual(await files.get(id).arrayBuffer())
      expect(Buffer.compare(Buffer.from(restored.buffers.get(id).getChannelData(0).buffer), Buffer.from(buffers.get(id).getChannelData(0).buffer))).toBe(0)
    }
    const history = new ProjectHistory(restored.project); expect(history.canUndo).toBe(false)
    const recovered = recover(restored.project)
    expect(getClip(recovered)).toEqual(getClip(original))
    history.push(recovered); expect(history.undo()).toEqual(project); expect(history.redo()).toEqual(recovered)
    expect(recovered.assets.map(asset => asset.id)).toEqual(['original', 'processed'])
  })
  it.each([[44100, 5518], [48000, 6007], [96000, 12001], [44100, 44107], [48000, 48003], [96000, 96006]])('persists exact full-source lineage for the %i Hz / %i frame roundoff regression', async (rate, frames) => {
    const { project, original, files } = await fixture(rate, { frames, offsetSeconds: 0, durationSeconds: frames / rate })
    expect(getClip(project).transpose.cropLastFrame).toBe(frames)
    const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
    expect(restored.project).toEqual(project); expect(getClip(recover(restored.project))).toEqual(getClip(original))
  })
  it.each([44100, 48000, 96000])('keeps late-timeline trim/split rounding and original recovery consistent at %i Hz', async rate => {
    const frames = rate === 44100 ? 44107 : rate === 48000 ? 48003 : 96007
    for (const mode of ['trim', 'split']) {
      const { project, original, files } = await fixture(rate, { frames, atSeconds: 500.3, offsetSeconds: 0, durationSeconds: frames / rate,
        edit: source => mode === 'trim'
          ? applyCommand(source, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 500.4, endSeconds: 500.3 + frames / rate })
          : applyCommand(applyCommand(source, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: 500.4, newId: 'tail' }), { type: 'clip.remove', trackId: 'track', clipId: 'clip' }) })
      const clip = getClip(project)
      expect(clip.offsetSeconds).toBe(0); expect(clip.transpose.cropFirstFrame).toBe(rate / 10)
      expect(clip.transpose.cropLastFrame).toBe(frames)
      const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
      const recovered = recover(restored.project, clip.id)
      expect(getClip(recovered)).toEqual(getClip(original))
      expect(getClip(recovered).offsetSeconds).toBe(500.4 - 500.3)
    }
  })
  it.each([44100, 48000, 96000])('accepts a sample-aligned 30-second crop despite subtraction roundoff at %i Hz', async rate => {
    expect(32.2 - 2.2).toBeGreaterThan(30)
    const { project, original, files } = await fixture(rate, { frames: rate * 30, atSeconds: 2.2, offsetSeconds: 0, durationSeconds: 30,
      edit: source => applyCommand(source, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: 2.2, endSeconds: 32.2 }) })
    expect(getClip(project).durationSeconds).toBe(32.2 - 2.2)
    expect(getClip(project).transpose.cropLastFrame).toBe(rate * 30)
    const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
    expect(restored.project).toEqual(project); expect(getClip(recover(restored.project))).toEqual(getClip(original))
  })
  it.each([44100, 48000, 96000])('normalizes a tiny negative generated offset from .35-.25 but restores the exact captured seconds at %i Hz', async rate => {
    const { project, original, files } = await fixture(rate, { atSeconds: .25, offsetSeconds: 0, durationSeconds: .5,
      edit: source => applyCommand(source, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: .35, endSeconds: .7 }) })
    expect(getClip(project).offsetSeconds).toBe(0)
    expect(getClip(project).transpose.sourceOffsetSeconds).toBe(.35 - .25)
    const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
    expect(getClip(recover(restored.project))).toEqual(getClip(original))
  })
  it.each([44100, 48000, 96000])('preserves genuine positive and negative millionth-frame offsets in ZIP lineage at %i Hz', async rate => {
    for (const delta of [-.000001, .000001]) {
      const offsetSeconds = (rate / 10 + delta) / rate
      const { project, original, files } = await fixture(rate, { offsetSeconds })
      const clip = getClip(project), first = delta > 0 ? rate / 10 : rate / 10 - 1
      expect(clip.transpose.cropFirstFrame).toBe(first)
      expect(clip.offsetSeconds).toBe(offsetSeconds - first / rate)
      expect(clip.offsetSeconds).toBeGreaterThan(0)
      const restored = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset: decodeFloat })
      expect(getClip(recover(restored.project))).toEqual(getClip(original))
    }
  })
  it('keeps old projects compatible and drops stale lineage when replacing with any other recording', async () => {
    const { project, original } = await fixture()
    expect(validateProject(clone(original))).toEqual(original)
    const result = applyCommand(project, { type: 'clip.replaceSource', trackId: 'track', clipId: 'clip', assetId: 'original', offsetSeconds: .1 })
    expect(getClip(result).transpose).toBeUndefined(); expect(getClip(project).transpose).toBeDefined()
  })
  it('retains original mapping through trim, split and duplicate without changing the remaining envelopes', async () => {
    const { project, original } = await fixture()
    const trim = input => applyCommand(input, { type: 'clip.trim', trackId: 'track', clipId: 'clip', startSeconds: .3, endSeconds: .7 })
    const split = input => applyCommand(input, { type: 'clip.split', trackId: 'track', clipId: 'clip', atSeconds: .5, newId: 'tail' })
    let result = split(trim(project)), expected = split(trim(original))
    result = recover(recover(result), 'tail')
    expect(result.tracks).toEqual(expected.tracks)
    const duplicate = applyCommand(project, { type: 'clip.duplicate', trackId: 'track', clipId: 'clip', newId: 'copy' })
    expect(duplicate.tracks[0].clips[1].transpose).toEqual(getClip(project).transpose)
    expect(recover(duplicate, 'copy').tracks[0].clips[1].transpose).toBeUndefined()
  })
  it.each([
    t => { t.version = 2 }, t => { t.engine = 'arbitrary-plugin' }, t => { t.sourceAssetId = 'missing' }, t => { t.sourceAssetId = 'processed' },
    t => { t.sourceOffsetSeconds = -1 }, t => { t.sourceOffsetSeconds = Infinity }, t => { t.sourceDurationSeconds = 31 },
    t => { t.cropFirstFrame++ }, t => { t.cropLastFrame++ }, t => { t.cropLastFrame = t.cropFirstFrame },
    t => { t.semitones = 3 }, t => { t.cents = 101 }, t => { t.semitones = 2; t.cents = 1 },
    t => { t.formantSemitones = NaN }, t => { t.formantCompensation = 'true' }, t => { t.script = 'arbitrary' }, t => { delete t.version },
  ])('rejects malformed/unknown lineage transactionally', async mutate => {
    const { project } = await fixture(), before = JSON.stringify(project), recipe = clone(getClip(project).transpose)
    mutate(recipe)
    expect(() => applyCommand(project, { type: 'clip.replaceSource', trackId: 'track', clipId: 'clip', assetId: 'processed', offsetSeconds: getClip(project).offsetSeconds, transpose: recipe })).toThrow()
    expect(JSON.stringify(project)).toBe(before)
    const broken = clone(project); broken.tracks[0].clips[0].transpose = recipe
    expect(() => validateProject(broken)).toThrow()
  })
  it('rejects generated-to-generated ancestry, inconsistent source formats and expansion outside the recorded original interval', async () => {
    const { project } = await fixture()
    for (const mutate of [
      p => { p.assets[0].decodeBackend = 'generated-float32-wav' },
      p => { p.assets[0].channels = 2 }, p => { p.assets[1].length-- },
      p => { getClip(p).offsetSeconds = 0 },
    ]) { const broken = clone(project); mutate(broken); expect(() => validateProject(broken)).toThrow() }
  })
  it('rejects hostile lineage in a valid-CRC ZIP before audio decode, preserving an existing accepted project', async () => {
    const { project, files } = await fixture(), archive = await exportProjectArchive(project, files), current = { project }
    const decoder = vi.fn(decodeFloat)
    for (const mutate of [p => { getClip(p).transpose.version = 999 }, p => { getClip(p).transpose.sourceAssetId = 'missing' }, p => { getClip(p).transpose.remoteUrl = 'https://invalid.example/audio' }]) {
      const bad = await malformedZip(archive, mutate)
      await expect(importProjectArchive(bad, { decodeAsset: decoder }).then(result => Object.assign(current, result))).rejects.toThrow()
      expect(current.project).toBe(project); expect(decoder).not.toHaveBeenCalled()
    }
  })
})
