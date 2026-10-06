/** Real group UI → commands → native Web Audio → PCM24/portable ZIP.
 * Synthetic sources and descriptive transpose metadata only. Native observers
 * forward the original calls; the independent reference graph imports no app
 * render/command code. Execute Chromium in CI, never in the restricted shell. */
import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { createProject } from '../../src/js/daw/project.js'
import { exportProjectArchive } from '../../src/js/daw/archive.js'
import { encodeWAV } from '../../src/js/audio/wav.js'
import { encodeGeneratedFloatWav } from '../../src/js/audio/generated-float-wav.js'
import { readSelectionArchive, readSelectionWav, sha256 } from '../fixtures/daw-selection-fixture.js'

test.use({ screenshot: 'only-on-failure', hasTouch: true })
const daw = (page, name) => page.locator(`[data-daw="${name}"]`)
const group = (page, name) => page.locator(`[data-group-action="${name}"]`)
const clip = (page, id) => page.locator(`.daw-clip[data-clip-id="${id}"]`)
const target = page => page.locator('[data-group-target]')
const SELECTED = ['head-44', 'side-96', 'processed-48']
const clipsOf = project => project.tracks.flatMap(track => track.clips)
const endOf = project => Math.max(...clipsOf(project).map(item => item.atSeconds + item.durationSeconds))

async function fixture(sampleRate = 48000, count = null) {
  const originals = new Map(), files = new Map(), assets = []
  const wave = (rate, seconds, hz) => Array.from({ length: 2 }, (_, channel) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, frame) => {
    const t = frame / rate
    return .012 * (channel ? -1 : 1) + .07 * Math.sin(2 * Math.PI * (hz * (1 + channel * .21) * t + 3 * t * t))
  }))
  async function source(id, rate, seconds, hz, generated = false) {
    const pcm = wave(rate, seconds, hz), name = `${id}-synthetic.wav`
    const bytes = Buffer.from(generated ? await encodeGeneratedFloatWav(pcm, rate, { yieldControl: async () => {} }) : encodeWAV(pcm, rate, 24))
    originals.set(id, bytes); files.set(id, new File([bytes], name, { type: 'audio/wav', lastModified: 1 }))
    assets.push({ id, name, hash: sha256(bytes), sampleRate: rate, sourceSampleRate: rate, channels: 2,
      length: pcm[0].length, duration: seconds, decodeBackend: generated ? 'generated-float32-wav' : 'native-rate-wav' })
  }
  await source('source-44', 44100, 2, 173)
  if (!count) {
    await source('source-96', 96000, 1.5, 281)
    await source('source-48', 48000, 2, 347)
    // This is a synthetic accepted-take fixture, not evidence that a pitch
    // algorithm ran. Its retained recipe tests lineage survives group edits.
    await source('generated-48', 48000, .75, 368, true)
  }
  const makeClip = (id, assetId, atSeconds, offsetSeconds, durationSeconds, extra = {}) => ({ id, name: id,
    assetId, atSeconds, offsetSeconds, durationSeconds, gainDb: -1, fadeInSeconds: .05, fadeOutSeconds: .1, ...extra })
  const track = (id, pan, clips) => ({ id, name: id, gainDb: -2, pan, mute: false, solo: false, clips })
  const tracks = count ? [track('cap-track', 0, Array.from({ length: count }, (_, index) =>
    makeClip(`cap-${index}`, 'source-44', index * .01, .25, .1, { gainDb: -30, fadeInSeconds: 0, fadeOutSeconds: 0 })))] : [
    track('upper-track', -.15, [
      makeClip('head-44', 'source-44', .125, .25, 1.5, {
        volumeAutomation: [{ timeSeconds: 0, value: 1 }, { timeSeconds: .5, value: .5 }, { timeSeconds: 1.5, value: .75 }],
        gainRegions: [{ id: 'head-region', startSeconds: .25, endSeconds: .75, gain: .3, fadeInSeconds: .05, fadeOutSeconds: .05 }],
      }),
      makeClip('obstacle-48', 'source-48', 3, .5, .6),
      makeClip('tail-96', 'source-96', 6.25, .2, .75),
    ]),
    track('lower-track', .2, [
      makeClip('side-96', 'source-96', 1.625, .1, 1.125, { gainDb: -4,
        gainEnvelope: [{ timeSeconds: 0, value: .2 }, { timeSeconds: .2, value: 1 }, { timeSeconds: 1.125, value: .1 }] }),
      makeClip('processed-48', 'generated-48', 3, 0, .75, {
        volumeAutomation: [{ timeSeconds: 0, value: .8 }, { timeSeconds: .3, value: 1.1 }, { timeSeconds: .75, value: .6 }],
        transpose: { version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: 'source-48', sourceOffsetSeconds: .5,
          sourceDurationSeconds: .75, cropFirstFrame: 24000, cropLastFrame: 60000, semitones: 1, cents: 0,
          formantSemitones: -.5, formantCompensation: true },
      }),
    ]),
  ]
  const project = createProject({ id: `native-group-${sampleRate}`, name: 'Synthetic group evidence', sampleRate, tempo: 120, assets, tracks })
  return { project, originals, files, bytes: Buffer.from(await (await exportProjectArchive(project, files)).arrayBuffer()) }
}

async function evidence(testInfo, name, value) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}
async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(name), bytes = await page.screenshot({ path, fullPage: false, scale: 'css' })
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([page.viewportSize().width, page.viewportSize().height])
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
function observeRequests(page) {
  const observed = { errors: [], uploads: [], models: [] }
  page.on('pageerror', error => observed.errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) observed.uploads.push(request.url())
    if (/huggingface|\.onnx(?:\?|$)/.test(request.url())) observed.models.push(request.url())
  })
  return observed
}
async function load(page, bytes, count = 5) {
  await page.locator('#tab-editor').click()
  await page.locator('#daw-project-file').setInputFiles({ name: 'synthetic-group.waveforge.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.daw-clip')).toHaveCount(count)
}
async function download(page, control) {
  const pending = page.waitForEvent('download')
  await control.click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return readFile(await item.path())
}
async function saved(page) {
  const bytes = await download(page, daw(page, 'save'))
  return { ...readSelectionArchive(bytes), bytes }
}
async function selection(page, ids) {
  await expect.poll(() => page.locator('.daw-clip[aria-pressed="true"]').evaluateAll(nodes => nodes.map(node => node.dataset.clipId).sort())).toEqual([...ids].sort())
}
async function selectGroup(page, ids = SELECTED, touch = false) {
  if (touch) {
    await daw(page, 'multi-select').tap()
    for (const id of ids) { await clip(page, id).scrollIntoViewIfNeeded(); await clip(page, id).tap() }
  } else {
    await clip(page, ids[0]).click()
    for (const id of ids.slice(1)) await clip(page, id).click({ modifiers: ['Shift'] })
  }
  await selection(page, ids)
  await expect(daw(page, 'multi-select')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#daw-group-tools')).toBeVisible()
  await expect(page.locator('#daw-clip-fields')).toBeHidden()
}
async function grid(page, { snap = false, zoom = 96 } = {}) {
  const details = page.locator('.daw-grid-settings')
  if (!(await details.evaluate(node => node.open))) await details.locator(':scope > summary').click()
  await page.locator('#daw-snap').setChecked(snap)
  await page.locator('#daw-zoom').selectOption(String(zoom))
  await details.locator(':scope > summary').click()
}
async function move(page, at) { await target(page).fill(String(at)); await group(page, 'move').click() }
function assertSources(actual, input) {
  expect(actual.project.assets).toEqual(input.project.assets)
  for (const [id, bytes] of input.originals) expect(actual.source(id).equals(bytes), `${id}: immutable source/accepted-take bytes`).toBe(true)
}
function movedProject(before, ids, delta, revision = before.revision + 1) {
  const result = structuredClone(before)
  result.revision = revision
  for (const item of clipsOf(result)) if (ids.includes(item.id)) item.atSeconds += delta
  return result
}

async function observeNative(page) {
  await page.addInitScript(() => {
    const state = window.__groupNative = { starts: [], renders: [], decodes: [], creates: [], events: [], references: new WeakSet() }
    const ids = new WeakMap(); let serial = 0
    const id = object => { if (!ids.has(object)) ids.set(object, ++serial); return ids.get(object) }
    const bufferInfo = buffer => ({ bufferId: id(buffer), nativeBuffer: buffer instanceof AudioBuffer,
      rate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels })
    state.bufferInfo = bufferInfo
    for (const type of ['pointerdown', 'pointerup', 'keydown']) document.addEventListener(type, event => {
      const control = event.target.closest?.('.daw-clip,[data-group-action],[data-daw="multi-select"],#daw-timeline')
      if (control) state.events.push({ type, trusted: event.isTrusted, key: event.key || null,
        pointerType: event.pointerType || null, clipId: control.dataset.clipId || null, action: control.dataset.groupAction || null })
    }, true)
    const base = BaseAudioContext.prototype, create = base.createBuffer, decode = base.decodeAudioData, source = base.createBufferSource
    base.createBuffer = function (...args) {
      const buffer = create.apply(this, args)
      state.creates.push(bufferInfo(buffer)); return buffer
    }
    base.decodeAudioData = function (...args) {
      const result = decode.apply(this, args)
      result.then(buffer => state.decodes.push({ ...bufferInfo(buffer), buffer }), () => {})
      return result
    }
    base.createBufferSource = function (...args) {
      const context = this, node = source.apply(this, args), start = node.start
      node.start = function (...startArgs) {
        if (node.buffer) state.starts.push({ ...bufferInfo(node.buffer), buffer: node.buffer, contextId: id(context),
          kind: state.references.has(context) ? 'reference' : context instanceof OfflineAudioContext ? 'offline' : 'realtime',
          args: startArgs, playbackRate: node.playbackRate.value, detune: node.detune.value,
          loop: node.loop, loopStart: node.loopStart, loopEnd: node.loopEnd })
        return start.apply(this, startArgs)
      }
      return node
    }
    const render = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) {
      const item = { contextId: id(this), reference: state.references.has(this), rate: this.sampleRate, frames: this.length, complete: false }
      state.renders.push(item)
      return render.apply(this, args).then(buffer => { Object.assign(item, bufferInfo(buffer), { complete: true }); return buffer })
    }
    state.pcmHash = async buffer => {
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, n) => buffer.getChannelData(n))
      const bytes = new Uint8Array(buffer.length * channels.length * 3)
      let cursor = 0
      for (let frame = 0; frame < buffer.length; frame++) for (const channel of channels) {
        const sample = Math.max(-1, Math.min(1, channel[frame])), value = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
        bytes[cursor++] = value & 255; bytes[cursor++] = (value >> 8) & 255; bytes[cursor++] = (value >> 16) & 255
      }
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    }
  })
}
async function nativeSnapshot(page) {
  return page.evaluate(() => {
    const state = window.__groupNative
    if (!state) return null
    return { creates: state.creates, decodes: state.decodes.map(({ buffer, ...item }) => item),
      starts: state.starts.map(({ buffer, ...item }) => item), renders: state.renders, events: state.events }
  })
}
function resourceCounts(snapshot) {
  return { creates: snapshot.creates.length, decodes: snapshot.decodes.length,
    renders: snapshot.renders.filter(item => !item.reference).length, sources: snapshot.starts.filter(item => item.kind !== 'reference').length }
}
async function independentReference(page, project) {
  // Independently authored Web Audio graph from the expected metadata. Source
  // PCM is exactly the native decoder's real output, with no fake audio clock,
  // handcrafted browser buffer, app render-plan import, or substitute encoder.
  return page.evaluate(async expected => {
    const state = window.__groupNative, end = Math.max(...expected.tracks.flatMap(track => track.clips.map(clip => clip.atSeconds + clip.durationSeconds)))
    const context = new OfflineAudioContext(2, Math.ceil(end * expected.sampleRate), expected.sampleRate)
    state.references.add(context)
    const db = value => 10 ** (value / 20), master = context.createGain()
    master.gain.setValueAtTime(db(expected.masterGainDb), 0); master.connect(context.destination)
    const automate = (parameter, points, at, gain = 1) => points.forEach((point, index) =>
      parameter[index ? 'linearRampToValueAtTime' : 'setValueAtTime'](point.value * gain, at + point.timeSeconds))
    for (const track of expected.tracks) {
      if (track.mute || expected.tracks.some(item => item.solo) && !track.solo) continue
      const gain = context.createGain(), pan = context.createStereoPanner()
      gain.gain.setValueAtTime(db(track.gainDb), 0); pan.pan.setValueAtTime(track.pan, 0)
      gain.connect(pan); pan.connect(master)
      for (const clip of track.clips) {
        const metadata = expected.assets.find(item => item.id === clip.assetId)
        const decoded = state.decodes.find(item => item.rate === metadata.sampleRate && item.frames === metadata.length)
        if (!decoded) throw new Error(`Reference source missing: ${clip.assetId}`)
        const source = context.createBufferSource(), envelope = context.createGain(), automation = context.createGain()
        source.buffer = decoded.buffer
        const fades = [{ timeSeconds: 0, value: clip.fadeInSeconds ? 0 : 1 }]
        if (clip.fadeInSeconds) fades.push({ timeSeconds: clip.fadeInSeconds, value: 1 })
        const fadeOut = clip.durationSeconds - clip.fadeOutSeconds
        if (fadeOut > fades.at(-1).timeSeconds) fades.push({ timeSeconds: fadeOut, value: 1 })
        if (clip.durationSeconds > fades.at(-1).timeSeconds) fades.push({ timeSeconds: clip.durationSeconds, value: clip.fadeOutSeconds ? 0 : 1 })
        automate(envelope.gain, clip.gainEnvelope || fades, clip.atSeconds, db(clip.gainDb))
        automate(automation.gain, clip.volumeAutomation || [{ timeSeconds: 0, value: 1 }, { timeSeconds: clip.durationSeconds, value: 1 }], clip.atSeconds)
        source.connect(envelope); envelope.connect(automation)
        if (clip.gainRegions?.length) {
          // Fixture intentionally has one bounded trapezoid. No production
          // gain-region compilation is reused to produce the expected PCM.
          if (clip.gainRegions.length !== 1) throw new Error('Reference fixture requires one region')
          const r = clip.gainRegions[0], region = context.createGain(), at = clip.atSeconds
          region.gain.setValueAtTime(1, at)
          region.gain.linearRampToValueAtTime(1, at + r.startSeconds)
          region.gain.setValueAtTime(1, at + r.startSeconds)
          region.gain.linearRampToValueAtTime(r.gain, at + r.startSeconds + r.fadeInSeconds)
          region.gain.setValueAtTime(r.gain, at + r.startSeconds + r.fadeInSeconds)
          region.gain.linearRampToValueAtTime(r.gain, at + r.endSeconds - r.fadeOutSeconds)
          region.gain.setValueAtTime(r.gain, at + r.endSeconds - r.fadeOutSeconds)
          region.gain.linearRampToValueAtTime(1, at + r.endSeconds)
          region.gain.setValueAtTime(1, at + r.endSeconds)
          region.gain.linearRampToValueAtTime(1, at + clip.durationSeconds)
          automation.connect(region); region.connect(gain)
        } else automation.connect(gain)
        source.start(clip.atSeconds, clip.offsetSeconds, clip.durationSeconds)
      }
    }
    const buffer = await context.startRendering()
    return { ...state.bufferInfo(buffer), pcm24Sha256: await state.pcmHash(buffer) }
  }, project)
}
async function soundProof(page, project, bytes) {
  const wav = readSelectionWav(bytes)
  expect(wav).toMatchObject({ tag: 1, rate: project.sampleRate, bits: 24, channels: 2, frames: Math.ceil(endOf(project) * project.sampleRate) })
  await daw(page, 'begin').click(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  const preview = await page.evaluate(async () => {
    const state = window.__groupNative, source = state.starts.filter(item => item.kind === 'realtime').at(-1)
    if (!source) throw new Error('Expected a genuine native preview source.start')
    const { buffer, ...record } = source
    return { ...record, pcm24Sha256: await state.pcmHash(buffer) }
  })
  await daw(page, 'stop').click()
  expect(preview).toMatchObject({ nativeBuffer: true, rate: wav.rate, frames: wav.frames, channels: 2, playbackRate: 1, detune: 0 })
  expect(preview.args).toEqual([0, 0, endOf(project)])
  expect(preview.pcm24Sha256).toBe(sha256(wav.data))
  const reference = await independentReference(page, project)
  expect(reference.pcm24Sha256, 'exported PCM24 equals an independent native render of the expected edits').toBe(sha256(wav.data))
  const native = await nativeSnapshot(page), render = native.renders.filter(item => !item.reference).at(-1)
  const scheduled = native.starts.filter(item => item.kind === 'offline' && item.contextId === render.contextId)
  expect(render).toMatchObject({ complete: true, nativeBuffer: true, rate: wav.rate, frames: wav.frames })
  expect(scheduled).toHaveLength(clipsOf(project).length)
  expect(scheduled.map(item => ({ args: item.args, rate: item.rate, frames: item.frames }))).toEqual(clipsOf(project).map(item => {
    const asset = project.assets.find(asset => asset.id === item.assetId)
    return { args: [item.atSeconds, item.offsetSeconds, item.durationSeconds], rate: asset.sampleRate, frames: asset.length }
  }))
  expect(scheduled.every(item => item.nativeBuffer && item.playbackRate === 1 && item.detune === 0)).toBe(true)
  return { preview, reference, scheduled, native }
}

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || page.isClosed()) return
  await evidence(testInfo, 'multiclip-failure-native.json', await nativeSnapshot(page)).catch(() => {})
  await screenshot(page, testInfo, 'multiclip-failure-viewport.png').catch(() => {})
})

for (const rate of [44100, 48000, 96000]) test(`group move preserves mixed-rate recipes and native PCM24 through history and fresh ZIP at ${rate} Hz`, async ({ page }, testInfo) => {
  test.setTimeout(120000)
  const input = await fixture(rate), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, input.bytes)
  const before = await saved(page), originalWav = await download(page, daw(page, 'export'))
  await selectGroup(page)
  const counts = resourceCounts(await nativeSnapshot(page))
  await move(page, .625)
  await expect(target(page)).toHaveValue('0.625'); await selection(page, SELECTED)
  expect(resourceCounts(await nativeSnapshot(page)), 'group metadata edits allocate no decoded/source/output audio').toEqual(counts)
  const moved = await saved(page), expected = movedProject(before.project, SELECTED, .5)
  expect(moved.project).toEqual(expected); assertSources(moved, input)
  const movedWav = await download(page, daw(page, 'export'))
  expect(movedWav.equals(originalWav)).toBe(false)
  const sound = await soundProof(page, expected, movedWav)
  expect([...new Set(sound.scheduled.map(item => item.rate))].sort((a, b) => a - b)).toEqual([44100, 48000, 96000])
  await daw(page, 'undo').click(); await selection(page, SELECTED)
  expect((await saved(page)).project).toEqual(before.project)
  expect((await download(page, daw(page, 'export'))).equals(originalWav)).toBe(true)
  await daw(page, 'redo').click(); await selection(page, SELECTED)
  expect((await saved(page)).project).toEqual(expected)
  expect((await download(page, daw(page, 'export'))).equals(movedWav)).toBe(true)
  await page.reload(); await load(page, moved.bytes)
  await selection(page, [])
  await expect(daw(page, 'multi-select')).toHaveAttribute('aria-pressed', 'false')
  await expect(daw(page, 'undo')).toBeDisabled()
  const reopened = await saved(page), reopenedWav = await download(page, daw(page, 'export'))
  expect(reopened.project).toEqual(expected); assertSources(reopened, input)
  expect(reopenedWav.equals(movedWav)).toBe(true)
  const reopenedSound = await soundProof(page, expected, reopenedWav)
  expect(reopenedSound.native.decodes.map(item => item.rate)).toEqual([44100, 96000, 48000, 48000])
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, `multiclip-native-${rate}.json`, { before: before.project, expected, sound, reopenedSound, observed,
    originalWavSha256: sha256(originalWav), movedWavSha256: sha256(movedWav), decodedBytes: input.project.assets.reduce((sum, asset) => sum + asset.length * asset.channels * 4, 0) })
})

test('duplicate after the whole project and delete are atomic and share genuine decoded buffers', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  const input = await fixture(), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, input.bytes); await selectGroup(page)
  const before = await saved(page), beforeWav = await download(page, daw(page, 'export')), initial = await nativeSnapshot(page)
  await group(page, 'duplicate').click()
  await expect(page.locator('.daw-clip')).toHaveCount(8)
  expect(resourceCounts(await nativeSnapshot(page))).toEqual(resourceCounts(initial))
  const copied = await saved(page), originals = new Set(clipsOf(before.project).map(item => item.id))
  const copies = copied.project.tracks.flatMap(track => track.clips.filter(item => !originals.has(item.id)).map(item => ({ trackId: track.id, ...item })))
  const delta = 7 - .125
  expect(copies).toHaveLength(3)
  for (const track of before.project.tracks) {
    const actual = copied.project.tracks.find(item => item.id === track.id)
    expect(actual.clips.filter(item => originals.has(item.id))).toEqual(track.clips)
    for (const original of track.clips.filter(item => SELECTED.includes(item.id))) {
      const copy = actual.clips.find(item => !originals.has(item.id) && item.assetId === original.assetId)
      expect(copy).toEqual({ ...original, id: copy.id, atSeconds: original.atSeconds + delta })
    }
  }
  expect(Math.min(...copies.map(item => item.atSeconds))).toBe(endOf(before.project))
  expect(copied.project.revision).toBe(before.project.revision + 1); assertSources(copied, input)
  const copyIds = copies.map(item => item.id)
  await selection(page, copyIds)
  const copiedWav = await download(page, daw(page, 'export')), proof = await soundProof(page, copied.project, copiedWav)
  const originalIds = new Set(initial.starts.filter(item => item.kind === 'offline').map(item => item.bufferId))
  expect(new Set(proof.scheduled.map(item => item.bufferId))).toEqual(originalIds)
  expect(proof.native.decodes).toEqual(initial.decodes)
  expect(proof.native.creates).toEqual(initial.creates)
  // Group looping bounds playback by the earliest/latest selected endpoints,
  // while its source remains the complete rendered mix, including other clips.
  const groupStart = Math.min(...copies.map(item => item.atSeconds))
  const groupEnd = Math.max(...copies.map(item => item.atSeconds + item.durationSeconds))
  await page.locator('#daw-loop').check(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  const groupLoop = await page.evaluate(async () => {
    const state = window.__groupNative, source = state.starts.filter(item => item.kind === 'realtime').at(-1)
    const { buffer, ...record } = source
    return { ...record, pcm24Sha256: await state.pcmHash(buffer) }
  })
  expect(groupLoop).toMatchObject({ nativeBuffer: true, loop: true, loopStart: groupStart, loopEnd: groupEnd,
    args: [0, groupStart], rate: copied.project.sampleRate, channels: 2, frames: Math.ceil(endOf(copied.project) * copied.project.sampleRate),
    playbackRate: 1, detune: 0, bufferId: proof.preview.bufferId, pcm24Sha256: sha256(readSelectionWav(copiedWav).data) })
  await daw(page, 'stop').click(); await page.locator('#daw-loop').uncheck()
  await group(page, 'remove').click(); await selection(page, [])
  const deleted = await saved(page)
  expect(deleted.project).toEqual({ ...before.project, revision: before.project.revision + 2 })
  expect((await download(page, daw(page, 'export'))).equals(beforeWav)).toBe(true)
  await daw(page, 'undo').click(); await selection(page, copyIds)
  expect((await saved(page)).project).toEqual(copied.project)
  await daw(page, 'redo').click(); await selection(page, [])
  expect((await saved(page)).project).toEqual(deleted.project)
  await daw(page, 'undo').click(); await daw(page, 'undo').click(); await selection(page, SELECTED)
  expect((await saved(page)).project).toEqual(before.project)
  await daw(page, 'redo').click(); await selection(page, copyIds)
  expect((await download(page, daw(page, 'export'))).equals(copiedWav)).toBe(true)
  expect((await saved(page)).project).toEqual(copied.project)
  await page.reload(); await load(page, copied.bytes, 8)
  expect((await download(page, daw(page, 'export'))).equals(copiedWav)).toBe(true)
  expect((await nativeSnapshot(page)).decodes).toHaveLength(4)
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, 'multiclip-copy-delete-resources.json', { before: before.project, copied: copied.project, deleted: deleted.project,
    initial, proof, groupLoop, sharedNativeBufferIds: [...originalIds], observed })
})

test('real mouse group drag commits one delta; Escape and same-ID source replacement reject stale gestures', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const input = await fixture(), observed = observeRequests(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await observeNative(page); await page.goto('/'); await load(page, input.bytes); await grid(page); await selectGroup(page)
  const before = await saved(page)
  const beginDrag = async pixels => {
    await clip(page, 'head-44').scrollIntoViewIfNeeded()
    const box = await clip(page, 'head-44').boundingBox()
    await page.mouse.move(box.x + 25, box.y + 32); await page.mouse.down()
    await page.mouse.move(box.x + 25 + pixels, box.y + 32, { steps: 8 })
  }
  await beginDrag(72); await page.mouse.up()
  await expect(target(page)).toHaveValue('0.875')
  const moved = await saved(page)
  expect(moved.project).toEqual(movedProject(before.project, SELECTED, .75))
  await selection(page, SELECTED)
  await beginDrag(48)
  await expect.poll(() => clip(page, 'head-44').evaluate(node => parseFloat(node.style.left))).toBe(1.375 * 96)
  await page.keyboard.press('Escape'); await page.mouse.up()
  await selection(page, SELECTED)
  await expect(daw(page, 'multi-select')).toHaveAttribute('aria-pressed', 'true')
  expect((await saved(page)).project).toEqual(moved.project)
  await daw(page, 'undo').click(); await selection(page, SELECTED)
  expect((await saved(page)).project).toEqual(before.project)
  await daw(page, 'redo').click(); await selection(page, SELECTED)
  // Keep IDs and revision identical while replacing the entire source owner.
  // The real file-input restore invalidates a drag already in progress.
  await beginDrag(48)
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toContain('開啟工程會取代')
    await dialog.accept()
  })
  await page.locator('#daw-project-file').setInputFiles({ name: 'same-owner-ids.waveforge.zip', mimeType: 'application/zip', buffer: moved.bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await page.mouse.up()
  await selection(page, [])
  expect((await saved(page)).project).toEqual(moved.project)
  await expect(daw(page, 'undo')).toBeDisabled()
  const wav = await download(page, daw(page, 'export')), proof = await soundProof(page, moved.project, wav)
  expect(proof.native.events.filter(item => item.type.startsWith('pointer') && item.pointerType === 'mouse').every(item => item.trusted)).toBe(true)
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, 'multiclip-drag-cancel-source-owner.json', { before: before.project, moved: moved.project, proof, observed })
})

test('overlap permission is one operation, no-ops keep history, and keyboard selection stays scoped', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const input = await fixture(), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, input.bytes); await selectGroup(page)
  const before = await saved(page), beforeWav = await download(page, daw(page, 'export')), resources = resourceCounts(await nativeSnapshot(page))
  await move(page, .125)
  await expect(daw(page, 'undo')).toBeDisabled()
  await move(page, 2.5)
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  expect((await saved(page)).project).toEqual(before.project)
  await expect(daw(page, 'undo')).toBeDisabled()
  expect(resourceCounts(await nativeSnapshot(page))).toEqual(resources)
  await page.locator('[data-group-overlap]').check(); await move(page, 2.5)
  const allowed = await saved(page)
  expect(allowed.project).toEqual(movedProject(before.project, SELECTED, 2.375))
  await expect(page.locator('[data-group-overlap]')).not.toBeChecked()
  await move(page, 2.6)
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  expect((await saved(page)).project).toEqual(allowed.project)
  await daw(page, 'undo').click()
  expect((await saved(page)).project).toEqual(before.project)
  expect((await download(page, daw(page, 'export'))).equals(beforeWav)).toBe(true)
  await clip(page, 'head-44').focus(); await page.keyboard.press('ArrowRight')
  await expect(target(page)).toHaveValue('0.5')
  expect((await saved(page)).project).toEqual(movedProject(before.project, SELECTED, .375))
  await group(page, 'nudge-left').click(); await expect(target(page)).toHaveValue('0')
  await group(page, 'nudge-right').click(); await expect(target(page)).toHaveValue('0.5')
  await daw(page, 'undo').click(); await daw(page, 'undo').click(); await daw(page, 'undo').click()
  expect((await saved(page)).project).toEqual(before.project)
  // Select-all in an input must keep editing text, not alter clip references.
  await target(page).focus(); await page.keyboard.press('ControlOrMeta+A'); await selection(page, SELECTED)
  await page.locator('#daw-timeline').focus(); await page.keyboard.press('ControlOrMeta+A')
  await selection(page, clipsOf(before.project).map(item => item.id))
  await clip(page, 'tail-96').click({ modifiers: ['Shift'] })
  await selection(page, clipsOf(before.project).filter(item => item.id !== 'tail-96').map(item => item.id))
  await group(page, 'clear').focus(); await page.keyboard.press('Enter'); await selection(page, [])
  await expect(page.locator('#daw-timeline')).toBeFocused()
  await expect(daw(page, 'multi-select')).toHaveAttribute('aria-pressed', 'true')
  await clip(page, 'head-44').click(); await clip(page, 'side-96').click()
  await group(page, 'exit').focus(); await page.keyboard.press('Enter'); await selection(page, ['side-96'])
  await expect(page.locator('#daw-timeline')).toBeFocused()
  await expect(daw(page, 'multi-select')).toHaveAttribute('aria-pressed', 'false')
  await clip(page, 'head-44').click({ modifiers: ['Shift'] })
  await page.locator('#daw-timeline').focus(); await page.keyboard.press('Escape')
  await selection(page, ['head-44'])
  await expect(page.locator('#daw-group-tools')).toBeHidden()
  await expect(page.locator('#daw-clip-fields')).toBeVisible()
  expect((await saved(page)).project).toEqual(before.project)
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, 'multiclip-overlap-keyboard.json', { before: before.project, allowed: allowed.project, resources, native: await nativeSnapshot(page), observed })
})

test('256 real clips reject duplication atomically without another decode or native render', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const input = await fixture(48000, 256), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, input.bytes, 256)
  await page.locator('#daw-timeline').focus(); await page.keyboard.press('ControlOrMeta+A')
  await selection(page, clipsOf(input.project).map(item => item.id))
  const before = await saved(page), initial = await nativeSnapshot(page)
  expect(initial.decodes).toHaveLength(1)
  await group(page, 'duplicate').click()
  await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
  await expect(page.locator('#daw-status')).toContainText('256')
  await expect(page.locator('.daw-clip')).toHaveCount(256)
  await expect(daw(page, 'undo')).toBeDisabled()
  expect((await saved(page)).project).toEqual(before.project)
  expect(resourceCounts(await nativeSnapshot(page))).toEqual(resourceCounts(initial))
  await move(page, 600)
  await expect(target(page)).toHaveAttribute('aria-invalid', 'true')
  expect((await saved(page)).project).toEqual(before.project)
  await move(page, .125)
  const moved = await saved(page)
  expect(moved.project).toEqual(movedProject(before.project, clipsOf(before.project).map(item => item.id), .125))
  expect(resourceCounts(await nativeSnapshot(page))).toEqual(resourceCounts(initial))
  await daw(page, 'undo').click(); await selection(page, clipsOf(before.project).map(item => item.id))
  expect((await saved(page)).project).toEqual(before.project)
  assertSources(moved, input)
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, 'multiclip-cap-native-resources.json', { clips: 256, initial, final: await nativeSnapshot(page), observed })
})

for (const width of [1440, 390]) test(`default, selected and copied group controls fit ${width}×844 with real touch or keyboard`, async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const input = await fixture(), observed = observeRequests(page)
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await observeNative(page); await page.goto('/'); await load(page, input.bytes)
  await expect(page.locator('#daw-group-tools')).toBeHidden()
  await expect(page.locator('#daw-clip-fields')).toBeHidden()
  await expect(page.locator('#daw-timeline')).toBeInViewport()
  const defaultRuler = await page.locator('#daw-ruler').boundingBox()
  expect(defaultRuler.y, 'multi-select shares the existing toolbar row').toBe(width === 390 ? 319 : 231)
  await screenshot(page, testInfo, `multiclip-default-${width}.png`)
  await selectGroup(page, SELECTED, width === 390)
  const geometry = []
  const inspect = async state => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await page.locator('#daw-group-tools').evaluate(node => node.scrollIntoView({ block: 'center' }))
    const measured = await page.locator('#daw-group-tools').evaluate(host => {
      const transport = document.querySelector('.daw-transport').getBoundingClientRect()
      return { transport: transport.toJSON(), controls: [...host.querySelectorAll('button,[data-group-target],.daw-group-overlap')].map(node => {
        const box = node.getBoundingClientRect()
        return { action: node.dataset.groupAction || (node.matches('input') ? 'target' : 'overlap'), box: box.toJSON(),
          reachable: node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) }
      }) }
    })
    for (const control of measured.controls) {
      expect(control.box.height, `${state} ${control.action} touch height`).toBeGreaterThanOrEqual(44)
      expect(control.box.x).toBeGreaterThanOrEqual(0)
      expect(control.box.right).toBeLessThanOrEqual(width)
      expect(control.box.y).toBeGreaterThanOrEqual(0)
      expect(control.box.bottom, `${state} ${control.action} clears fixed transport`).toBeLessThanOrEqual(measured.transport.y)
      expect(control.reachable, `${state} ${control.action} center hit-test`).toBe(true)
    }
    geometry.push({ state, ...measured })
    await screenshot(page, testInfo, `multiclip-${state}-${width}.png`)
  }
  await inspect('selected')
  await group(page, 'duplicate').focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.daw-clip')).toHaveCount(8)
  const copied = await saved(page), copies = clipsOf(copied.project).filter(item => !clipsOf(input.project).some(original => original.id === item.id))
  await selection(page, copies.map(item => item.id))
  // Scroll the actual timeline, then ensure the contextual controls remain
  // hit-testable and that a copied clip can still receive keyboard commands.
  await clip(page, copies.at(-1).id).scrollIntoViewIfNeeded()
  await page.locator('#daw-timeline').evaluate(node => { node.scrollLeft = node.scrollWidth - node.clientWidth })
  expect(await page.locator('#daw-timeline').evaluate(node => node.scrollLeft)).toBeGreaterThan(0)
  await inspect('copied-after-scroll')
  await group(page, 'remove').focus(); await page.keyboard.press('Enter')
  await expect(page.locator('.daw-clip')).toHaveCount(5)
  await expect(page.locator('#daw-group-tools')).toBeHidden()
  await expect(page.locator('#daw-timeline')).toBeFocused()
  await daw(page, 'undo').click(); await selection(page, copies.map(item => item.id))
  await inspect('undo-restored')
  const native = await nativeSnapshot(page)
  if (width === 390) expect(native.events.filter(item => item.pointerType === 'touch' && item.type === 'pointerdown').length).toBeGreaterThanOrEqual(4)
  expect(native.events.every(item => item.trusted)).toBe(true)
  expect(observed).toEqual({ errors: [], uploads: [], models: [] })
  await evidence(testInfo, `multiclip-layout-${width}.json`, { defaultRuler, geometry, native, observed })
})
