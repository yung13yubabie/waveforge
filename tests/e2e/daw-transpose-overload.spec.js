/** Real Worker/WASM and native Web Audio overload recovery. Synthetic audio
 * only; native observers forward operations unchanged. This is functional
 * playback-scheduling evidence, not an audible/perceptual listening test.
 * Observers retain strong buffer references to prove PCM identity, so this
 * suite cannot establish garbage collection or absence of audio leaks. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const field = async (page, name, value) => {
  await page.locator(`#daw-${name}`).fill(String(value))
  await page.locator(`#daw-${name}`).dispatchEvent('change')
}
async function openDetails(page, name) {
  const details = page.locator(`#daw-${name}`)
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click()
}
async function download(page, name) {
  const pending = page.waitForEvent('download')
  await action(page, name).click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return readFile(await item.path())
}
function archive(bytes) {
  const entries = new Map()
  let offset = 0
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    expect(bytes.readUInt16LE(offset + 8)).toBe(0)
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26)
    const start = offset + 30 + nameLength + bytes.readUInt16LE(offset + 28)
    entries.set(bytes.subarray(offset + 30, offset + 30 + nameLength).toString(), bytes.subarray(start, start + size))
    offset = start + size
  }
  expect(bytes.readUInt32LE(offset)).toBe(0x02014b50)
  const manifest = JSON.parse(entries.get('manifest.json').toString())
  return { project: manifest.project,
    source: id => entries.get(manifest.media.find(media => media.assetId === id).path) }
}
function wavData(bytes) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
  let format, data
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (name === 'fmt ') format = { tag: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }
    if (name === 'data') data = bytes.subarray(start, start + size)
    offset = start + size + size % 2
  }
  expect(format).toEqual({ tag: 1, channels: 2, sampleRate: 44100, bits: 24 })
  expect(data).toBeTruthy()
  return data
}
async function observeNativeAudio(page) {
  await page.addInitScript(() => {
    const proof = window.__transposeOverloadProof = { inputs: [], results: [], mixes: [], playback: [] }
    const render = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) {
      return render.apply(this, args).then(buffer => { proof.mixes.push(buffer); return buffer })
    }
    const create = BaseAudioContext.prototype.createBufferSource
    BaseAudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args), start = source.start
      if (!(this instanceof OfflineAudioContext)) source.start = function (...startArgs) {
        proof.playback.push({ buffer: source.buffer, args: startArgs, rate: source.playbackRate.value, detune: source.detune.value })
        return start.apply(source, startArgs)
      }
      return source
    }
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget)
        if (!String(args[0]).includes('signalsmith-worker')) return worker
        const post = worker.postMessage
        worker.postMessage = function (message, ...rest) {
          if (message?.type === 'render') proof.inputs.push({ channels: message.channels.map(channel => channel.slice()), sampleRate: message.sampleRate, options: { ...message.options } })
          return post.call(worker, message, ...rest)
        }
        worker.addEventListener('message', ({ data }) => {
          if (data?.type === 'result') proof.results.push({ channels: data.result.channels.map(channel => channel.slice()), metadata: { ...data.result.metadata } })
        })
        return worker
      },
    })
  })
}
async function evidence(page) {
  return page.evaluate(async () => {
    const proof = window.__transposeOverloadProof
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const hashes = channels => Promise.all(channels.map(channel => hash(new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength))))
    const peak = buffer => {
      let value = 0
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) for (const sample of buffer.getChannelData(channel)) value = Math.max(value, Math.abs(sample))
      return value
    }
    const playback = proof.playback.at(-1)
    let playbackEvidence = null
    if (playback) {
      const buffer = playback.buffer, channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
      // Independent PCM24 data writer, not an import from application code.
      // Safe playback must be below unity, so no clipping is needed here.
      const bytes = new Uint8Array(buffer.length * channels.length * 3)
      let at = 0
      for (let frame = 0; frame < buffer.length; frame++) for (const channel of channels) {
        const sample = channel[frame], integer = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
        bytes[at++] = integer & 255; bytes[at++] = (integer >> 8) & 255; bytes[at++] = (integer >> 16) & 255
      }
      playbackEvidence = { native: buffer instanceof AudioBuffer, sampleRate: buffer.sampleRate, frames: buffer.length,
        channels: buffer.numberOfChannels, peak: peak(buffer), args: playback.args, rate: playback.rate, detune: playback.detune, pcm24Hash: await hash(bytes) }
    }
    return { inputs: await Promise.all(proof.inputs.map(async input => ({ sampleRate: input.sampleRate, options: input.options, hashes: await hashes(input.channels) }))),
      results: await Promise.all(proof.results.map(async result => ({ metadata: result.metadata, hashes: await hashes(result.channels), finite: result.channels.every(channel => channel.every(Number.isFinite)) }))),
      mixPeaks: proof.mixes.map(peak), playbackCount: proof.playback.length, playback: playbackEvidence }
  })
}

test('unsafe pending transpose can be cancelled and regenerated safely before Accept, with original recovery and export parity', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await observeNativeAudio(page)
  const sampleRate = 48000, frames = sampleRate * 2
  const channels = [220, 330].map(frequency => Float32Array.from({ length: frames }, (_, index) =>
    .14 * Math.sin(2 * Math.PI * frequency * index / sampleRate) + .025 * Math.sin(4 * Math.PI * frequency * index / sampleRate)))
  const originalFile = Buffer.from(encodeWAV(channels, sampleRate, 24))
  await page.goto('/'); await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles({ name: 'synthetic-transpose-overload.wav', mimeType: 'audio/wav', buffer: originalFile })
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await openDetails(page, 'fades-details'); await field(page, 'clip-gain', 12)
  await openDetails(page, 'output-settings'); await field(page, 'master-gain', 12)
  await page.locator('#daw-sample-rate').selectOption('44100')
  await page.locator('#daw-bit-depth').selectOption('24')
  await openDetails(page, 'transpose-details'); await field(page, 'transpose-semitones', 1)
  const before = archive(await download(page, 'save')), originalId = before.project.tracks[0].clips[0].assetId
  expect(before.source(originalId)).toEqual(originalFile)

  // Mixed gain, rather than an assumed DSP overshoot, makes this reliably unsafe.
  await action(page, 'transpose-render').click()
  await expect(page.locator('#daw-replacement-review')).toBeVisible({ timeout: 60_000 })
  await expect(action(page, 'replacement-preview')).toBeEnabled()
  await action(page, 'replacement-preview').click()
  await expect(page.locator('#daw-status')).toContainText('停止試聽')
  await expect(page.locator('#daw-status')).toContainText('取消並保留原音')
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  const refused = await evidence(page)
  expect(refused.inputs).toHaveLength(1); expect(refused.results).toHaveLength(1)
  expect(refused.results[0]).toMatchObject({ finite: true, metadata: { engine: 'signalsmith-stretch-1.3.2', semitones: 1, bypassed: false, outputGain: 1 } })
  expect(refused.mixPeaks.at(-1)).toBeGreaterThan(1)
  expect(refused.playbackCount).toBe(0)
  await expect(action(page, 'replacement-cancel')).toBeVisible(); await expect(action(page, 'replacement-cancel')).toBeEnabled()
  const afterRefusal = archive(await download(page, 'save'))
  expect(afterRefusal.project).toEqual(before.project); expect(afterRefusal.source(originalId)).toEqual(originalFile)
  await action(page, 'replacement-cancel').click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  expect(archive(await download(page, 'save')).project).toEqual(before.project)

  // Lower the mix explicitly while the original clip remains accepted.
  await field(page, 'master-gain', -12)
  const safeOriginal = archive(await download(page, 'save')), originalMix = await download(page, 'export')
  expect(safeOriginal.project.revision).toBeGreaterThan(before.project.revision)
  expect(safeOriginal.project).toEqual({ ...before.project, revision: safeOriginal.project.revision, masterGainDb: -12 })
  expect(safeOriginal.project.assets).toHaveLength(1); expect(safeOriginal.source(originalId)).toEqual(originalFile)
  await action(page, 'transpose-render').click()
  await expect(page.locator('#daw-replacement-review')).toBeVisible({ timeout: 60_000 })
  await expect(action(page, 'replacement-preview')).toBeEnabled()
  await action(page, 'replacement-preview').click()
  await expect(page.locator('#daw-status')).toContainText('B：正在試聽')
  const safe = await evidence(page)
  expect(safe.inputs).toHaveLength(2); expect(safe.results).toHaveLength(2)
  expect(safe.inputs[1].hashes).toEqual(safe.inputs[0].hashes)
  expect(safe.results[1].hashes).toEqual(safe.results[0].hashes)
  expect(safe.results[1].hashes).not.toEqual(safe.inputs[1].hashes)
  expect(safe.playbackCount).toBe(1)
  expect(safe.playback).toMatchObject({ native: true, sampleRate: 44100, frames: 88200, channels: 2, rate: 1, detune: 0, args: [0, 0, 2] })
  expect(safe.playback.peak).toBeGreaterThan(0); expect(safe.playback.peak).toBeLessThan(1)
  await action(page, 'stop').click()
  const stillOriginal = archive(await download(page, 'save'))
  expect(stillOriginal.project).toEqual(safeOriginal.project); expect(stillOriginal.source(originalId)).toEqual(originalFile)
  expect(await download(page, 'export')).toEqual(originalMix)

  await action(page, 'replacement-confirm').click()
  await expect(page.locator('#daw-replacement-review')).toBeHidden()
  const accepted = archive(await download(page, 'save')), acceptedMix = await download(page, 'export')
  expect(accepted.project.assets).toHaveLength(2)
  expect(accepted.project.tracks[0].clips[0].transpose.sourceAssetId).toBe(originalId)
  expect(accepted.source(originalId)).toEqual(originalFile)
  expect(sha256(wavData(acceptedMix))).toBe(safe.playback.pcm24Hash)
  expect(acceptedMix).not.toEqual(originalMix)
  await action(page, 'undo').click()
  expect(archive(await download(page, 'save')).project).toEqual(safeOriginal.project)
  expect(await download(page, 'export')).toEqual(originalMix)
  await action(page, 'redo').click()
  expect(archive(await download(page, 'save')).project).toEqual(accepted.project)
  expect(await download(page, 'export')).toEqual(acceptedMix)
  const final = await evidence(page)
  expect(final.inputs).toHaveLength(2); expect(final.results).toHaveLength(2)
  expect(final.playbackCount).toBe(1); expect(errors).toEqual([])
  const evidencePath = testInfo.outputPath('transpose-overload-recovery.json')
  await writeFile(evidencePath, JSON.stringify({
    before: before.project, safeOriginal: safeOriginal.project, accepted: accepted.project,
    originalFileSha256: sha256(originalFile), originalMixSha256: sha256(originalMix), acceptedMixSha256: sha256(acceptedMix),
    refused, safe, finalWorkerRequests: final.inputs.length,
  }, null, 2))
  await testInfo.attach('transpose-overload-recovery.json', { contentType: 'application/json', path: evidencePath })
})
