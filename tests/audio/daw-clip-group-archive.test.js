// @vitest-environment node
// Synthetic source bytes and an independent float decoder prove metadata/ZIP
// fidelity here. Actual browser PCM rendering is covered by the browser suite.
import { describe, expect, it, vi } from 'vitest'
import { applyCommand, createProject, registerAudioBuffer, getClipOriginalSource, CLIP_TRANSPOSE_ENGINE } from '../../src/js/daw/project.js'
import { planClipGroupDuplicate } from '../../src/js/daw/clip-groups.js'
import { ProjectHistory } from '../../src/js/daw/history.js'
import { buildRenderPlan } from '../../src/js/daw/render.js'
import { exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'
import { sourceFrameBounds } from '../../src/js/daw/sample-bounds.js'
import { encodeGeneratedFloatWav } from '../../src/js/audio/generated-float-wav.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'
import { createZip } from '../../src/js/audio/zip.js'

const copy = value => JSON.parse(JSON.stringify(value))
const refs = [{ trackId: 'voice', clipId: 'processed-clip' }, { trackId: 'music', clipId: 'native-clip' }]
const clipOf = (project, id) => project.tracks.flatMap(track => track.clips).find(clip => clip.id === id)
const native = (samples, sampleRate) => ({ sampleRate, length: samples.length, duration: samples.length / sampleRate,
  numberOfChannels: 1, getChannelData: () => samples })
function decodeFloat(bytes) {
  const view = new DataView(bytes), rate = view.getUint32(24, true), channels = view.getUint16(22, true)
  const length = view.getUint32(54, true) / channels / 4
  expect(view.getUint16(20, true)).toBe(3)
  expect(channels).toBe(1)
  return native(Float32Array.from({ length }, (_, i) => view.getFloat32(58 + i * 4, true)), rate)
}
async function fixture(sampleRate) {
  const samples = Float32Array.from({ length: sampleRate / 2 + 17 }, (_, index) => .15 * Math.sin(index * .173))
  const sourceOffsetSeconds = 13.5 / sampleRate, sourceDurationSeconds = (sampleRate / 4 + .25) / sampleRate
  const bounds = sourceFrameBounds(sourceOffsetSeconds, sourceDurationSeconds, sampleRate)
  const generated = Float32Array.from({ length: bounds.last - bounds.first }, (_, index) => .11 * Math.cos(index * .147))
  const files = new Map(), buffers = new Map(), bytes = new Map()
  let project = createProject({ sampleRate: 44100, tempo: 93.125, gridOriginSeconds: 11.5 / sampleRate })
  for (const [id, pcm, decodeBackend] of [['original', samples, 'native-rate-wav'], ['generated', generated, 'generated-float32-wav']]) {
    const encoded = await encodeGeneratedFloatWav([pcm], sampleRate, { yieldControl: async () => {} })
    bytes.set(id, encoded)
    files.set(id, new File([encoded], `${id}.wav`, { type: 'audio/wav', lastModified: 0 }))
    project = registerAudioBuffer(project, buffers, native(pcm, sampleRate), { id, name: `${id}.wav`,
      hash: await sha256Hex(encoded), sourceSampleRate: sampleRate, decodeBackend }).project
  }
  project = applyCommand(project, { type: 'track.add', track: { id: 'voice', gainDb: -3, pan: -.2 } })
  project = applyCommand(project, { type: 'track.add', track: { id: 'music', gainDb: -6, pan: .3 } })
  const transpose = { version: 1, engine: CLIP_TRANSPOSE_ENGINE, sourceAssetId: 'original', sourceOffsetSeconds,
    sourceDurationSeconds, cropFirstFrame: bounds.first, cropLastFrame: bounds.last,
    semitones: 1, cents: 25, formantSemitones: -.5, formantCompensation: true }
  project = applyCommand(project, { type: 'clip.add', trackId: 'voice', clip: {
    id: 'processed-clip', assetId: 'generated', atSeconds: 500.3, offsetSeconds: bounds.offsetSeconds,
    durationSeconds: sourceDurationSeconds, fadeInSeconds: .02, fadeOutSeconds: .03, gainDb: -2, transpose,
    gainEnvelope: [{ timeSeconds: 0, value: .2 }, { timeSeconds: .1, value: 1 }, { timeSeconds: sourceDurationSeconds, value: .7 }],
    volumeAutomation: [{ timeSeconds: 0, value: .8 }, { timeSeconds: .12, value: 1.1 }, { timeSeconds: sourceDurationSeconds, value: .5 }],
  } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'music', clip: {
    id: 'native-clip', assetId: 'original', atSeconds: 500.8 + 7 / sampleRate, offsetSeconds: 37.25 / sampleRate,
    durationSeconds: .125, fadeInSeconds: .01, fadeOutSeconds: .02, gainDb: -1,
  } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'voice', clip: {
    id: 'unselected', assetId: 'original', atSeconds: 501.5, durationSeconds: .0625, offsetSeconds: 2.5 / sampleRate,
  } })
  // This produces an already-cropped common-ramp envelope at a late position.
  project = applyCommand(project, { type: 'track.gainRegion.add', trackId: 'voice', region: {
    id: 'shared-ramp', label: 'shared transition', startSeconds: 500.29, endSeconds: 501.6, gain: .4, fadeInSeconds: .3, fadeOutSeconds: .3,
  } })
  return { project, files, buffers, bytes, sourceOffsetSeconds }
}
async function entriesOf(archive) {
  const bytes = new Uint8Array(await archive.arrayBuffer()), view = new DataView(bytes.buffer), entries = []
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), start = offset + 30 + nameLength
    entries.push({ name: new TextDecoder().decode(bytes.subarray(offset + 30, start)), data: bytes.slice(start, start + length) })
    offset = start + length
  }
  return entries
}

describe('portable group edits preserve original media and transpose lineage', () => {
  it.each([44100, 48000, 96000])('round-trips group move/copy/remove and independent native %i Hz source bytes', async sampleRate => {
    const { project, files, buffers, bytes, sourceOffsetSeconds } = await fixture(sampleRate), before = copy(project)
    for (const type of ['clips.move', 'clips.duplicate', 'clips.remove']) {
      const command = type === 'clips.remove' ? { type, refs } : { type, refs, deltaSeconds: 6,
        ...(type === 'clips.duplicate' ? { newIds: ['copy-processed', 'copy-native'] } : {}) }
      const next = applyCommand(project, command), expectedPlan = buildRenderPlan(next)
      const archive = await exportProjectArchive(next, files), entries = await entriesOf(archive)
      expect(entries.map(entry => entry.name)).toEqual(['manifest.json', 'media/0000.bin', 'media/0001.bin'])
      const manifest = JSON.parse(new TextDecoder().decode(entries[0].data))
      expect(manifest.project).toEqual(next)
      expect(manifest.media).toHaveLength(2)
      const decoder = vi.fn(decodeFloat), restored = await importProjectArchive(archive, { decodeAsset: decoder })
      expect(decoder).toHaveBeenCalledTimes(2)
      expect(restored.project).toEqual(next)
      expect(buildRenderPlan(restored.project)).toEqual(expectedPlan)
      expect(restored.project.assets).toEqual(project.assets)
      expect(restored.files.size).toBe(2)
      expect(restored.buffers.size).toBe(2)
      for (const asset of project.assets) {
        expect(await restored.files.get(asset.id).arrayBuffer()).toEqual(bytes.get(asset.id))
        expect(await sha256Hex(await restored.files.get(asset.id).arrayBuffer())).toBe(asset.hash)
        expect(restored.buffers.get(asset.id).getChannelData(0)).toEqual(buffers.get(asset.id).getChannelData(0))
        expect(restored.buffers.get(asset.id).sampleRate).toBe(sampleRate)
      }
      if (type !== 'clips.remove') {
        const id = type === 'clips.duplicate' ? 'copy-processed' : 'processed-clip', edited = clipOf(restored.project, id)
        expect(edited.transpose).toEqual(clipOf(project, 'processed-clip').transpose)
        expect(getClipOriginalSource(edited, sampleRate)).toEqual({ assetId: 'original', offsetSeconds: sourceOffsetSeconds })
        expect(edited.gainEnvelope).toEqual(clipOf(project, 'processed-clip').gainEnvelope)
        expect(edited.gainRegions).toEqual(clipOf(project, 'processed-clip').gainRegions)
        const recovered = applyCommand(restored.project, { type: 'clip.replaceSource', trackId: 'voice', clipId: id, ...getClipOriginalSource(edited, sampleRate) })
        expect(clipOf(recovered, id).assetId).toBe('original')
        expect(clipOf(recovered, id).offsetSeconds).toBe(sourceOffsetSeconds)
        expect(clipOf(recovered, id).durationSeconds).toBe(edited.durationSeconds)
        expect(clipOf(recovered, id)).not.toHaveProperty('transpose')
      }
      expect(await entriesOf(await exportProjectArchive(restored.project, restored.files))).toEqual(entries)
      const history = new ProjectHistory(project)
      history.push(next)
      expect(history.undo()).toEqual(project)
      expect(history.redo()).toEqual(restored.project)
      expect([...history.retainedAssetIds()]).toEqual(['original', 'generated'])
      expect(project).toEqual(before)
    }
  })

  it.each([44100, 48000, 96000])('preserves a trimmed fractional lineage through snapped copy and fresh restore at %i Hz', async sampleRate => {
    const fixtureData = await fixture(sampleRate), original = fixtureData.project, originalClip = clipOf(original, 'processed-clip')
    const trimmed = applyCommand(original, { type: 'clip.trim', trackId: 'voice', clipId: 'processed-clip',
      startSeconds: originalClip.atSeconds + 3.5 / sampleRate, endSeconds: originalClip.atSeconds + originalClip.durationSeconds - 7.25 / sampleRate })
    const plan = planClipGroupDuplicate(trimmed, refs, { snapEnabled: true, gridBeats: 1 / 3 })
    const copied = applyCommand(trimmed, { type: 'clips.duplicate', refs, deltaSeconds: plan.deltaSeconds, newIds: ['copy-processed', 'copy-native'] })
    const restored = await importProjectArchive(await exportProjectArchive(copied, fixtureData.files), { decodeAsset: decodeFloat })
    const source = clipOf(trimmed, 'processed-clip'), duplicate = clipOf(restored.project, 'copy-processed')
    expect(duplicate).toEqual({ ...source, id: 'copy-processed', atSeconds: source.atSeconds + plan.deltaSeconds })
    expect(getClipOriginalSource(duplicate, sampleRate)).toEqual(getClipOriginalSource(source, sampleRate))
    expect(duplicate.transpose.sourceOffsetSeconds).toBe(originalClip.transpose.sourceOffsetSeconds)
    expect(duplicate.transpose.cropFirstFrame).toBe(originalClip.transpose.cropFirstFrame)
    expect(duplicate.transpose.cropLastFrame).toBe(originalClip.transpose.cropLastFrame)
    expect(restored.project.assets.map(asset => asset.hash)).toEqual(original.assets.map(asset => asset.hash))
  })

  it('keeps both retained source files after removing every clip and restores the empty project', async () => {
    const { project, files, bytes } = await fixture(44100)
    const allRefs = project.tracks.flatMap(track => track.clips.map(clip => ({ trackId: track.id, clipId: clip.id })))
    const empty = applyCommand(project, { type: 'clips.remove', refs: allRefs })
    const restored = await importProjectArchive(await exportProjectArchive(empty, files), { decodeAsset: decodeFloat })
    expect(restored.project).toEqual(empty)
    expect(restored.project.tracks.every(track => track.clips.length === 0)).toBe(true)
    expect(restored.project.assets).toEqual(project.assets)
    for (const [id, encoded] of bytes) expect(await restored.files.get(id).arrayBuffer()).toEqual(encoded)
  })

  it('rejects a corrupted copied lineage before decoding any source or replacing current state', async () => {
    const { project, files } = await fixture(48000)
    const copied = applyCommand(project, { type: 'clips.duplicate', refs, deltaSeconds: 6, newIds: ['copy-processed', 'copy-native'] })
    const entries = await entriesOf(await exportProjectArchive(copied, files))
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data))
    clipOf(manifest.project, 'copy-processed').transpose.sourceAssetId = 'missing'
    entries[0].data = new TextEncoder().encode(JSON.stringify(manifest))
    const decoder = vi.fn(decodeFloat), current = { project, files }
    await expect(importProjectArchive(new Blob([createZip(entries)]), { decodeAsset: decoder }).then(result => Object.assign(current, result))).rejects.toThrow(/original/)
    expect(decoder).not.toHaveBeenCalled()
    expect(current.project).toBe(project)
    expect(current.files).toBe(files)
  })
})
