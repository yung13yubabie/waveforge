/** Genuine UI → Signalsmith worker → native Web Audio → downloaded ZIP/WAV.
 * Synthetic tones only. This suite is prepared for permitted browser CI; it
 * does not establish listening quality or browser success until actually run.
 * Observers below forward every native operation unchanged. No successful
 * worker, AudioBuffer, decoder, playback or OfflineAudioContext is mocked. */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

const action = (page, command) => page.locator(`[data-daw="${command}"]`)
const review = page => page.locator('#daw-replacement-review')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function attachEvidence(testInfo, name, evidence) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(evidence, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}
const field = async (page, name, value) => {
  await page.locator(`#daw-${name}`).fill(String(value))
  await page.locator(`#daw-${name}`).dispatchEvent('change')
}
async function openDetails(page, id) {
  if (!await page.locator(`#${id}`).evaluate(element => element.open)) await page.locator(`#${id} > summary`).click()
}
function toneFile(sampleRate = 48000, channels = 2, seconds = 2, suffix = '') {
  const pcm = Array.from({ length: channels }, (_, channel) => {
    const frequency = channel ? 330 : 220
    return Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, index) =>
      .14 * Math.sin(2 * Math.PI * frequency * index / sampleRate) +
      .025 * Math.sin(2 * Math.PI * frequency * 2 * index / sampleRate))
  })
  return { name: `synthetic-${sampleRate}-${channels}ch${suffix}.wav`, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV(pcm, sampleRate, 24)) }
}
async function download(page, command) {
  const pending = page.waitForEvent('download')
  await action(page, command).click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return readFile(await item.path())
}
function archive(zip) {
  const entries = new Map()
  let offset = 0
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    expect(zip.readUInt16LE(offset + 8)).toBe(0)
    const size = zip.readUInt32LE(offset + 18), nameLength = zip.readUInt16LE(offset + 26)
    const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28)
    entries.set(zip.subarray(offset + 30, offset + 30 + nameLength).toString(), zip.subarray(start, start + size))
    offset = start + size
  }
  expect(zip.readUInt32LE(offset)).toBe(0x02014b50)
  const manifest = JSON.parse(entries.get('manifest.json').toString())
  return { manifest, project: manifest.project, entries,
    source(assetId) { return entries.get(manifest.media.find(media => media.assetId === assetId).path) } }
}
function readWav(bytes) {
  expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
  expect(bytes.toString('ascii', 8, 12)).toBe('WAVE')
  let format, data
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8
    const name = bytes.toString('ascii', offset, offset + 4)
    if (name === 'fmt ') format = { tag: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2), rate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) }
    if (name === 'data') data = bytes.subarray(start, start + size)
    offset = start + size + size % 2
  }
  expect(format).toBeTruthy(); expect(data).toBeTruthy()
  const frameBytes = format.channels * format.bits / 8
  expect(data.length % frameBytes).toBe(0)
  return { ...format, data, frames: data.length / frameBytes }
}
function floatChannelHashes(bytes) {
  const wav = readWav(bytes)
  expect(wav.tag).toBe(3); expect(wav.bits).toBe(32)
  return Array.from({ length: wav.channels }, (_, channel) => {
    const pcm = Buffer.alloc(wav.frames * 4)
    for (let frame = 0; frame < wav.frames; frame++) wav.data.copy(pcm, frame * 4, (frame * wav.channels + channel) * 4, (frame * wav.channels + channel + 1) * 4)
    return digest(pcm)
  })
}
function magnitude(bytes, frequency, channel = 0) {
  const wav = readWav(bytes), first = Math.ceil(wav.rate * .25), last = Math.min(wav.frames, Math.floor(wav.rate))
  let real = 0, imaginary = 0
  for (let frame = first; frame < last; frame++) {
    const sample = wav.tag === 3 ? wav.data.readFloatLE((frame * wav.channels + channel) * 4) : wav.data.readIntLE((frame * wav.channels + channel) * 3, 3) / 8388608
    real += sample * Math.cos(2 * Math.PI * frequency * frame / wav.rate)
    imaginary += sample * Math.sin(2 * Math.PI * frequency * frame / wav.rate)
  }
  return Math.hypot(real, imaginary)
}

async function observeNativeAudio(page) {
  await page.addInitScript(() => {
    const records = window.__transposeProof = { requests: [], results: [], starts: [] }
    const ids = new WeakMap()
    let nextId = 1
    const create = BaseAudioContext.prototype.createBufferSource
    BaseAudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args), nativeStart = source.start
      const kind = this instanceof OfflineAudioContext ? 'offline' : 'realtime'
      source.start = function (...startArgs) {
        if (source.buffer) {
          if (!ids.has(source.buffer)) ids.set(source.buffer, nextId++)
          records.starts.push({ kind, buffer: source.buffer, bufferId: ids.get(source.buffer), args: startArgs,
            playbackRate: source.playbackRate.value, detune: source.detune.value })
        }
        return nativeStart.apply(source, startArgs)
      }
      return source
    }
    // This observer deliberately retains PCM/buffers for equality evidence;
    // it is not a heap/leak probe.
    // A transparent constructor observer retains real workers and their real
    // transfers. The result listener copies evidence before application use.
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget)
        if (!String(args[0]).includes('signalsmith-worker')) return worker
        const post = worker.postMessage
        worker.postMessage = function (message, ...rest) {
          if (message?.type === 'render') records.requests.push({ sampleRate: message.sampleRate,
            channels: message.channels.length, length: message.channels[0].length, options: { ...message.options },
            pcm: message.channels.map(channel => channel.slice()) })
          return post.call(worker, message, ...rest)
        }
        worker.addEventListener('message', ({ data }) => {
          if (data?.type === 'result') records.results.push({ sampleRate: data.result.sampleRate,
            channels: data.result.channels.map(channel => channel.slice()), metadata: { ...data.result.metadata } })
        })
        return worker
      },
    })
  })
}
async function nativeEvidence(page) {
  return page.evaluate(async () => {
    const hash = async pcm => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const records = window.__transposeProof
    return { requests: await Promise.all(records.requests.map(async request => ({ sampleRate: request.sampleRate,
      channels: request.channels, length: request.length, options: request.options, hashes: await Promise.all(request.pcm.map(hash)) }))),
      results: await Promise.all(records.results.map(async result => ({ sampleRate: result.sampleRate,
        length: result.channels[0].length, channels: result.channels.length, metadata: result.metadata,
        hashes: await Promise.all(result.channels.map(hash)) }))),
      starts: await Promise.all(records.starts.map(async record => ({ kind: record.kind, bufferId: record.bufferId,
        args: record.args, playbackRate: record.playbackRate, detune: record.detune,
        native: record.buffer instanceof AudioBuffer, sampleRate: record.buffer.sampleRate,
        length: record.buffer.length, channels: record.buffer.numberOfChannels,
        hashes: await Promise.all(Array.from({ length: record.buffer.numberOfChannels }, (_, channel) => hash(record.buffer.getChannelData(channel)))) }))),
    }
  })
}
async function playbackEvidence(page) {
  return page.evaluate(async () => {
    const record = window.__transposeProof.starts.filter(start => start.kind === 'realtime').at(-1)
    if (!record) throw new Error('No genuine realtime BufferSource.start observed')
    // Independent reference PCM24 writer, deliberately available against built
    // production assets without importing an application source module. This
    // observes the complete native playback buffer and does not change it.
    // Contract: RIFF PCM24, interleaved LE, no dither/normalization, round to the
    // positive 8388607 / negative 8388608 ranges with endpoint clipping.
    const channels = Array.from({ length: record.buffer.numberOfChannels }, (_, channel) => record.buffer.getChannelData(channel))
    const dataSize = record.buffer.length * channels.length * 3
    const bytes = new ArrayBuffer(44 + dataSize), view = new DataView(bytes)
    const tag = (offset, value) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)) }
    tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE')
    tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
    view.setUint16(22, channels.length, true); view.setUint32(24, record.buffer.sampleRate, true)
    view.setUint32(28, record.buffer.sampleRate * channels.length * 3, true)
    view.setUint16(32, channels.length * 3, true); view.setUint16(34, 24, true)
    tag(36, 'data'); view.setUint32(40, dataSize, true)
    let cursor = 44
    for (let frame = 0; frame < record.buffer.length; frame++) for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]))
      const integer = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
      view.setUint8(cursor++, integer & 255)
      view.setUint8(cursor++, (integer >> 8) & 255)
      view.setUint8(cursor++, (integer >> 16) & 255)
    }
    const wavSha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    return { bufferId: record.bufferId, sampleRate: record.buffer.sampleRate, length: record.buffer.length,
      args: record.args, playbackRate: record.playbackRate, detune: record.detune, wavSha256 }
  })
}
async function start(page, file = toneFile()) {
  await page.goto('/'); await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles(file)
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await openDetails(page, 'daw-transpose-details')
}
async function renderCandidate(page) {
  await action(page, 'transpose-render').click()
  await expect(review(page)).toBeVisible({ timeout: 60_000 })
  await expect(action(page, 'replacement-confirm')).toBeEnabled()
  await expect(page.locator('#daw-transpose-details #daw-replacement-review')).toBeVisible()
}
async function audition(page, command, status) {
  await action(page, command).click()
  await expect(page.locator('#daw-status')).toContainText(status)
  const result = await playbackEvidence(page)
  await action(page, 'stop').click()
  return result
}
async function restore(page, bytes, name) {
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#daw-project-file').setInputFiles({ name, mimeType: 'application/zip', buffer: bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(action(page, 'undo')).toBeDisabled()
}

for (const sampleRate of [44100, 48000, 96000]) for (const channels of [1, 2]) {
  test(`clip transpose preserves native ${sampleRate} Hz ${channels}ch PCM through A/B, Accept, Undo/Redo and ZIP`, async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    const errors = [], uploads = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (['POST', 'PUT', 'PATCH'].includes(request.method())) uploads.push(request.url()) })
    await observeNativeAudio(page)
    const original = toneFile(sampleRate, channels)
    await start(page, original)
    await page.locator('.daw-grid-settings > summary').click(); await page.locator('#daw-snap').uncheck()
    await page.locator('.daw-grid-settings > summary').click()
    await field(page, 'clip-at', .25); await action(page, 'move').click()
    // A fractional source frame at 44.1 kHz exercises the residual offset.
    await field(page, 'trim-start', .375); await field(page, 'trim-end', 1.625); await action(page, 'trim').click()
    await openDetails(page, 'daw-fades-details')
    await field(page, 'clip-gain', -3); await field(page, 'fade-in', .1); await field(page, 'fade-out', .15)
    await action(page, 'fades').click()
    await openDetails(page, 'daw-automation-details'); await action(page, 'automation-add').click()
    await field(page, 'automation-value', 55); await action(page, 'automation-apply').click()
    await openDetails(page, 'daw-output-settings')
    const mixRate = sampleRate === 48000 ? 44100 : 48000
    await page.locator('#daw-sample-rate').selectOption(String(mixRate))
    const beforeZip = await download(page, 'save'), before = archive(beforeZip)
    const originalMix = await download(page, 'export'), originalClip = before.project.tracks[0].clips[0]
    const semitones = channels === 1 ? 1 : -1
    const cents = sampleRate === 48000 ? (channels === 1 ? 100 : -100) : (channels === 1 ? 50 : -25)
    const amount = semitones + cents / 100
    await field(page, 'transpose-semitones', semitones)
    await field(page, 'transpose-cents', cents)
    await renderCandidate(page)
    expect(archive(await download(page, 'save')).project).toEqual(before.project)
    expect(await download(page, 'export')).toEqual(originalMix)

    const bPlayback = await audition(page, 'replacement-preview', 'B：正在試聽')
    const bProof = await nativeEvidence(page), generated = bProof.results[0]
    const first = Math.floor(originalClip.offsetSeconds * sampleRate)
    const expectedFrames = Math.ceil((originalClip.offsetSeconds + originalClip.durationSeconds) * sampleRate) - first
    expect(bProof.requests).toHaveLength(1); expect(bProof.results).toHaveLength(1)
    expect(generated).toMatchObject({ sampleRate, channels, length: expectedFrames,
      metadata: { engine: 'signalsmith-stretch-1.3.2', semitones: amount, inputSamples: expectedFrames,
        outputSamples: expectedFrames, outputGain: 1, timeRatio: 1, bypassed: false } })
    const bSource = bProof.starts.find(record => record.kind === 'offline' && record.hashes.join() === generated.hashes.join())
    expect(bSource).toMatchObject({ native: true, sampleRate, channels, length: expectedFrames, playbackRate: 1, detune: 0 })
    expect(bSource.args).toEqual([originalClip.atSeconds, originalClip.offsetSeconds - first / sampleRate, originalClip.durationSeconds])
    expect(bPlayback).toMatchObject({ sampleRate: mixRate, length: Math.ceil(1.625 * mixRate), playbackRate: 1, detune: 0 })
    expect(bPlayback.args.slice(1)).toEqual([originalClip.atSeconds, originalClip.durationSeconds])

    const aPlayback = await audition(page, 'replacement-original', 'A：正在試聽')
    expect(aPlayback.wavSha256).toBe(digest(originalMix))
    await action(page, 'begin').click()
    const ordinaryBeforeAccept = await audition(page, 'play', '正在播放目前專案混音')
    expect(ordinaryBeforeAccept.wavSha256).toBe(digest(originalMix))
    expect(await download(page, 'export')).toEqual(originalMix)
    expect(archive(await download(page, 'save')).project).toEqual(before.project)

    await action(page, 'replacement-confirm').click()
    await expect(review(page)).toBeHidden()
    await expect(action(page, 'transpose-render')).toBeFocused()
    // Acceptance may construct the ordinary mix later; it must never run DSP.
    expect((await nativeEvidence(page)).requests).toHaveLength(1)
    const acceptedMix = await download(page, 'export'), acceptedZip = await download(page, 'save'), accepted = archive(acceptedZip)
    expect(digest(acceptedMix)).toBe(bPlayback.wavSha256)
    expect(acceptedMix).not.toEqual(originalMix)
    expect(accepted.project.assets).toHaveLength(2)
    const acceptedClip = accepted.project.tracks[0].clips[0]
    const acceptedAsset = accepted.project.assets.find(asset => asset.id === acceptedClip.assetId)
    const lineage = { version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: originalClip.assetId,
      sourceOffsetSeconds: originalClip.offsetSeconds, sourceDurationSeconds: originalClip.durationSeconds,
      cropFirstFrame: first, cropLastFrame: first + expectedFrames,
      semitones, cents, formantSemitones: 0, formantCompensation: false }
    expect(acceptedClip).toEqual({ ...originalClip, assetId: acceptedAsset.id,
      offsetSeconds: originalClip.offsetSeconds - first / sampleRate, transpose: lineage })
    expect(accepted.project.tracks[0]).toEqual({ ...before.project.tracks[0], clips: [acceptedClip] })
    for (const key of ['sampleRate', 'tempo', 'masterGainDb', 'name']) expect(accepted.project[key]).toEqual(before.project[key])
    expect(acceptedAsset).toMatchObject({ sampleRate, sourceSampleRate: sampleRate, channels, length: expectedFrames, decodeBackend: 'generated-float32-wav' })
    const generatedFile = accepted.source(acceptedAsset.id)
    expect(readWav(generatedFile)).toMatchObject({ rate: sampleRate, channels, frames: expectedFrames, tag: 3, bits: 32 })
    expect(floatChannelHashes(generatedFile)).toEqual(generated.hashes)
    expect(acceptedAsset.hash).toBe(digest(generatedFile))
    expect(accepted.source(originalClip.assetId)).toEqual(original.buffer)
    expect(accepted.manifest.media.find(media => media.assetId === originalClip.assetId).originalName).toBe(original.name)
    // Numeric pitch evidence only, deliberately not a perceptual quality claim.
    for (let channel = 0; channel < channels; channel++) {
      const originalHz = channel ? 330 : 220, targetHz = originalHz * 2 ** (amount / 12)
      expect(magnitude(generatedFile, targetHz, channel)).toBeGreaterThan(4 * magnitude(generatedFile, originalHz, channel))
    }
    await action(page, 'begin').click()
    const acceptedPlayback = await audition(page, 'play', '正在播放目前專案混音')
    expect(acceptedPlayback.wavSha256).toBe(digest(acceptedMix))
    const acceptedProof = await nativeEvidence(page)
    const acceptedSources = acceptedProof.starts.filter(record => record.kind === 'offline' && record.hashes.join() === generated.hashes.join())
    expect(acceptedSources.length).toBeGreaterThanOrEqual(2)
    expect(new Set(acceptedSources.map(record => record.bufferId))).toEqual(new Set([bSource.bufferId]))
    expect(acceptedProof.requests).toHaveLength(1)

    await action(page, 'undo').click()
    expect(archive(await download(page, 'save')).project).toEqual(before.project)
    expect(await download(page, 'export')).toEqual(originalMix)
    await action(page, 'redo').click()
    expect(archive(await download(page, 'save')).project).toEqual(accepted.project)
    expect(await download(page, 'export')).toEqual(acceptedMix)
    const redoProof = await nativeEvidence(page)
    const redoSource = redoProof.starts.filter(record => record.kind === 'offline').at(-1)
    expect(redoSource.bufferId).toBe(bSource.bufferId)
    expect(redoSource.hashes).toEqual(generated.hashes)
    expect(redoProof.requests).toHaveLength(1)

    await restore(page, acceptedZip, 'accepted-transpose.waveforge.zip')
    expect(await download(page, 'export')).toEqual(acceptedMix)
    const restored = archive(await download(page, 'save'))
    expect(restored.project).toEqual(accepted.project)
    expect(restored.source(acceptedAsset.id)).toEqual(generatedFile)
    expect(restored.source(originalClip.assetId)).toEqual(original.buffer)
    const restoredProof = await nativeEvidence(page), restoredSource = restoredProof.starts.filter(record => record.kind === 'offline').at(-1)
    expect(restoredSource).toMatchObject({ native: true, sampleRate, channels, length: expectedFrames, hashes: generated.hashes })
    expect(restoredProof.requests).toHaveLength(1)
    // A separately saved original project remains a full source-recovery path.
    await restore(page, beforeZip, 'original-before-transpose.waveforge.zip')
    expect(await download(page, 'export')).toEqual(originalMix)
    expect(errors).toEqual([]); expect(uploads).toEqual([])
    await attachEvidence(testInfo, `transpose-native-${sampleRate}-${channels}ch.json`, { before: before.project, accepted: accepted.project,
      generated, bSource, bPlayback, aPlayback, ordinaryBeforeAccept, acceptedPlayback, restoredSource,
      originalFileSha256: digest(original.buffer), generatedFileSha256: digest(generatedFile), acceptedMixSha256: digest(acceptedMix), workerRequestCount: restoredProof.requests.length })
  })
}

test('a fresh ZIP reopen restores transpose settings, recovers the original in one action, and rerenders without pitch stacking', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await observeNativeAudio(page)
  const original = toneFile(44100, 2)
  await start(page, original)
  await page.locator('.daw-grid-settings > summary').click(); await page.locator('#daw-snap').uncheck()
  await page.locator('.daw-grid-settings > summary').click()
  await field(page, 'clip-at', .25); await action(page, 'move').click()
  await field(page, 'trim-start', .375); await field(page, 'trim-end', 1.625); await action(page, 'trim').click()
  await openDetails(page, 'daw-fades-details')
  await field(page, 'clip-gain', -3); await field(page, 'fade-in', .1); await field(page, 'fade-out', .15)
  await action(page, 'fades').click()
  await openDetails(page, 'daw-automation-details'); await action(page, 'automation-add').click()
  await field(page, 'automation-value', 60); await action(page, 'automation-apply').click()
  const before = archive(await download(page, 'save')), originalClip = before.project.tracks[0].clips[0]
  const originalMix = await download(page, 'export')
  await field(page, 'transpose-semitones', 1); await field(page, 'transpose-cents', 25)
  await openDetails(page, 'daw-transpose-timbre')
  await field(page, 'transpose-formants', -.5); await page.locator('#daw-transpose-compensation').check()
  await renderCandidate(page)
  const firstProof = await nativeEvidence(page)
  expect(firstProof.requests).toHaveLength(1); expect(firstProof.results).toHaveLength(1)
  await action(page, 'replacement-confirm').click()
  const processedMix = await download(page, 'export'), savedZip = await download(page, 'save'), saved = archive(savedZip)
  const processedClip = saved.project.tracks[0].clips[0]
  const firstFrame = Math.floor(originalClip.offsetSeconds * 44100)
  const lastFrame = Math.ceil((originalClip.offsetSeconds + originalClip.durationSeconds) * 44100)
  const lineage = { version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: originalClip.assetId,
    sourceOffsetSeconds: originalClip.offsetSeconds, sourceDurationSeconds: originalClip.durationSeconds,
    cropFirstFrame: firstFrame, cropLastFrame: lastFrame,
    semitones: 1, cents: 25, formantSemitones: -.5, formantCompensation: true }
  expect(processedClip.transpose).toEqual(lineage)
  expect(saved.source(originalClip.assetId)).toEqual(original.buffer)
  expect(processedMix).not.toEqual(originalMix)

  // Reload destroys the runtime, native buffers, worker records and Undo stack.
  // The only inputs now are the downloaded archive and the real browser decoder.
  await page.reload(); await page.locator('#tab-editor').click()
  await expect(page.locator('.daw-clip')).toHaveCount(0)
  await page.locator('#daw-project-file').setInputFiles({ name: 'persisted-transpose.waveforge.zip', mimeType: 'application/zip', buffer: savedZip })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(action(page, 'undo')).toBeDisabled()
  await page.locator('.daw-clip').click(); await openDetails(page, 'daw-transpose-details')
  await openDetails(page, 'daw-transpose-timbre')
  const expectRestoredControls = async () => {
    await expect(page.locator('#daw-transpose-semitones')).toHaveValue('1')
    await expect(page.locator('#daw-transpose-cents')).toHaveValue('25')
    await expect(page.locator('#daw-transpose-formants')).toHaveValue('-0.5')
    await expect(page.locator('#daw-transpose-compensation')).toBeChecked()
  }
  await expectRestoredControls()
  await expect(action(page, 'transpose-original')).toBeVisible()
  await expect(action(page, 'transpose-original')).toBeEnabled()
  await expect(action(page, 'transpose-original')).toContainText('回到原音')
  expect((await nativeEvidence(page)).requests).toHaveLength(0)
  expect(await download(page, 'export')).toEqual(processedMix)

  await action(page, 'transpose-original').click()
  const recovered = archive(await download(page, 'save'))
  expect(recovered.project.tracks[0].clips[0]).toEqual(originalClip)
  expect(recovered.source(originalClip.assetId)).toEqual(original.buffer)
  expect(await download(page, 'export')).toEqual(originalMix)
  expect((await nativeEvidence(page)).requests).toHaveLength(0)
  // Exactly one Undo recovers the processed clip, including persisted settings.
  await action(page, 'undo').click()
  expect(archive(await download(page, 'save')).project).toEqual(saved.project)
  expect(await download(page, 'export')).toEqual(processedMix)
  await expectRestoredControls()
  await expect(action(page, 'transpose-original')).toBeEnabled()

  await renderCandidate(page)
  const rerenderProof = await nativeEvidence(page)
  expect(rerenderProof.requests).toHaveLength(1); expect(rerenderProof.results).toHaveLength(1)
  const input = rerenderProof.requests[0], output = rerenderProof.results[0]
  expect(input).toMatchObject({ sampleRate: 44100, channels: 2, length: lastFrame - firstFrame,
    options: { semitones: 1.25, formantSemitones: -.5, formantCompensation: true } })
  expect(input.hashes).toEqual(firstProof.requests[0].hashes)
  expect(input.hashes).not.toEqual(firstProof.results[0].hashes)
  expect(output.hashes).toEqual(firstProof.results[0].hashes)
  const rerenderPlayback = await audition(page, 'replacement-preview', 'B：正在試聽')
  expect(rerenderPlayback.wavSha256).toBe(digest(processedMix))
  // Pending or repeated processing never changes the accepted project.
  expect(archive(await download(page, 'save')).project).toEqual(saved.project)
  await action(page, 'replacement-confirm').click()
  const acceptedAgain = archive(await download(page, 'save'))
  const acceptedAgainClip = acceptedAgain.project.tracks[0].clips[0]
  expect(acceptedAgainClip).toEqual({ ...processedClip, assetId: acceptedAgainClip.assetId })
  expect(acceptedAgainClip.assetId).not.toBe(processedClip.assetId)
  expect(acceptedAgainClip.transpose.sourceAssetId).toBe(originalClip.assetId)
  expect(acceptedAgain.source(acceptedAgainClip.assetId)).toEqual(saved.source(processedClip.assetId))
  expect(acceptedAgain.source(originalClip.assetId)).toEqual(original.buffer)
  expect(await download(page, 'export')).toEqual(processedMix)
  expect((await nativeEvidence(page)).requests).toHaveLength(1)
  expect(errors).toEqual([])
  await attachEvidence(testInfo, 'transpose-persisted-lineage-and-original-recovery.json', { originalClip, processedClip,
    recoveredClip: recovered.project.tracks[0].clips[0], firstInput: firstProof.requests[0], reopenedInput: input,
    firstOutput: firstProof.results[0], reopenedOutput: output, acceptedAgainClip,
    originalMixSha256: digest(originalMix), processedMixSha256: digest(processedMix) })
})

test('independent formant and compensation controls render real audio without changing duration or pitch settings', async ({ page }) => {
  test.setTimeout(90_000)
  await observeNativeAudio(page); await start(page)
  const before = archive(await download(page, 'save')).project
  await openDetails(page, 'daw-transpose-timbre')
  await field(page, 'transpose-formants', -.5); await page.locator('#daw-transpose-compensation').check()
  await renderCandidate(page)
  const proof = await nativeEvidence(page)
  expect(proof.results).toHaveLength(1)
  expect(proof.results[0]).toMatchObject({ sampleRate: 48000, length: 96000, channels: 2,
    metadata: { semitones: 0, formantSemitones: -.5, formantCompensation: true, timeRatio: 1, bypassed: false } })
  expect(proof.requests[0].options).toMatchObject({ semitones: 0, formantSemitones: -.5, formantCompensation: true })
  await action(page, 'replacement-cancel').click()
  expect(archive(await download(page, 'save')).project).toEqual(before)
})

test('invalid visible settings never render or mutate the accepted project', async ({ page }) => {
  await observeNativeAudio(page); await start(page)
  const before = archive(await download(page, 'save')).project
  await openDetails(page, 'daw-transpose-timbre')
  for (const [name, value, reset] of [
    ['transpose-semitones', 3, 0], ['transpose-cents', 101, 0], ['transpose-formants', 2.1, 0], ['transpose-semitones', '', 0],
  ]) {
    await field(page, name, value)
    await action(page, 'transpose-render').click()
    await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
    await expect(review(page)).toBeHidden()
    expect((await nativeEvidence(page)).requests).toHaveLength(0)
    expect(archive(await download(page, 'save')).project).toEqual(before)
    await field(page, name, reset)
  }
  await field(page, 'transpose-semitones', 2); await field(page, 'transpose-cents', 1)
  await action(page, 'transpose-render').click()
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  expect((await nativeEvidence(page)).requests).toHaveLength(0)
  expect(archive(await download(page, 'save')).project).toEqual(before)
})

for (const seconds of [.1, 30.01]) {
  test(`a ${seconds}s clip rejects nonzero transpose outside the supported duration without losing its source`, async ({ page }) => {
    await observeNativeAudio(page)
    const file = toneFile(48000, 1, seconds)
    await start(page, file)
    const before = archive(await download(page, 'save')).project
    await field(page, 'transpose-semitones', 1)
    await action(page, 'transpose-render').click()
    await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
    await expect(review(page)).toBeHidden()
    expect((await nativeEvidence(page)).requests).toHaveLength(0)
    const retained = archive(await download(page, 'save'))
    expect(retained.project).toEqual(before)
    expect(retained.source(before.assets[0].id)).toEqual(file.buffer)
  })
}

// Hold only a worker's initial script request for interruption determinism.
// Every successful retry loads the real script and executes the real WASM.
async function holdWorkerScripts(page) {
  let hold = true
  const pending = []
  await page.route(/\/signalsmith-worker(?:-[^/?]+)?\.js(?:\?.*)?$/, async route => {
    if (!hold) return route.continue()
    await new Promise(resolve => pending.push(resolve))
    // Termination can close the request before it is released; that is expected.
    await route.continue().catch(() => {})
  })
  return { count: () => pending.length, release() { hold = false; pending.splice(0).forEach(resolve => resolve()) },
    holdAgain() { hold = true } }
}
for (const interruption of ['cancel twice', 'settings edit', 'project edit', 'navigation', 'selection']) {
  test(`pending transpose survives ${interruption} and a genuine retry without stale replacement`, async ({ page }) => {
    test.setTimeout(120_000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await observeNativeAudio(page); await start(page)
    if (interruption === 'selection') {
      await page.locator('#daw-audio-files').setInputFiles(toneFile(44100, 1, 2, '-other'))
      await expect(page.locator('.daw-clip')).toHaveCount(2)
    }
    await field(page, 'transpose-semitones', 1)
    const before = archive(await download(page, 'save')).project
    const gate = await holdWorkerScripts(page)
    const repeats = interruption === 'cancel twice' ? 2 : 1
    try {
      for (let attempt = 0; attempt < repeats; attempt++) {
        gate.holdAgain()
        await action(page, 'transpose-render').click()
        await expect.poll(gate.count).toBe(1)
        await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'true')
        if (interruption === 'settings edit') await field(page, 'transpose-cents', 25)
        else if (interruption === 'project edit') await action(page, 'later').click()
        else if (interruption === 'navigation') { await page.locator('#tab-lyrics').click(); await page.locator('#tab-editor').click() }
        else if (interruption === 'selection') await page.locator('.daw-clip').first().click()
        else await action(page, 'cancel').click()
        await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
        await expect(review(page)).toBeHidden()
        await expect(action(page, 'replacement-confirm')).toBeHidden()
        gate.release()
        if (interruption === 'project edit') await action(page, 'undo').click()
        expect(archive(await download(page, 'save')).project).toEqual(before)
      }
      await field(page, 'transpose-semitones', -1); await field(page, 'transpose-cents', -25)
      await renderCandidate(page)
      const proof = await nativeEvidence(page)
      expect(proof.requests).toHaveLength(repeats + 1)
      expect(proof.results).toHaveLength(1)
      expect(proof.results[0].metadata.semitones).toBe(-1.25)
      const expectedSource = before.assets.find(asset => asset.id === before.tracks[0].clips[0].assetId)
      expect(proof.results[0].sampleRate).toBe(expectedSource.sampleRate)
      expect(archive(await download(page, 'save')).project).toEqual(before)
      await action(page, 'replacement-cancel').click()
      await expect(review(page)).toBeHidden()
      expect(archive(await download(page, 'save')).project).toEqual(before)
      expect(errors).toEqual([])
    } finally { gate.release() }
  })
}

test('ready candidates are invalidated by settings, edits, navigation and selection, and repeated renders stay transactional', async ({ page }) => {
  test.setTimeout(180_000)
  await observeNativeAudio(page); await start(page)
  await page.locator('#daw-audio-files').setInputFiles(toneFile(44100, 1, 2, '-other'))
  await expect(page.locator('.daw-clip')).toHaveCount(2)
  await field(page, 'transpose-semitones', 1)
  const before = archive(await download(page, 'save')).project
  for (const interruption of ['cancel', 'settings', 'edit', 'navigation', 'selection']) {
    await renderCandidate(page)
    if (interruption === 'cancel') await action(page, 'replacement-cancel').click()
    else if (interruption === 'settings') await field(page, 'transpose-cents', 25)
    else if (interruption === 'edit') await action(page, 'later').click()
    else if (interruption === 'navigation') { await page.locator('#tab-lyrics').click(); await page.locator('#tab-editor').click() }
    else await page.locator('.daw-clip').first().click()
    await expect(review(page)).toBeHidden()
    if (interruption === 'edit') await action(page, 'undo').click()
    expect(archive(await download(page, 'save')).project).toEqual(before)
  }
  // A newly selected original clip correctly prefills its own zero settings.
  await field(page, 'transpose-semitones', -1); await field(page, 'transpose-cents', -25)
  await renderCandidate(page)
  // Render again while a completed candidate is visible: only the latest
  // candidate may be committed, with no leaked intermediate registered asset.
  await action(page, 'transpose-render').click()
  await expect.poll(async () => (await nativeEvidence(page)).results.length).toBe(7)
  await expect(action(page, 'replacement-confirm')).toBeEnabled()
  await action(page, 'replacement-confirm').click()
  const after = archive(await download(page, 'save')).project
  expect(after.assets).toHaveLength(before.assets.length + 1)
  expect(after.tracks[1]).toEqual(before.tracks[1])
  expect(after.tracks[0].clips[0].assetId).not.toBe(before.tracks[0].clips[0].assetId)
  await action(page, 'undo').click()
  expect(archive(await download(page, 'save')).project).toEqual(before)
  expect((await nativeEvidence(page)).requests).toHaveLength(7)
})

for (const width of [1440, 390]) {
  test(`collapsed transpose and contextual A/B are touch and keyboard reachable at ${width}px`, async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/'); await page.locator('#tab-editor').click()
    await expect(page.locator('#daw-clip-fields')).toBeHidden()
    await expect(action(page, 'transpose-render')).toBeHidden()
    await expect(page.locator('#daw-timeline')).toBeInViewport()
    await page.locator('#daw-audio-files').setInputFiles(toneFile())
    await expect(page.locator('.daw-clip')).toHaveCount(1)
    await expect(page.locator('#daw-transpose-details')).not.toHaveAttribute('open', '')
    await expect(action(page, 'transpose-render')).toBeHidden()
    await expect(page.locator('#daw-transpose-timbre')).not.toHaveAttribute('open', '')
    await expect(page.locator('#daw-transpose-help')).not.toHaveAttribute('open', '')
    await page.screenshot({ path: testInfo.outputPath(`transpose-editor-collapsed-${width}.png`) })
    await page.locator('#daw-transpose-details > summary').focus(); await page.keyboard.press('Enter')
    await page.keyboard.press('Tab'); await expect(page.locator('#daw-transpose-semitones')).toBeFocused()
    await page.keyboard.press('Tab'); await expect(page.locator('#daw-transpose-cents')).toBeFocused()
    await page.keyboard.press('Tab'); await expect(page.locator('#daw-transpose-timbre > summary')).toBeFocused()
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab')
    await expect(page.locator('#daw-transpose-formants')).toBeFocused()
    await page.keyboard.press('Tab'); await expect(page.locator('#daw-transpose-compensation')).toBeFocused()
    await page.keyboard.press('Tab'); await expect(action(page, 'transpose-render')).toBeFocused()
    await field(page, 'transpose-semitones', 1)
    await action(page, 'transpose-render').focus(); await page.keyboard.press('Enter')
    await expect(page.locator('#daw-transpose-details #daw-replacement-review')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('#daw-replacement-wave path')).toHaveCount(1)
    await expect(page.locator('#daw-replacement-details')).not.toHaveAttribute('open', '')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    for (const command of ['transpose-render', 'replacement-original', 'replacement-preview', 'replacement-confirm', 'replacement-cancel']) {
      const control = action(page, command)
      await control.scrollIntoViewIfNeeded(); await expect(control).toBeInViewport()
      const box = await control.boundingBox()
      expect(box.height).toBeGreaterThanOrEqual(44)
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width)
    }
    // Capture and hit-test the actual pending actions above the fixed transport,
    // rather than a details crop that can omit them or scroll them below it.
    await review(page).evaluate(element => element.scrollIntoView({ block: 'center' }))
    for (const command of ['replacement-original', 'replacement-preview', 'replacement-confirm', 'replacement-cancel']) {
      const control = action(page, command), box = await control.boundingBox()
      const transport = await page.locator('.daw-transport').boundingBox()
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.y + box.height).toBeLessThanOrEqual(transport.y)
      expect(await control.evaluate(element => {
        const box = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })).toBe(true)
    }
    await action(page, 'replacement-original').click()
    await expect(page.locator('#daw-status')).toContainText('A：正在試聽')
    await action(page, 'stop').click()
    await action(page, 'replacement-preview').click()
    await expect(page.locator('#daw-status')).toContainText('B：正在試聽')
    await action(page, 'stop').click()
    await review(page).evaluate(element => element.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: testInfo.outputPath(`transpose-review-compact-${width}.png`) })
    await openDetails(page, 'daw-transpose-help')
    await expect(page.locator('#daw-transpose-help')).toContainText('不上傳')
    await expect(page.locator('#daw-transpose-help')).toContainText('原錄音')
    await expect(page.locator('#daw-transpose-help')).toContainText('ZIP')
    await page.locator('#daw-transpose-details').screenshot({ path: testInfo.outputPath(`transpose-review-${width}.png`) })
    await expect(page.locator('.daw-transport')).toBeInViewport()
    await action(page, 'replacement-cancel').focus(); await page.keyboard.press('Enter')
    await expect(review(page)).toBeHidden(); await expect(action(page, 'transpose-render')).toBeFocused()
    await renderCandidate(page)
    await action(page, 'replacement-confirm').focus(); await page.keyboard.press('Enter')
    await expect(review(page)).toBeHidden(); await expect(action(page, 'transpose-render')).toBeFocused()
    const originalControl = action(page, 'transpose-original')
    await originalControl.scrollIntoViewIfNeeded(); await expect(originalControl).toBeInViewport()
    const originalBox = await originalControl.boundingBox()
    expect(originalBox.height).toBeGreaterThanOrEqual(44)
    expect(originalBox.x).toBeGreaterThanOrEqual(0); expect(originalBox.x + originalBox.width).toBeLessThanOrEqual(width)
    await originalControl.evaluate(element => element.scrollIntoView({ block: 'center' }))
    const recoveryBox = await originalControl.boundingBox(), transportBox = await page.locator('.daw-transport').boundingBox()
    expect(recoveryBox.y).toBeGreaterThanOrEqual(0)
    expect(recoveryBox.y + recoveryBox.height).toBeLessThanOrEqual(transportBox.y)
    await page.screenshot({ path: testInfo.outputPath(`transpose-original-recovery-${width}.png`) })
    await originalControl.focus(); await page.keyboard.press('Enter')
    await expect(originalControl).toBeHidden()
    await action(page, 'undo').click()
    await expect(originalControl).toBeVisible()
    await expect(page.locator('#daw-transpose-semitones')).toHaveValue('1')
    await action(page, 'delete').click()
    await expect(page.locator('#daw-clip-fields')).toBeHidden(); await expect(page.locator('#daw-timeline')).toBeFocused()
    await action(page, 'undo').click(); await page.locator('.daw-clip').click()
    await expect(review(page)).toBeHidden()
    expect(archive(await download(page, 'save')).project.assets).toHaveLength(2)
    expect(errors).toEqual([])
  })
}
