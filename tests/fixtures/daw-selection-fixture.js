/** Deterministic, synthetic-only archive. No copyrighted recordings or uploads. */
import { createHash } from 'node:crypto'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { applyCommand, createProject } from '../../src/js/daw/project.js'
import { exportProjectArchive } from '../../src/js/daw/archive.js'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const SELECTION_RANGE = { startSeconds: .312345, endSeconds: 6.543217 }
export const PROJECT_SECONDS = 7

export async function selectionFixture(sampleRate = 48000) {
  const originals = new Map(), files = new Map(), assets = []
  for (const [id, rate, seconds, frequency] of [
    ['source-44', 44100, 3.5, 173], ['source-96', 96000, 2.5, 281],
  ]) {
    const length = Math.round(rate * seconds)
    const pcm = Array.from({ length: 2 }, (_, channel) => Float32Array.from({ length }, (_, frame) => {
      const t = frame / rate
      return channel
        ? -.02 + .065 * Math.sin(2 * Math.PI * (frequency * 1.33 * t + 7 * t * t))
        : .03 + .085 * Math.sin(2 * Math.PI * (frequency * t + 11 * t * t)) + .015 * Math.cos(2 * Math.PI * 137 * t)
    }))
    const bytes = Buffer.from(encodeWAV(pcm, rate, 24)), name = `${id}-synthetic.wav`
    originals.set(id, bytes); files.set(id, new File([bytes], name, { type: 'audio/wav', lastModified: 1 }))
    assets.push({ id, name, hash: sha256(bytes), sampleRate: rate, channels: 2, length, duration: seconds })
  }
  const clip = (id, assetId, atSeconds, offsetSeconds, durationSeconds, extra = {}) => ({
    id, assetId, name: id, atSeconds, offsetSeconds, durationSeconds,
    gainDb: -1, fadeInSeconds: .08, fadeOutSeconds: .15, ...extra,
  })
  const track = (id, pan, clips) => ({ id, name: id, gainDb: -2, pan, mute: false, solo: false, clips })
  let project = createProject({ id: `selection-native-${sampleRate}`, name: 'Synthetic range proof', sampleRate, tempo: 120,
    assets, tracks: [
      track('overlap-track', -.15, [
        clip('head-44', 'source-44', .125, .25, 2.5, { volumeAutomation: [
          { timeSeconds: 0, value: 1 }, { timeSeconds: .4, value: .6 },
          { timeSeconds: 1.2, value: .9 }, { timeSeconds: 2.5, value: .3 },
        ] }),
        clip('overlap-96', 'source-96', 1, .125, 1.4, { gainDb: -4 }),
      ]),
      track('tail-track', .2, [
        clip('middle-44', 'source-44', 3.125, 1, 1),
        clip('tail-96', 'source-96', 4.75, .1, 2.25, { volumeAutomation: [
          { timeSeconds: 0, value: .7 }, { timeSeconds: .9, value: 1.1 }, { timeSeconds: 2.25, value: .5 },
        ] }),
      ]),
    ],
  })
  for (const [trackId, clipId, region] of [
    ['overlap-track', 'head-44', { id: 'head-attenuation', startSeconds: .55, endSeconds: 1.45, gain: .25 }],
    ['tail-track', 'tail-96', { id: 'tail-mute', startSeconds: .7, endSeconds: 1.1, gain: 0 }],
  ]) project = applyCommand(project, { type: 'clip.gainRegion.add', trackId, clipId, region })
  return { project, originals, bytes: Buffer.from(await (await exportProjectArchive(project, files)).arrayBuffer()) }
}

/** Parse stored ZIP entries independently; archive import remains real app code. */
export function readSelectionArchive(bytes) {
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (bytes.readUInt16LE(offset + 8) !== 0) throw new Error('Expected an uncompressed WaveForge ZIP')
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26)
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28)
    entries.set(bytes.subarray(offset + 30, offset + 30 + nameLength).toString(), bytes.subarray(start, start + size))
    offset = start + size
  }
  if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Missing ZIP central directory')
  const manifest = JSON.parse(entries.get('manifest.json').toString())
  return { project: manifest.project, source: id => entries.get(manifest.media.find(item => item.assetId === id).path) }
}

/** RIFF reader accepts additional chunks; expected frame indices do not call app code. */
export function readSelectionWav(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected RIFF WAVE')
  let format, data
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (name === 'fmt ') format = { tag: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
      rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }
    if (name === 'data') data = bytes.subarray(start, start + size)
    offset = start + size + size % 2
  }
  if (!format || !data) throw new Error('WAV is missing format/data')
  const frameBytes = format.channels * format.bits / 8
  if (data.length % frameBytes) throw new Error('WAV has a partial frame')
  return { ...format, data, frameBytes, frames: data.length / frameBytes }
}
