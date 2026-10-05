// Portable, local-only project archives. Standard ZIP method 0 (stored), with
// a strict intentionally small ZIP profile: no compression, encryption,
// descriptors, extra records, symlinks, ZIP64 or external paths.
// Format reference: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
// Blob slices avoid reading the entire archive into an additional ArrayBuffer.
import { crc32 } from '../audio/zip.js'
import { sha256Hex } from '../audio/sha256.js'
import { wavSampleRate } from '../audio/asset-decode.js'
import { cloneProjectMetadata } from './history.js'
import { decodeDawAsset } from './decode.js'

const MiB = 1024 * 1024
export const ARCHIVE_LIMITS = Object.freeze({
  archiveBytes: 256 * MiB,
  assetBytes: 64 * MiB,
  manifestBytes: MiB,
  assets: 64,
  decodedBytes: 256 * MiB,
  workingBytes: 512 * MiB,
})
const FORMAT = 'waveforge.archive'
const VERSION = 1
const MANIFEST = 'manifest.json'
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function checkAbort(signal) {
  if (signal?.aborted) throw new DOMException('Project operation cancelled', 'AbortError')
}

function report(options, phase, completed, total) {
  checkAbort(options.signal)
  options.onProgress?.({ phase, completed, total })
  checkAbort(options.signal)
}

function fail(message) { throw new Error(`Project archive: ${message}`) }
function requireValue(condition, message) { if (!condition) fail(message) }
function blobLike(value) { return value && Number.isSafeInteger(value.size) && value.size >= 0 && typeof value.slice === 'function' && typeof value.arrayBuffer === 'function' }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) }
function plainKeys(value, allowed) { requireValue(record(value) && Object.keys(value).every(key => allowed.includes(key)), 'unsupported manifest fields') }

async function readBytes(blob, start, length, signal) {
  checkAbort(signal)
  requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && start + length <= blob.size, 'truncated ZIP entry')
  const bytes = new Uint8Array(await blob.slice(start, start + length).arrayBuffer())
  checkAbort(signal)
  requireValue(bytes.length === length, 'incomplete file read')
  return bytes
}

function pathAllowed(path) {
  return path === MANIFEST || /^media\/[0-9]{4}\.bin$/.test(path)
}

function expectedDecodedBytes(project) {
  return project.assets.reduce((sum, asset) => sum + (asset.length ?? Math.round(asset.duration * asset.sampleRate)) * asset.channels * 4, 0)
}

function checkMemory(project, sourceBytes, largestAsset, retainedBytes = 0) {
  const decoded = expectedDecodedBytes(project)
  requireValue(Number.isSafeInteger(retainedBytes) && retainedBytes >= 0, 'invalid retained memory budget')
  requireValue(decoded <= ARCHIVE_LIMITS.decodedBytes, 'decoded audio exceeds the 256 MiB limit')
  // Reserve two transient original-file buffers for hashing/decoding. Existing
  // page assets may be supplied so a transactional replacement stays bounded.
  requireValue(retainedBytes + sourceBytes + decoded + largestAsset * 2 <= ARCHIVE_LIMITS.workingBytes, 'restore exceeds the 512 MiB working memory budget; close a large project first')
}

function zipHeaders(name, size, crc, offset) {
  const filename = encoder.encode(name)
  const local = new Uint8Array(30 + filename.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint16(12, 0x21, true) // 1980-01-01
  lv.setUint32(14, crc, true)
  lv.setUint32(18, size, true)
  lv.setUint32(22, size, true)
  lv.setUint16(26, filename.length, true)
  local.set(filename, 30)
  const central = new Uint8Array(46 + filename.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint16(14, 0x21, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, size, true)
  cv.setUint32(24, size, true)
  cv.setUint16(28, filename.length, true)
  cv.setUint32(42, offset, true)
  central.set(filename, 46)
  return { local, central }
}

function storedZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const headers = zipHeaders(entry.path, entry.blob.size, entry.crc, offset)
    parts.push(headers.local, entry.blob)
    central.push(headers.central)
    offset += headers.local.length + entry.blob.size
  }
  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0)
  const end = new Uint8Array(22)
  const view = new DataView(end.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, entries.length, true)
  view.setUint16(10, entries.length, true)
  view.setUint32(12, centralSize, true)
  view.setUint32(16, offset, true)
  requireValue(offset + centralSize + end.length <= ARCHIVE_LIMITS.archiveBytes, 'ZIP exceeds the 256 MiB limit')
  return new Blob([...parts, ...central, end], { type: 'application/zip' })
}

function checkSourceRate(bytes, asset) {
  const nativeRate = wavSampleRate(bytes.buffer)
  if (nativeRate !== null && asset.sourceSampleRate != null) {
    requireValue(nativeRate === asset.sourceSampleRate, `original sample rate does not match ${asset.name}`)
  }
}

/** Snapshot edits before awaiting. Assets must be immutable original Blobs. */
export async function exportProjectArchive(project, filesMap, options = {}) {
  checkAbort(options.signal)
  const snapshot = cloneProjectMetadata(project)
  requireValue(filesMap instanceof Map, 'original media map is missing')
  requireValue(snapshot.assets.length <= ARCHIVE_LIMITS.assets, 'too many original media files')
  const originals = snapshot.assets.map(asset => {
    const blob = filesMap.get(asset.id)
    requireValue(blobLike(blob), `original media is missing for ${asset.name}`)
    requireValue(blob.size > 0 && blob.size <= ARCHIVE_LIMITS.assetBytes, 'each original media file must be between 1 byte and 64 MiB')
    return blob
  })
  const sourceBytes = originals.reduce((sum, blob) => sum + blob.size, 0)
  requireValue(sourceBytes < ARCHIVE_LIMITS.archiveBytes, 'original media exceeds the 256 MiB archive limit')
  checkMemory(snapshot, sourceBytes, Math.max(0, ...originals.map(blob => blob.size)))
  const entries = []
  const media = []
  for (let index = 0; index < snapshot.assets.length; index++) {
    const asset = snapshot.assets[index]
    const blob = originals[index]
    const bytes = await readBytes(blob, 0, blob.size, options.signal)
    const hash = await sha256Hex(bytes)
    checkAbort(options.signal)
    requireValue(!asset.hash || asset.hash.toLowerCase() === hash, `original media fingerprint changed for ${asset.name}`)
    checkSourceRate(bytes, asset)
    if (!asset.hash) asset.hash = hash
    const path = `media/${String(index).padStart(4, '0')}.bin`
    const originalName = typeof blob.name === 'string' ? blob.name : asset.name
    requireValue(originalName.length > 0 && originalName.length <= 1024 && !/[\x00-\x1f\x7f]/.test(originalName), 'invalid original media filename')
    const type = typeof blob.type === 'string' ? blob.type : ''
    requireValue(type.length <= 255 && !/[\x00-\x1f\x7f]/.test(type), 'invalid original media type')
    media.push({ assetId: asset.id, path, size: blob.size, sha256: hash, originalName, type,
      lastModified: Number.isSafeInteger(blob.lastModified) && blob.lastModified >= 0 ? blob.lastModified : 0 })
    entries.push({ path, blob, crc: crc32(bytes) })
    report(options, 'hash', index + 1, snapshot.assets.length)
  }
  const manifest = encoder.encode(JSON.stringify({ format: FORMAT, version: VERSION, project: snapshot, media }))
  requireValue(manifest.length <= ARCHIVE_LIMITS.manifestBytes, 'manifest exceeds the 1 MiB limit')
  const archive = storedZip([{ path: MANIFEST, blob: new Blob([manifest]), crc: crc32(manifest) }, ...entries])
  report(options, 'complete', snapshot.assets.length, snapshot.assets.length)
  return archive
}

async function readDirectory(blob, options) {
  requireValue(blobLike(blob), 'select a .waveforge.zip file')
  requireValue(blob.size >= 22 && blob.size <= ARCHIVE_LIMITS.archiveBytes, 'ZIP must be no larger than 256 MiB')
  const end = await readBytes(blob, blob.size - 22, 22, options.signal)
  const ev = new DataView(end.buffer)
  requireValue(ev.getUint32(0, true) === 0x06054b50 && ev.getUint16(20, true) === 0, 'unsupported or truncated ZIP end record')
  const count = ev.getUint16(10, true)
  requireValue(count >= 1 && count <= ARCHIVE_LIMITS.assets + 1, 'invalid ZIP entry count')
  requireValue(ev.getUint16(4, true) === 0 && ev.getUint16(6, true) === 0 && ev.getUint16(8, true) === count, 'split ZIP archives are unsupported')
  const centralSize = ev.getUint32(12, true)
  const centralOffset = ev.getUint32(16, true)
  requireValue(centralSize <= count * (46 + 128) && centralOffset + centralSize === blob.size - 22, 'invalid central directory bounds')
  const bytes = await readBytes(blob, centralOffset, centralSize, options.signal)
  const view = new DataView(bytes.buffer)
  const entries = new Map()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    requireValue(cursor + 46 <= bytes.length && view.getUint32(cursor, true) === 0x02014b50, 'invalid central directory entry')
    const flags = view.getUint16(cursor + 8, true)
    const size = view.getUint32(cursor + 24, true)
    const filenameLength = view.getUint16(cursor + 28, true)
    const localOffset = view.getUint32(cursor + 42, true)
    requireValue(view.getUint16(cursor + 6, true) <= 20 && (flags === 0 || flags === 0x800), 'encrypted or advanced ZIP entries are unsupported')
    requireValue(view.getUint16(cursor + 10, true) === 0 && view.getUint32(cursor + 20, true) === size, 'only uncompressed WaveForge ZIP archives are supported')
    requireValue(view.getUint16(cursor + 30, true) === 0 && view.getUint16(cursor + 32, true) === 0 && view.getUint16(cursor + 34, true) === 0, 'ZIP extra records or split entries are unsupported')
    requireValue(view.getUint32(cursor + 38, true) === 0, 'ZIP links, directories or external attributes are unsupported')
    requireValue(filenameLength >= 1 && filenameLength <= 128 && cursor + 46 + filenameLength <= bytes.length, 'invalid ZIP path length')
    const path = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLength))
    requireValue(pathAllowed(path), 'unsafe or unexpected ZIP entry path')
    requireValue(!entries.has(path), 'duplicate ZIP entry path')
    requireValue(size > 0 && size <= (path === MANIFEST ? ARCHIVE_LIMITS.manifestBytes : ARCHIVE_LIMITS.assetBytes), 'ZIP entry exceeds its size limit')
    entries.set(path, { path, size, flags, localOffset, crc: view.getUint32(cursor + 16, true), filenameLength })
    cursor += 46 + filenameLength
  }
  requireValue(cursor === bytes.length && entries.has(MANIFEST), 'missing manifest or unlisted central records')
  const ordered = [...entries.values()].sort((a, b) => a.localOffset - b.localOffset)
  let expectedOffset = 0
  for (const entry of ordered) {
    requireValue(entry.localOffset === expectedOffset, 'overlapping, hidden or out-of-order local ZIP data')
    const header = await readBytes(blob, entry.localOffset, 30 + entry.filenameLength, options.signal)
    const lv = new DataView(header.buffer)
    requireValue(lv.getUint32(0, true) === 0x04034b50 && lv.getUint16(4, true) <= 20, 'invalid local ZIP header')
    requireValue(lv.getUint16(6, true) === entry.flags && lv.getUint16(8, true) === 0 && lv.getUint32(14, true) === entry.crc && lv.getUint32(18, true) === entry.size && lv.getUint32(22, true) === entry.size, 'local and central ZIP records disagree')
    requireValue(lv.getUint16(26, true) === entry.filenameLength && lv.getUint16(28, true) === 0 && decoder.decode(header.subarray(30)) === entry.path, 'local ZIP entry path mismatch')
    entry.dataOffset = entry.localOffset + header.length
    expectedOffset = entry.dataOffset + entry.size
    requireValue(expectedOffset <= centralOffset, 'ZIP entry overlaps its directory')
  }
  requireValue(expectedOffset === centralOffset && ordered[0].path === MANIFEST, 'hidden ZIP data or misplaced manifest')
  return entries
}

async function readEntry(blob, entry, signal) {
  const bytes = await readBytes(blob, entry.dataOffset, entry.size, signal)
  requireValue(crc32(bytes) === entry.crc, `CRC checksum mismatch for ${entry.path}`)
  return bytes
}

function validateManifest(manifest, entries) {
  plainKeys(manifest, ['format', 'version', 'project', 'media'])
  requireValue(manifest.format === FORMAT && manifest.version === VERSION, 'unsupported archive schema version')
  const project = cloneProjectMetadata(manifest.project)
  requireValue(Array.isArray(manifest.media) && manifest.media.length === project.assets.length && manifest.media.length <= ARCHIVE_LIMITS.assets && entries.size === manifest.media.length + 1, 'media count does not match project')
  const assets = new Map(project.assets.map(asset => [asset.id, asset]))
  const paths = new Set()
  const ids = new Set()
  for (const media of manifest.media) {
    plainKeys(media, ['assetId', 'path', 'size', 'sha256', 'originalName', 'type', 'lastModified'])
    const asset = assets.get(media.assetId)
    requireValue(asset && !ids.has(media.assetId), 'missing or duplicate media identity')
    requireValue(typeof media.path === 'string' && /^media\/[0-9]{4}\.bin$/.test(media.path) && !paths.has(media.path), 'invalid or duplicate media path')
    requireValue(Number.isSafeInteger(media.size) && media.size > 0 && media.size <= ARCHIVE_LIMITS.assetBytes && entries.get(media.path)?.size === media.size, 'missing media or file size mismatch')
    requireValue(typeof media.sha256 === 'string' && /^[a-f0-9]{64}$/.test(media.sha256) && typeof asset.hash === 'string' && asset.hash.toLowerCase() === media.sha256, 'media fingerprint does not match project')
    requireValue(typeof media.originalName === 'string' && media.originalName.length > 0 && media.originalName.length <= 1024 && !/[\x00-\x1f\x7f]/.test(media.originalName), 'invalid original filename')
    requireValue(typeof media.type === 'string' && media.type.length <= 255 && !/[\x00-\x1f\x7f]/.test(media.type), 'invalid media type')
    requireValue(Number.isSafeInteger(media.lastModified) && media.lastModified >= 0, 'invalid original file timestamp')
    paths.add(media.path)
    ids.add(media.assetId)
  }
  return project
}

/** Restore compressed sources at the saved decoding rate, regardless of device. */
export async function decodeArchiveAsset(bytes, asset, { signal } = {}) {
  return decodeDawAsset(bytes, asset, { signal })
}

/**
 * Transactional: receives no current state and does not change any external
 * store. Commit the returned maps/project together only after resolution.
 * The shared decoder rejects cancellation/timeouts immediately, but retains
 * its native slot until that uncancellable browser decode really settles.
 * `retainedBytes` includes old/undo audio on-page.
 */
export async function importProjectArchive(blob, options = {}) {
  checkAbort(options.signal)
  const entries = await readDirectory(blob, options)
  const manifestBytes = await readEntry(blob, entries.get(MANIFEST), options.signal)
  let manifest
  try { manifest = JSON.parse(decoder.decode(manifestBytes)) } catch { fail('manifest is not valid UTF-8 JSON') }
  const project = validateManifest(manifest, entries)
  checkMemory(project, blob.size, Math.max(0, ...manifest.media.map(media => media.size)), options.retainedBytes ?? 0)
  report(options, 'validate', 0, project.assets.length)
  const assets = new Map(project.assets.map(asset => [asset.id, asset]))
  const files = new Map()
  const buffers = new Map()
  // Verify every original before decoding any. Never relink by display name.
  for (const [index, media] of manifest.media.entries()) {
    const entry = entries.get(media.path)
    const bytes = await readEntry(blob, entry, options.signal)
    requireValue(await sha256Hex(bytes) === media.sha256, `SHA-256 fingerprint mismatch for ${media.originalName}`)
    checkAbort(options.signal)
    checkSourceRate(bytes, assets.get(media.assetId))
    const original = blob.slice(entry.dataOffset, entry.dataOffset + entry.size, media.type)
    const file = typeof globalThis.File === 'function'
      ? new File([original], media.originalName, { type: media.type, lastModified: media.lastModified })
      : Object.defineProperties(original, { name: { value: media.originalName }, lastModified: { value: media.lastModified } })
    files.set(media.assetId, file)
    report(options, 'hash', index + 1, manifest.media.length)
  }
  let decodedBytes = 0
  const decodeAsset = options.decodeAsset ?? decodeArchiveAsset
  requireValue(typeof decodeAsset === 'function', 'audio decoder is unavailable')
  for (const [index, media] of manifest.media.entries()) {
    checkAbort(options.signal)
    const asset = assets.get(media.assetId)
    const bytes = await readBytes(files.get(media.assetId), 0, media.size, options.signal)
    const buffer = await decodeAsset(bytes.buffer, { ...asset }, { signal: options.signal })
    checkAbort(options.signal)
    requireValue(buffer && typeof buffer.getChannelData === 'function' && Number.isInteger(buffer.length) && buffer.length > 0 && buffer.sampleRate === asset.sampleRate && buffer.numberOfChannels === asset.channels, `decoded audio format mismatch for ${asset.name}`)
    const expectedLength = asset.length ?? Math.round(asset.duration * asset.sampleRate)
    requireValue(buffer.length === expectedLength && Number.isFinite(buffer.duration) && Math.abs(buffer.duration - asset.duration) <= 1 / asset.sampleRate, `decoded audio duration mismatch for ${asset.name}`)
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const pcm = buffer.getChannelData(channel)
      requireValue(pcm instanceof Float32Array && pcm.length === buffer.length, `decoded audio PCM mismatch for ${asset.name}`)
      for (let sample = 0; sample < pcm.length; sample++) {
        if (!Number.isFinite(pcm[sample])) fail(`decoded audio contains invalid samples for ${asset.name}`)
      }
    }
    decodedBytes += buffer.length * buffer.numberOfChannels * 4
    requireValue(decodedBytes <= ARCHIVE_LIMITS.decodedBytes, 'decoded audio exceeds the 256 MiB limit')
    buffers.set(asset.id, buffer)
    report(options, 'decode', index + 1, manifest.media.length)
  }
  report(options, 'complete', project.assets.length, project.assets.length)
  return { project, files, buffers }
}

export function archiveFileName(project) {
  const name = String(project?.name || 'WaveForge project').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120)
  return `${name || 'WaveForge project'}.waveforge.zip`
}
