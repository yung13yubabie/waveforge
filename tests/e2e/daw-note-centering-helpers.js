// Generated fixtures and transparent native observers for the note-centering
// browser suite. No successful analysis, rendering, decoding or playback doubles.
import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { generateNote, quantile } from '../../scripts/test-note-centering.mjs'
import { periodicFrequency, centsError } from '../audio/pitch-shift-fixtures.js'

export const action = (page, command) => page.locator(`[data-daw="${command}"]`)
export const review = page => page.locator('#daw-replacement-review')
export const digest = bytes => createHash('sha256').update(bytes).digest('hex')

export function noteFile(sampleRate = 48000, options = {}) {
  const common = { sampleRate, seconds: 1.2, targetMidi: 57, detuneCents: 37, ...options }
  const channels = [generateNote(common), generateNote({ ...common, phase: .8, amplitude: .2,
    modulationDepth: .25, modulationHz: 3, harmonics: [.6, 1, .25, .1] })]
  return pcmFile(channels, sampleRate, `synthetic-note-${sampleRate}-${common.detuneCents}c.wav`)
}

export function pcmFile(channels, sampleRate, name) {
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV(channels, sampleRate, 24)) }
}

export async function openDetails(page, id) {
  if (!await page.locator(`#${id}`).evaluate(element => element.open)) await page.locator(`#${id} > summary`).click()
}

export async function openHelper(page) {
  await openDetails(page, 'daw-transpose-details')
  await openDetails(page, 'daw-note-center-details')
}

export async function start(page, file = noteFile(), { expand = true } = {}) {
  await page.goto('/'); await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles(file)
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  if (expand) await openHelper(page)
}

export async function analyze(page) {
  await action(page, 'note-center-analyze').click()
  await expect(page.locator('#daw-note-center-result')).not.toHaveText('尚未分析', { timeout: 40_000 })
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
}

export async function renderCandidate(page) {
  await expect(action(page, 'note-center-render')).toBeEnabled()
  await action(page, 'note-center-render').click()
  await expect(page.locator('#daw-transpose-details #daw-replacement-review')).toBeVisible({ timeout: 60_000 })
  await expect(action(page, 'replacement-confirm')).toBeEnabled()
}

export async function download(page, command) {
  const pending = page.waitForEvent('download')
  await action(page, command).click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return readFile(await item.path())
}

export function archive(zip) {
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

export function wav(bytes) {
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
  expect([1, 3]).toContain(format.tag)
  expect(format.bits).toBe(format.tag === 3 ? 32 : 24)
  const bytesPerSample = format.bits / 8, frames = data.length / (format.channels * bytesPerSample)
  expect(Number.isSafeInteger(frames)).toBe(true)
  const pcm = Array.from({ length: format.channels }, (_, channel) => Float32Array.from({ length: frames }, (_, frame) => {
    const at = (frame * format.channels + channel) * bytesPerSample
    return format.tag === 3 ? data.readFloatLE(at) : data.readIntLE(at, 3) / 8388608
  }))
  return { ...format, frames, pcm, seconds: frames / format.rate }
}

export function pcmHashes(bytes) {
  return wav(bytes).pcm.map(channel => digest(Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength)))
}

// Independently measure all predetermined interior windows, using the known
// generated fixture's A3 neighborhood, not YIN's estimate or a result filter.
export function pitchMeasurements(bytes, targetHz = 220) {
  const decoded = wav(bytes)
  return decoded.pcm.map((channel, index) => {
    const frames = []
    for (let time = .2; time <= decoded.seconds - .2 + 1e-9; time += .073) {
      const value = periodicFrequency(channel, decoded.rate, time, targetHz)
      frames.push({ time, frequencyHz: value.frequency, correlation: value.correlation, cents: centsError(value.frequency, targetHz) })
    }
    return { channel: index, sampleRate: decoded.rate, sampleCount: decoded.frames, frames,
      medianCents: quantile(frames.map(frame => frame.cents), .5), minimumCorrelation: Math.min(...frames.map(frame => frame.correlation)) }
  })
}

export function audit(page) {
  const observed = { pageErrors: [], mutations: [], modelRequests: [] }
  page.on('pageerror', error => observed.pageErrors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) observed.mutations.push({ method: request.method(), url: request.url() })
    if (/(?:huggingface\.co|hf\.co|hf\.space|cdn-lfs|\.(?:onnx|safetensors)(?:[?#]|$)|\/models\/|tokenizer(?:_config)?\.json)/i.test(request.url())) observed.modelRequests.push(request.url())
  })
  return observed
}

export function expectClean(observed) {
  expect(observed.pageErrors).toEqual([])
  expect(observed.mutations).toEqual([])
  expect(observed.modelRequests).toEqual([])
}

export async function attachEvidence(testInfo, name, evidence) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(evidence, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}

export async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path, fullPage: false })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

export async function observeNative(page) {
  await page.addInitScript(() => {
    const records = window.__noteCenterProof = { workers: [], analysisRequests: [], analysisResults: [], renderRequests: [], renderResults: [], starts: [], oscillators: [], delayedDeliveries: [] }
    const ids = new WeakMap()
    let nextBufferId = 1
    const createSource = BaseAudioContext.prototype.createBufferSource
    BaseAudioContext.prototype.createBufferSource = function (...args) {
      const source = createSource.apply(this, args), nativeStart = source.start
      const kind = this instanceof OfflineAudioContext ? 'offline' : 'realtime'
      source.start = function (...startArgs) {
        if (source.buffer) {
          if (!ids.has(source.buffer)) ids.set(source.buffer, nextBufferId++)
          records.starts.push({ kind, buffer: source.buffer, bufferId: ids.get(source.buffer), args: startArgs,
            playbackRate: source.playbackRate.value, detune: source.detune.value })
        }
        return nativeStart.apply(source, startArgs)
      }
      return source
    }
    const createOscillator = BaseAudioContext.prototype.createOscillator
    BaseAudioContext.prototype.createOscillator = function (...args) {
      const oscillator = createOscillator.apply(this, args), context = this
      const record = { native: oscillator instanceof OscillatorNode, starts: [], stops: [], ended: 0, disconnects: 0 }
      records.oscillators.push(record)
      for (const operation of ['start', 'stop', 'disconnect']) {
        const native = oscillator[operation]
        oscillator[operation] = function (...values) {
          if (operation === 'disconnect') record.disconnects++
          else record[`${operation}s`].push({ at: values[0] ?? null, contextTime: context.currentTime, frequencyHz: oscillator.frequency.value, type: oscillator.type })
          return native.apply(oscillator, values)
        }
      }
      oscillator.addEventListener('ended', () => { record.ended++ })
      return oscillator
    }

    // FAULT INJECTION ONLY: two interruption tests delay a real worker result
    // at the application's installed callback. The original MessageEvent and
    // payload are retained unmodified and delivered after cancellation. Every
    // successful attempt uses ordinary native event delivery and real DSP.
    const gate = window.__noteCenterDeliveryGate = { kind: null, held: [], release() {
      gate.kind = null
      for (const held of gate.held.splice(0)) {
        records.delayedDeliveries.push({ kind: held.record.kind, workerId: held.record.id, afterTermination: held.record.terminated })
        held.receiver.call(held.worker, held.event)
      }
    } }
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget), url = String(args[0])
        const kind = url.includes('signalsmith-worker') ? 'render' : url.includes('analysis-worker') ? 'analysis' : null
        if (!kind) return worker
        const record = { id: records.workers.length + 1, kind, url, native: worker instanceof Target, terminated: false }
        records.workers.push(record)
        const post = worker.postMessage, terminate = worker.terminate
        worker.postMessage = function (message, ...rest) {
          if (kind === 'analysis' && message?.type === 'analyze') records.analysisRequests.push({ workerId: record.id, requestId: message.id,
            sampleRate: message.sampleRate, start: message.start, pcm: message.samples.slice() })
          if (kind === 'render' && message?.type === 'render') records.renderRequests.push({ workerId: record.id, requestId: message.id,
            sampleRate: message.sampleRate, options: { ...message.options }, pcm: message.channels.map(channel => channel.slice()) })
          return post.call(worker, message, ...rest)
        }
        worker.terminate = function (...values) { record.terminated = true; return terminate.apply(worker, values) }
        worker.addEventListener('message', event => {
          const { data } = event
          if (data?.type !== 'result') return
          if (kind === 'analysis') records.analysisResults.push({ workerId: record.id, requestId: data.id, result: data.result })
          else records.renderResults.push({ workerId: record.id, requestId: data.id, sampleRate: data.result.sampleRate,
            channels: data.result.channels.map(channel => channel.slice()), metadata: { ...data.result.metadata } })
          if (gate.kind === kind) {
            if (typeof worker.onmessage !== 'function') throw new Error('Expected the real application worker callback')
            gate.kind = null
            gate.held.push({ worker, record, event, receiver: worker.onmessage })
            event.stopImmediatePropagation()
          }
        })
        return worker
      },
    })
  })
}

export async function proof(page) {
  return page.evaluate(async () => {
    const hash = async pcm => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    const records = window.__noteCenterProof
    return { workers: records.workers, oscillators: records.oscillators, delayedDeliveries: records.delayedDeliveries,
      analysisRequests: await Promise.all(records.analysisRequests.map(async request => ({ workerId: request.workerId, requestId: request.requestId,
        sampleRate: request.sampleRate, start: request.start, length: request.pcm.length, hash: await hash(request.pcm) }))),
      analysisResults: records.analysisResults.map(({ workerId, requestId, result }) => ({ workerId, requestId, engine: result.engine,
        sampleRate: result.sampleRate, start: result.start, duration: result.duration, summary: result.summary })),
      renderRequests: await Promise.all(records.renderRequests.map(async request => ({ workerId: request.workerId, requestId: request.requestId,
        sampleRate: request.sampleRate, length: request.pcm[0].length, channels: request.pcm.length, options: request.options,
        hashes: await Promise.all(request.pcm.map(hash)) }))),
      renderResults: await Promise.all(records.renderResults.map(async result => ({ workerId: result.workerId, requestId: result.requestId,
        sampleRate: result.sampleRate, length: result.channels[0].length, channels: result.channels.length, metadata: result.metadata,
        hashes: await Promise.all(result.channels.map(hash)) }))),
      starts: await Promise.all(records.starts.map(async start => ({ kind: start.kind, native: start.buffer instanceof AudioBuffer,
        bufferId: start.bufferId, sampleRate: start.buffer.sampleRate, length: start.buffer.length, channels: start.buffer.numberOfChannels,
        args: start.args, playbackRate: start.playbackRate, detune: start.detune,
        hashes: await Promise.all(Array.from({ length: start.buffer.numberOfChannels }, (_, channel) => hash(start.buffer.getChannelData(channel)))) }))),
    }
  })
}

export async function playbackSnapshot(page) {
  const captured = await page.evaluate(() => {
    const record = window.__noteCenterProof.starts.filter(start => start.kind === 'realtime').at(-1)
    if (!record) throw new Error('No native realtime playback buffer observed')
    const buffer = record.buffer, channelCount = buffer.numberOfChannels
    // Independent PCM24 writer. Observe the entire real playback mix without
    // importing app code or modifying its buffer, making this usable on dist.
    const bytes = new Uint8Array(44 + buffer.length * channelCount * 3), view = new DataView(bytes.buffer)
    const tag = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
    tag(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channelCount, true)
    view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channelCount * 3, true)
    view.setUint16(32, channelCount * 3, true); view.setUint16(34, 24, true); tag(36, 'data'); view.setUint32(40, bytes.length - 44, true)
    let cursor = 44
    const channels = Array.from({ length: channelCount }, (_, channel) => buffer.getChannelData(channel))
    for (let frame = 0; frame < buffer.length; frame++) for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame])), integer = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
      bytes[cursor++] = integer & 255; bytes[cursor++] = (integer >> 8) & 255; bytes[cursor++] = (integer >> 16) & 255
    }
    let binary = ''
    for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
    return { base64: btoa(binary), bufferId: record.bufferId, args: record.args, playbackRate: record.playbackRate, detune: record.detune,
      sampleRate: buffer.sampleRate, length: buffer.length, channels: channelCount }
  })
  const { base64, ...metadata } = captured, bytes = Buffer.from(base64, 'base64')
  return { bytes, metadata: { ...metadata, wavSha256: digest(bytes) } }
}

export async function audition(page, command, status) {
  const count = await page.evaluate(() => window.__noteCenterProof.starts.filter(start => start.kind === 'realtime').length)
  await action(page, command).click()
  await expect(page.locator('#daw-status')).toContainText(status)
  await expect.poll(() => page.evaluate(() => window.__noteCenterProof.starts.filter(start => start.kind === 'realtime').length)).toBe(count + 1)
  const captured = await playbackSnapshot(page)
  await action(page, 'stop').click()
  return captured
}
