// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { createZip } from '../../src/js/audio/zip.js'
import { sha256Hex } from '../../src/js/audio/sha256.js'
import { exportProjectArchive, importProjectArchive, archiveFileName, ARCHIVE_LIMITS, decodeArchiveAsset } from '../../src/js/daw/archive.js'
import { ProjectHistory, cloneProjectMetadata } from '../../src/js/daw/history.js'
import { getClipGainRegionSegments } from '../../src/js/daw/gain-regions.js'

const encode = value => new TextEncoder().encode(value)
const decode = value => new TextDecoder().decode(value)
const copy = value => JSON.parse(JSON.stringify(value))
function bufferFor(asset) {
  const length = asset.length ?? Math.round(asset.duration * asset.sampleRate)
  return { sampleRate: asset.sampleRate, numberOfChannels: asset.channels, length,
    duration: length / asset.sampleRate, getChannelData: () => new Float32Array(length) }
}
const decodeAsset = async (_bytes, asset) => bufferFor(asset)

async function fixture() {
  const originals = [encode('original one media bytes'), encode('original two different media bytes')]
  const assets = await Promise.all(originals.map(async (bytes, index) => ({ id: `asset-${index}`, name: '同名 vocal.mp3',
    hash: await sha256Hex(bytes), duration: 2, length: 16000, sampleRate: 8000, channels: index + 1 })))
  const project = createProject({ id: 'portable-test', name: '全工程 / song', tempo: 87, masterGainDb: -3, sampleRate: 44100, assets,
    tracks: [{ id: 'track-one', name: '聲音 A', gainDb: -5, pan: -.3, mute: false, solo: true, clips: [
      { id: 'clip-a', assetId: assets[0].id, name: 'trimmed tail', atSeconds: 12, offsetSeconds: .5, durationSeconds: 1,
        gainDb: -2, fadeInSeconds: .2, fadeOutSeconds: .3, gainEnvelope: [{ timeSeconds: 0, value: .4 }, { timeSeconds: .7, value: 1 }, { timeSeconds: 1, value: 0 }] },
      { id: 'clip-b', assetId: assets[1].id, name: 'overlap', atSeconds: 12.5, offsetSeconds: 0, durationSeconds: 1.5,
        gainDb: 1, fadeInSeconds: 0, fadeOutSeconds: .1 },
    ] }, { id: 'track-two', name: 'Muted duplicate', gainDb: 2, pan: .7, mute: true, solo: false, clips: [] }] })
  const files = new Map(originals.map((bytes, index) => [assets[index].id, new File([bytes], '同名 vocal.mp3', { type: 'audio/mpeg', lastModified: 1720000000000 + index })]))
  return { project, files, originals, archive: await exportProjectArchive(project, files) }
}

async function entriesOf(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const files = []
  let position = 0
  while (view.getUint32(position, true) === 0x04034b50) {
    const size = view.getUint32(position + 18, true)
    const filenameLength = view.getUint16(position + 26, true)
    const extra = view.getUint16(position + 28, true)
    const dataStart = position + 30 + filenameLength + extra
    files.push({ name: decode(bytes.subarray(position + 30, position + 30 + filenameLength)), data: bytes.slice(dataStart, dataStart + size) })
    position = dataStart + size
  }
  return files
}
const zip = entries => new Blob([createZip(entries)], { type: 'application/zip' })
async function editManifest(archive, fn) {
  const entries = await entriesOf(archive)
  const manifest = JSON.parse(decode(entries[0].data))
  fn(manifest)
  entries[0].data = encode(JSON.stringify(manifest))
  return zip(entries)
}
async function editZip(archive, fn) {
  const bytes = new Uint8Array(await archive.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const end = bytes.length - 22
  const central = view.getUint32(end + 16, true)
  fn(view, bytes, { end, central })
  return new Blob([bytes])
}

describe('portable DAW archive', () => {
  it('is standard store ZIP containing the complete metadata and actual unmodified originals', async () => {
    const { project, files, archive, originals } = await fixture()
    const entries = await entriesOf(archive)
    expect(archive.type).toBe('application/zip')
    expect(entries.map(entry => entry.name)).toEqual(['manifest.json', 'media/0000.bin', 'media/0001.bin'])
    expect(entries[1].data).toEqual(originals[0])
    expect(entries[2].data).toEqual(originals[1])
    const result = await importProjectArchive(archive, { decodeAsset })
    expect(result.project).toEqual(project)
    expect(result.project).not.toBe(project)
    expect(result.buffers.size).toBe(2)
    for (const asset of project.assets) {
      expect(result.files.get(asset.id).name).toBe(files.get(asset.id).name)
      expect(result.files.get(asset.id).lastModified).toBe(files.get(asset.id).lastModified)
      expect(new Uint8Array(await result.files.get(asset.id).arrayBuffer())).toEqual(new Uint8Array(await files.get(asset.id).arrayBuffer()))
    }
    expect(await entriesOf(await exportProjectArchive(result.project, result.files))).toEqual(entries)
  })

  it('roundtrips split and trimmed volume automation alongside fades and original media', async () => {
    let { project, files, originals } = await fixture()
    project = applyCommand(project, { type: 'clip.automation.add', trackId: 'track-one', clipId: 'clip-a', point: { timeSeconds: .5, value: 1.8 } })
    project = applyCommand(project, { type: 'clip.split', trackId: 'track-one', clipId: 'clip-a', atSeconds: 12.6, newId: 'tail' })
    project = applyCommand(project, { type: 'clip.trim', trackId: 'track-one', clipId: 'clip-a', startSeconds: 12.1, endSeconds: 12.5 })
    const archive = await exportProjectArchive(project, files)
    const result = await importProjectArchive(archive, { decodeAsset })
    expect(result.project).toEqual(project)
    expect(result.project.tracks[0].clips[0]).toHaveProperty('gainEnvelope')
    expect(result.project.tracks[0].clips[0].volumeAutomation[0].value).toBeCloseTo(1.16)
    expect((await entriesOf(archive))[1].data).toEqual(originals[0])
    expect(await entriesOf(await exportProjectArchive(result.project, result.files))).toEqual(await entriesOf(archive))
  })

  it('snapshots edits before awaiting and never mutates the live project to add hashes', async () => {
    const { project, files } = await fixture()
    delete project.assets[0].hash
    const before = copy(project)
    const pending = exportProjectArchive(project, files)
    project.tracks[0].name = 'later edit'
    const result = await importProjectArchive(await pending, { decodeAsset })
    expect(result.project.tracks[0].name).toBe(before.tracks[0].name)
    expect(result.project.assets[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect(project.assets[0].hash).toBeUndefined()
  })

  it('restores editable gain regions, exact cropped boundaries and unchanged original files', async () => {
    let { project, files, originals } = await fixture()
    project = applyCommand(project, { type: 'clip.gainRegion.addMany', trackId: 'track-one', clipId: 'clip-a', regions: [
      { id: 'first-line', label: '一句', startSeconds: .1, endSeconds: .9, gain: 0, fadeInSeconds: .3, fadeOutSeconds: .3 },
      { id: 'second-line', label: '第二句', startSeconds: .6, endSeconds: 1, gain: .4, fadeInSeconds: .1, fadeOutSeconds: .1 },
    ] })
    project = applyCommand(project, { type: 'clip.automation.add', trackId: 'track-one', clipId: 'clip-a', point: { timeSeconds: .5, value: 1.8 } })
    project = applyCommand(project, { type: 'clip.split', trackId: 'track-one', clipId: 'clip-a', atSeconds: 12.75, newId: 'tail' })
    project = applyCommand(project, { type: 'clip.trim', trackId: 'track-one', clipId: 'clip-a', startSeconds: 12.2, endSeconds: 12.7 })
    const archive = await exportProjectArchive(project, files)
    const restored = await importProjectArchive(archive, { decodeAsset })
    expect(restored.project).toEqual(project)
    for (const [index, clip] of project.tracks[0].clips.entries()) expect(getClipGainRegionSegments(restored.project.tracks[0].clips[index])).toEqual(getClipGainRegionSegments(clip))
    const changed = applyCommand(restored.project, { type: 'clip.gainRegion.update', trackId: 'track-one', clipId: 'clip-a', regionId: 'first-line', patch: { gain: .5 } })
    expect(changed.tracks[0].clips[0].gainRegions[0].attenuationEnvelope).toEqual(project.tracks[0].clips[0].gainRegions[0].attenuationEnvelope)
    const removed = applyCommand(changed, { type: 'clip.gainRegion.remove', trackId: 'track-one', clipId: 'clip-a', regionId: 'first-line' })
    expect(removed.tracks[0].clips[0].gainRegions.map(region => region.id)).toEqual(['second-line'])
    expect((await entriesOf(archive))[1].data).toEqual(originals[0])
    expect((await entriesOf(archive))[2].data).toEqual(originals[1])
    expect(await entriesOf(await exportProjectArchive(restored.project, restored.files))).toEqual(await entriesOf(archive))
  })

  it('restores an empty project and reports completion', async () => {
    const project = createProject()
    const progress = vi.fn()
    const result = await importProjectArchive(await exportProjectArchive(project, new Map()), { onProgress: progress })
    expect(result.project).toEqual(project)
    expect(result.files.size).toBe(0)
    expect(progress).toHaveBeenLastCalledWith({ phase: 'complete', completed: 0, total: 0 })
  })

  it('keeps assets no longer referenced by a clip, making removed clips restorable in the current page', async () => {
    const { project, files } = await fixture()
    const next = applyCommand(project, { type: 'track.remove', trackId: 'track-one' })
    const result = await importProjectArchive(await exportProjectArchive(next, files), { decodeAsset })
    expect(result.files.size).toBe(2)
    expect(result.project.tracks).toHaveLength(1)
  })

  it('exports only explicitly referenced original identities, not unrelated or historical file map entries', async () => {
    const { project, files } = await fixture()
    files.set('unrelated', new File(['private unrelated recording'], 'private.wav'))
    const result = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset })
    expect([...result.files.keys()]).toEqual(project.assets.map(asset => asset.id))
  })

  it('requires original media and rejects replacement media even if the name matches', async () => {
    const { project, files } = await fixture()
    files.delete('asset-0')
    await expect(exportProjectArchive(project, files)).rejects.toThrow(/missing/)
    files.set('asset-0', new File(['wrong recording'], '同名 vocal.mp3'))
    await expect(exportProjectArchive(project, files)).rejects.toThrow(/fingerprint/)
  })

  it('rejects over-limit files before allocating/reading them', async () => {
    const { project, files } = await fixture()
    const arrayBuffer = vi.fn()
    files.set('asset-0', { size: ARCHIVE_LIMITS.assetBytes + 1, slice() {}, arrayBuffer })
    await expect(exportProjectArchive(project, files)).rejects.toThrow(/64 MiB/)
    await expect(importProjectArchive({ size: ARCHIVE_LIMITS.archiveBytes + 1, slice() {}, arrayBuffer })).rejects.toThrow(/256 MiB/)
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('reserves memory for the old project before transactional decode', async () => {
    const { archive } = await fixture()
    const decoder = vi.fn(decodeAsset)
    await expect(importProjectArchive(archive, { decodeAsset: decoder, retainedBytes: ARCHIVE_LIMITS.workingBytes })).rejects.toThrow(/working memory/)
    expect(decoder).not.toHaveBeenCalled()
  })

  it('publishes its reservation before reading source entries and respects refusal', async () => {
    const { archive, originals } = await fixture(), reads = [], decoder = vi.fn(decodeAsset)
    const tracked = { size: archive.size, arrayBuffer: () => archive.arrayBuffer(), slice(start, end, type) { reads.push(end - start); return archive.slice(start, end, type) } }
    const budget = vi.fn(bytes => { expect(bytes).toBeGreaterThan(archive.size); throw new Error('reservation refused') })
    await expect(importProjectArchive(tracked, { decodeAsset: decoder, onMemoryBudget: budget })).rejects.toThrow('reservation refused')
    expect(budget).toHaveBeenCalledTimes(1); expect(decoder).not.toHaveBeenCalled()
    for (const bytes of originals) expect(reads).not.toContain(bytes.length)
  })

  it('verifies every source hash before calling the decoder', async () => {
    const { archive } = await fixture()
    const entries = await entriesOf(archive)
    entries[2].data[0] ^= 1 // createZip recomputes CRC; SHA still detects the substitution.
    const decoder = vi.fn(decodeAsset)
    await expect(importProjectArchive(zip(entries), { decodeAsset: decoder })).rejects.toThrow(/SHA-256/)
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each([
    ['sample rate', asset => ({ ...bufferFor(asset), sampleRate: 48000 })],
    ['channel count', asset => ({ ...bufferFor(asset), numberOfChannels: 7 })],
    ['frame count', asset => ({ ...bufferFor(asset), length: asset.length + 1 })],
    ['duration', asset => ({ ...bufferFor(asset), duration: asset.duration + 1 })],
    ['unreadable PCM', asset => ({ ...bufferFor(asset), getChannelData: null })],
    ['invalid PCM length', asset => ({ ...bufferFor(asset), getChannelData: () => new Float32Array(3) })],
    ['non-finite PCM', asset => ({ ...bufferFor(asset), getChannelData: () => { const pcm = new Float32Array(asset.length); pcm[1] = NaN; return pcm } })],
  ])('rejects a decoded %s mismatch without changing current state', async (_label, wrongBuffer) => {
    const { project, archive, files } = await fixture()
    const current = { project, files, buffers: new Map() }
    const original = copy(project)
    await expect(importProjectArchive(archive, { decodeAsset: async (_bytes, asset) => wrongBuffer(asset) }).then(result => Object.assign(current, result))).rejects.toThrow(/decoded audio/)
    expect(current.project).toBe(project)
    expect(current.project).toEqual(original)
    expect(current.files).toBe(files)
    expect(current.buffers.size).toBe(0)
  })

  it('does not return a partial restore when the second decoder fails', async () => {
    const { archive } = await fixture()
    const decoder = vi.fn(async (_bytes, asset) => {
      if (asset.id === 'asset-1') throw new Error('Unsupported media codec')
      return bufferFor(asset)
    })
    await expect(importProjectArchive(archive, { decodeAsset: decoder })).rejects.toThrow(/Unsupported media codec/)
    expect(decoder).toHaveBeenCalledTimes(2)
  })

  it('rejects early cancellation of both save and restore', async () => {
    const { project, files, archive } = await fixture()
    const controller = new AbortController()
    controller.abort()
    await expect(exportProjectArchive(project, files, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    await expect(importProjectArchive(archive, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
  })

  it('discards a decoder that settles after cancellation and does not decode later files', async () => {
    const { archive } = await fixture()
    const controller = new AbortController()
    const decoder = vi.fn(async (_bytes, asset) => { controller.abort(); return bufferFor(asset) })
    await expect(importProjectArchive(archive, { decodeAsset: decoder, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(decoder).toHaveBeenCalledTimes(1)
  })

  it('honors cancellation from progress callbacks, including the final callback', async () => {
    const { project, files, archive } = await fixture()
    for (const operation of ['export', 'import']) {
      const controller = new AbortController()
      const options = { decodeAsset, signal: controller.signal, onProgress: ({ phase }) => { if (phase === 'complete') controller.abort() } }
      await expect(operation === 'export' ? exportProjectArchive(project, files, options) : importProjectArchive(archive, options)).rejects.toHaveProperty('name', 'AbortError')
    }
  })

  it('decodes at the recorded rate rather than the playback device rate', async () => {
    const seen = []
    const Original = globalThis.OfflineAudioContext
    const output = bufferFor({ sampleRate: 44100, channels: 1, length: 441, duration: .01 })
    globalThis.OfflineAudioContext = class {
      constructor(...args) { seen.push(args) }
      decodeAudioData(bytes) { expect(bytes.byteLength).toBe(3); return Promise.resolve(output) }
    }
    try {
      expect(await decodeArchiveAsset(new ArrayBuffer(3), { sampleRate: 44100, channels: 1 })).toBe(output)
      expect(seen).toEqual([[1, 1, 44100]])
    } finally { globalThis.OfflineAudioContext = Original }
  })

  it('uses a filesystem-safe descriptive archive filename', () => {
    expect(archiveFileName({ name: '../demo:*?' })).toBe('.._demo___.waveforge.zip')
    expect(archiveFileName({ name: '...' })).toBe('WaveForge project.waveforge.zip')
    expect(archiveFileName({ name: '中文歌名' })).toBe('中文歌名.waveforge.zip')
  })

  it('preserves valid uppercase hash spelling while comparing its original bytes securely', async () => {
    const { project, files } = await fixture()
    project.assets[0].hash = project.assets[0].hash.toUpperCase()
    const result = await importProjectArchive(await exportProjectArchive(project, files), { decodeAsset })
    expect(result.project).toEqual(project)
  })

  it('preserves original filenames and timestamps even if the runtime only has Blob', async () => {
    const { archive } = await fixture()
    const OriginalFile = globalThis.File
    globalThis.File = undefined
    try {
      const result = await importProjectArchive(archive, { decodeAsset })
      expect(result.files.get('asset-0').name).toBe('同名 vocal.mp3')
      expect(result.files.get('asset-0').lastModified).toBe(1720000000000)
      expect(await entriesOf(await exportProjectArchive(result.project, result.files))).toEqual(await entriesOf(archive))
    } finally { globalThis.File = OriginalFile }
  })

  it('validates native WAV sample-rate metadata before export and after re-opening', async () => {
    const sampleRate = 8000
    const bytes = new Uint8Array(44 + sampleRate * 2)
    const view = new DataView(bytes.buffer)
    bytes.set(encode('RIFF'), 0); view.setUint32(4, bytes.length - 8, true); bytes.set(encode('WAVEfmt '), 8)
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    bytes.set(encode('data'), 36); view.setUint32(40, sampleRate * 2, true)
    const asset = { id: 'native-wav', name: 'native.wav', hash: '', duration: 1, length: sampleRate, channels: 1, sampleRate, sourceSampleRate: sampleRate }
    const project = createProject({ assets: [asset] })
    const files = new Map([[asset.id, new File([bytes], asset.name, { type: 'audio/wav' })]])
    const archive = await exportProjectArchive(project, files)
    const badMetadata = await editManifest(archive, manifest => { manifest.project.assets[0].sourceSampleRate = 44100 })
    const decoder = vi.fn(decodeAsset)
    await expect(importProjectArchive(badMetadata, { decodeAsset: decoder })).rejects.toThrow(/original sample rate/)
    expect(decoder).not.toHaveBeenCalled()
    asset.sourceSampleRate = 44100
    await expect(exportProjectArchive({ ...project, assets: [asset] }, files)).rejects.toThrow(/original sample rate/)
  })
})

describe('strict archive rejection', () => {
  it.each([
    r => { r.gain = 1.1 }, r => { r.startSeconds = -.1 }, r => { r.endSeconds = 2 },
    r => { r.label = 'a'.repeat(121) }, r => { r.transcript = { tokens: ['unbounded ASR data'] } },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: 1, value: 1 }] },
    r => { r.attenuationEnvelope = [{ timeSeconds: 0, value: 0 }, { timeSeconds: .8, value: -1 }] },
  ])('rejects malformed gain regions transactionally before any audio decode', async mutate => {
    const { project, archive, files } = await fixture(), before = copy(project), decoder = vi.fn(decodeAsset)
    const bad = await editManifest(archive, manifest => {
      const region = { id: 'line', startSeconds: .1, endSeconds: .9, gain: 0, fadeInSeconds: .1, fadeOutSeconds: .1 }
      mutate(region); manifest.project.tracks[0].clips[0].gainRegions = [region]
    })
    const current = { project, files, buffers: new Map() }
    await expect(importProjectArchive(bad, { decodeAsset: decoder }).then(restored => Object.assign(current, restored))).rejects.toThrow()
    expect(decoder).not.toHaveBeenCalled(); expect(current.project).toBe(project); expect(project).toEqual(before)
    expect(current.files).toBe(files); expect(current.buffers.size).toBe(0)
  })

  it.each([
    ['future archive version', manifest => { manifest.version = 2 }],
    ['future project schema', manifest => { manifest.project.schema = 'waveforge.project.v2' }],
    ['unexpected manifest fields', manifest => { manifest.downloadUrl = 'https://example.invalid' }],
    ['missing media', manifest => { manifest.media.pop() }],
    ['duplicate media identity', manifest => { manifest.media[1].assetId = manifest.media[0].assetId }],
    ['duplicate media path', manifest => { manifest.media[1].path = manifest.media[0].path }],
    ['incorrect size', manifest => { manifest.media[0].size++ }],
    ['different fingerprint', manifest => { manifest.media[0].sha256 = '0'.repeat(64) }],
    ['unsafe source name', manifest => { manifest.media[0].originalName = 'evil\u0000.wav' }],
    ['invalid output rate', manifest => { manifest.project.sampleRate = 123 }],
    ['invalid source rate', manifest => { manifest.project.assets[0].sampleRate = 1 }],
    ['missing clip source', manifest => { manifest.project.tracks[0].clips[0].assetId = 'not-there' }],
    ['invalid edits', manifest => { manifest.project.tracks[0].clips[0].offsetSeconds = -1 }],
    ['prototype field', manifest => { manifest.project = JSON.parse(JSON.stringify(manifest.project).replace('"schema":', '"__proto__":{},"schema":')) }],
  ])('rejects %s before decoding', async (_label, mutate) => {
    const { archive } = await fixture()
    const decoder = vi.fn(decodeAsset)
    await expect(importProjectArchive(await editManifest(archive, mutate), { decodeAsset: decoder })).rejects.toThrow()
    expect(decoder).not.toHaveBeenCalled()
  })

  it.each(['../escape.bin', '/absolute.bin', 'media/../escape.bin', 'media\\0000.bin', 'media/%2e%2e.bin', 'unexpected.txt'])('rejects unsafe or unlisted ZIP path %s', async path => {
    const { archive } = await fixture()
    const entries = await entriesOf(archive)
    entries[1].name = path
    await expect(importProjectArchive(zip(entries), { decodeAsset })).rejects.toThrow(/path/)
  })

  it('rejects duplicate paths, missing entries, and unreferenced hidden files', async () => {
    const { archive } = await fixture()
    const entries = await entriesOf(archive)
    await expect(importProjectArchive(zip([...entries, entries[1]]), { decodeAsset })).rejects.toThrow(/duplicate/)
    await expect(importProjectArchive(zip(entries.slice(0, -1)), { decodeAsset })).rejects.toThrow(/count/)
    await expect(importProjectArchive(zip([...entries, { name: 'media/0099.bin', data: encode('hidden') }]), { decodeAsset })).rejects.toThrow(/count/)
  })

  it.each([
    ['compressed ZIP bomb', (view, _bytes, { central }) => { view.setUint16(central + 10, 8, true); view.setUint32(central + 24, 0xffffffff, true) }],
    ['encrypted entry', (view, _bytes, { central }) => { view.setUint16(central + 8, 1, true) }],
    ['symlink', (view, _bytes, { central }) => { view.setUint32(central + 38, 0xa1ff0000, true) }],
    ['ZIP64 marker', (view, _bytes, { end }) => { view.setUint32(end + 16, 0xffffffff, true) }],
    ['too many files', (view, _bytes, { end }) => { view.setUint16(end + 10, 500, true) }],
    ['split archive', (view, _bytes, { end }) => { view.setUint16(end + 4, 1, true) }],
    ['mismatched local length', view => { view.setUint32(18, 9, true) }],
    ['local encryption flag', view => { view.setUint16(6, 1, true) }],
    ['overlapping local data', (view, _bytes, { central }) => { view.setUint32(central + 42, 1, true) }],
    ['trailing hidden ZIP record', (view, _bytes, { end }) => { view.setUint32(end + 12, 1, true) }],
    ['inconsistent local path', (_view, bytes) => { bytes[30] = 0x2e }],
    ['bad manifest CRC', (view, bytes) => { bytes[30 + view.getUint16(26, true) + 3] ^= 1 }],
  ])('rejects %s', async (_label, edit) => {
    const { archive } = await fixture()
    await expect(importProjectArchive(await editZip(archive, edit), { decodeAsset })).rejects.toThrow()
  })

  it('rejects truncated archives, empty archives, and malformed JSON', async () => {
    const { archive } = await fixture()
    await expect(importProjectArchive(archive.slice(0, archive.size - 1), { decodeAsset })).rejects.toThrow()
    await expect(importProjectArchive(new Blob(), { decodeAsset })).rejects.toThrow()
    const entries = await entriesOf(archive)
    entries[0].data = encode('{not-json}')
    await expect(importProjectArchive(zip(entries), { decodeAsset })).rejects.toThrow(/JSON/)
  })
})

describe('metadata-only bounded DAW history', () => {
  it('clones snapshots, undoes/redoes every edit, and truncates the redo branch', async () => {
    const { project } = await fixture()
    const history = new ProjectHistory(project)
    const next = applyCommand(project, { type: 'track.remove', trackId: 'track-one' })
    history.push(next)
    next.name = 'mutated outside history'
    const undo = history.undo()
    expect(undo).toEqual(project)
    undo.tracks[0].name = 'also mutated'
    expect(history.current.tracks[0].name).toBe(project.tracks[0].name)
    expect(history.redo().tracks).toHaveLength(1)
    history.undo()
    history.push(applyCommand(project, { type: 'project.update', patch: { tempo: 100 } }))
    expect(history.canRedo).toBe(false)
    expect(history.redo()).toBeNull()
  })

  it('retains asset references from both undo and redo states until pruning/reset', async () => {
    const { project } = await fixture()
    const history = new ProjectHistory(project, { limit: 2 })
    const empty = createProject()
    history.push(empty)
    expect(history.retainedAssetIds()).toEqual(new Set(['asset-0', 'asset-1']))
    history.undo()
    expect(history.retainedAssetIds()).toEqual(new Set(['asset-0', 'asset-1']))
    history.redo()
    history.push(applyCommand(empty, { type: 'project.update', patch: { tempo: 99 } }))
    expect(history.retainedAssetIds().size).toBe(0)
    history.reset(project)
    expect(history.length).toBe(1)
    expect(history.canUndo).toBe(false)
    history.reset()
    expect(history.current).toBeNull()
    expect(history.retainedAssetIds().size).toBe(0)
  })

  it('bounds both snapshot count and total UTF-8 metadata bytes', () => {
    const project = createProject({ id: 'one' })
    const oneSize = new TextEncoder().encode(JSON.stringify(project)).length
    const history = new ProjectHistory(project, { limit: 3, maxBytes: oneSize * 2 + 10 })
    for (let index = 0; index < 10; index++) history.push({ ...project, tempo: 120 + index })
    expect(history.length).toBeLessThanOrEqual(2)
    expect(history.bytes).toBeLessThanOrEqual(oneSize * 2 + 10)
    expect(() => history.push({ ...project, name: '長'.repeat(256) })).toThrow(/budget/)
    expect(history.current.tempo).toBe(129)
    expect(() => new ProjectHistory(project, { limit: 0 })).toThrow()
    expect(() => new ProjectHistory(project, { maxBytes: 0 })).toThrow()
  })

  it('deduplicates equal snapshots and rejects audio/runtime data instead of silently serializing it', () => {
    const project = createProject()
    const history = new ProjectHistory(project)
    history.push(copy(project))
    expect(history.length).toBe(1)
    for (const extra of [new Blob(['source']), new Float32Array(2), new Map(), new Date(), undefined, Infinity]) {
      expect(() => history.push({ ...project, extra })).toThrow()
      expect(history.length).toBe(1)
    }
    const circular = { ...project }; circular.circular = circular
    expect(() => cloneProjectMetadata(circular)).toThrow()
    expect(() => history.reset({ ...project, sampleRate: -1 })).toThrow()
    expect(history.current).toEqual(project)
  })
})
