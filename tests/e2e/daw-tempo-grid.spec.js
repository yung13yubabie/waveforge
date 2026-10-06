/** Actual UI → saved project → native Web Audio → downloaded PCM24/ZIP.
 * Synthetic sources only. Observers forward native clocks, decoding, rendering
 * and playback untouched; no fake timers, fabricated PCM, model calls or uploads.
 * Discover locally; execute Chromium only in the authorized browser CI runtime. */
import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { selectionFixture, readSelectionArchive, readSelectionWav, sha256,
  SELECTION_RANGE, PROJECT_SECONDS } from '../fixtures/daw-selection-fixture.js'

test.use({ screenshot: 'only-on-failure' })

const daw = (page, name) => page.locator(`[data-daw="${name}"]`)
const tempo = (page, name) => page.locator(`[data-tempo-action="${name}"]`)
const clip = (page, id = 'head-44') => page.locator(`.daw-clip[data-clip-id="${id}"]`)
const originField = page => page.locator('[data-tempo-origin]')
const roundBpm = value => Math.round(value * 10) / 10

async function evidence(testInfo, name, value) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}
async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(name)
  const bytes = await page.screenshot({ path, fullPage: false, scale: 'css' })
  const viewport = page.viewportSize()
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([viewport.width, viewport.height])
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
function expectQuiet(observed) { expect(observed).toEqual({ errors: [], uploads: [], models: [] }) }
async function load(page, bytes) {
  await page.locator('#tab-editor').click()
  await page.locator('#daw-project-file').setInputFiles({ name: 'synthetic-tempo-grid.waveforge.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.daw-clip')).toHaveCount(4)
}
async function details(page, selector, open = true) {
  const element = page.locator(selector)
  if (await element.evaluate(node => node.open) !== open) await element.locator(':scope > summary').click()
  await expect.poll(() => element.evaluate(node => node.open)).toBe(open)
}
async function openTempo(page, origin = false) {
  await details(page, '.daw-grid-settings')
  await details(page, '.daw-tempo-controls')
  if (origin) await details(page, '.daw-tempo-origin-details')
}
async function changeTempo(page, value) {
  await details(page, '.daw-grid-settings')
  const input = page.locator('#daw-tempo')
  await input.fill(String(value)); await input.press('Tab')
  await expect(input).toHaveValue(String(value))
  expect(await input.evaluate(node => node.validity.valid), 'fractional BPM is valid in the actual number input').toBe(true)
}
async function changeOrigin(page, value) {
  await openTempo(page, true)
  await originField(page).fill(String(value)); await tempo(page, 'apply-origin').click()
  await expect(originField(page)).toHaveValue(String(value))
}
async function setRange(page) {
  await details(page, '.daw-selection-details')
  for (const [name, value] of Object.entries(SELECTION_RANGE)) await page.locator(`[data-range-endpoint="${name}"]`).fill(String(value))
  await page.locator('[data-range-action="apply"]').click()
  await expect(page.locator('[data-range-handle="startSeconds"]')).toHaveAttribute('aria-valuenow', String(SELECTION_RANGE.startSeconds))
  await details(page, '.daw-selection-details', false)
}
async function download(page, control) {
  const pending = page.waitForEvent('download')
  await control.click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return { name: item.suggestedFilename(), bytes: await readFile(await item.path()) }
}
async function saved(page) {
  const file = await download(page, daw(page, 'save'))
  return { ...readSelectionArchive(file.bytes), bytes: file.bytes }
}
function expectOriginals(actual, fixture) {
  expect(actual.project.assets).toEqual(fixture.project.assets)
  for (const [id, bytes] of fixture.originals) expect(actual.source(id).equals(bytes), `${id} source bytes must survive unchanged`).toBe(true)
}
function metadataOnly(actual, before, patch) {
  const expected = { ...before, ...patch, revision: actual.revision }
  expect(actual).toEqual(expected)
}

async function observeNative(page) {
  await page.addInitScript(() => {
    const state = window.__tempoNative = { starts: [], renders: [], decodes: [], taps: [], positionClicks: [], activeTap: null }
    const ids = new WeakMap()
    let serial = 0
    const id = object => { if (!ids.has(object)) ids.set(object, ++serial); return ids.get(object) }
    const nativeNow = performance.now.bind(performance)
    // This is a forwarding observer, never a substitute clock. Production sees
    // exactly the native timestamp, and tests receive that same observed value.
    Object.defineProperty(performance, 'now', { configurable: true, value: function () {
      const timestamp = nativeNow()
      if (state.activeTap) state.activeTap.timestamps.push(timestamp)
      return timestamp
    } })
    for (const type of ['click', 'keydown']) document.addEventListener(type, event => {
      const action = event.target.closest?.('[data-tempo-action]')?.dataset.tempoAction
      if (action === 'tap' && (type === 'click' || [' ', 'Enter'].includes(event.key))) {
        const item = { type, key: event.key || null, trusted: event.isTrusted, repeat: Boolean(event.repeat), detail: event.detail, timestamps: [] }
        state.taps.push(item); state.activeTap = item
        // Keep observation through the complete native dispatch. A browser may
        // checkpoint microtasks between capture and target listeners.
        setTimeout(() => { if (state.activeTap === item) state.activeTap = null }, 0)
      }
      if (type === 'click' && action === 'use-position' && state.realtimeContext) {
        const item = { before: state.realtimeContext.currentTime, after: null, trusted: event.isTrusted }
        state.positionClicks.push(item)
        setTimeout(() => { item.after = state.realtimeContext.currentTime }, 0)
      }
    }, true)
    const create = BaseAudioContext.prototype.createBufferSource
    BaseAudioContext.prototype.createBufferSource = function (...args) {
      const context = this, source = create.apply(context, args), nativeStart = source.start
      const kind = context instanceof OfflineAudioContext ? 'offline' : 'realtime'
      if (kind === 'realtime') state.realtimeContext = context
      source.start = function (...startArgs) {
        if (source.buffer) state.starts.push({ kind, contextId: id(context), buffer: source.buffer,
          bufferId: id(source.buffer), args: startArgs, contextTime: context.currentTime,
          contextRate: context.sampleRate, playbackRate: source.playbackRate.value, detune: source.detune.value })
        return nativeStart.apply(source, startArgs)
      }
      return source
    }
    const nativeRender = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) {
      const item = { contextId: id(this), rate: this.sampleRate, frames: this.length, completed: false }
      state.renders.push(item)
      return nativeRender.apply(this, args).then(buffer => {
        item.completed = true; item.nativeBuffer = buffer instanceof AudioBuffer; item.bufferId = id(buffer)
        return buffer
      })
    }
    const nativeDecode = BaseAudioContext.prototype.decodeAudioData
    BaseAudioContext.prototype.decodeAudioData = function (...args) {
      const result = nativeDecode.apply(this, args)
      if (result?.then) result.then(buffer => state.decodes.push({ nativeBuffer: buffer instanceof AudioBuffer,
        rate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels }), () => {})
      return result
    }
  })
}
async function nativeEvidence(page) {
  return page.evaluate(async () => {
    const state = window.__tempoNative, latest = state.starts.filter(item => item.kind === 'realtime').at(-1)
    if (!latest) throw new Error('Expected a genuine native realtime source.start')
    const buffer = latest.buffer, channels = Array.from({ length: buffer.numberOfChannels }, (_, n) => buffer.getChannelData(n))
    const bytes = new Uint8Array(buffer.length * channels.length * 3)
    let cursor = 0
    for (let frame = 0; frame < buffer.length; frame++) for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]))
      const value = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
      bytes[cursor++] = value & 255; bytes[cursor++] = (value >> 8) & 255; bytes[cursor++] = (value >> 16) & 255
    }
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('')
    return { previewPayloadSha256: hash, renders: state.renders, decodes: state.decodes,
      starts: state.starts.map(({ buffer, ...item }) => ({ ...item, nativeBuffer: buffer instanceof AudioBuffer,
        rate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels })) }
  })
}
async function previewProof(page, wavBytes) {
  await daw(page, 'begin').click(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  const native = await nativeEvidence(page), wav = readSelectionWav(wavBytes)
  await daw(page, 'stop').click()
  expect(native.previewPayloadSha256).toBe(sha256(wav.data))
  const realtime = native.starts.filter(item => item.kind === 'realtime').at(-1)
  expect(realtime).toMatchObject({ nativeBuffer: true, rate: wav.rate, frames: wav.frames, channels: 2, playbackRate: 1, detune: 0 })
  expect(realtime.args).toEqual([0, 0, PROJECT_SECONDS])
  expect(native.renders.every(item => item.completed && item.nativeBuffer)).toBe(true)
  expect([...new Set(native.starts.filter(item => item.kind === 'offline').map(item => item.rate))].sort((a, b) => a - b)).toEqual([44100, 96000])
  expect(native.starts.every(item => item.playbackRate === 1 && item.detune === 0)).toBe(true)
  return native
}
async function gridGeometry(page, bpm, origin, division, zoom) {
  const actual = await page.evaluate(() => {
    const timeline = document.querySelector('#daw-timeline'), css = getComputedStyle(timeline)
    const marker = document.querySelector('.daw-grid-origin-marker')
    return { beatPixels: parseFloat(css.getPropertyValue('--daw-beat-width')),
      phasePixels: parseFloat(css.getPropertyValue('--daw-grid-origin')),
      lanePhasePixels: [...document.querySelectorAll('.daw-lane')].map(lane => parseFloat(getComputedStyle(lane).backgroundPositionX)),
      marker: marker && { seconds: Number(marker.dataset.gridOrigin), left: parseFloat(marker.style.left), label: marker.getAttribute('aria-label') } }
  })
  const interval = 60 / bpm * division, phase = (origin % interval) * zoom
  expect(actual.beatPixels).toBeCloseTo(interval * zoom, 7)
  expect(actual.phasePixels).toBeCloseTo(phase, 7)
  // Computed CSS pixels can be serialized with fewer digits than the variable.
  for (const pixels of actual.lanePhasePixels) expect(pixels).toBeCloseTo(phase, 3)
  expect(actual.marker).toMatchObject({ seconds: origin, label: `拍格參考點 ${origin} 秒` })
  expect(actual.marker.left).toBeCloseTo(origin * zoom, 3)
  return actual
}

for (const sampleRate of [44100, 48000, 96000]) test(`fractional BPM/origin leave native PCM24 unchanged through Undo and fresh ZIP at ${sampleRate} Hz`, async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const fixture = await selectionFixture(sampleRate), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes); await setRange(page)
  const before = await saved(page), fullBefore = await download(page, daw(page, 'export'))
  const rangeBefore = await download(page, page.locator('[data-range-action="export"]'))
  const nativeBefore = await previewProof(page, fullBefore.bytes)
  const bpm = 127.5, origin = .31234567
  await changeTempo(page, bpm); await changeOrigin(page, origin)
  await page.locator('#daw-grid').selectOption('0.25'); await page.locator('#daw-zoom').selectOption('96')
  const geometry = await gridGeometry(page, bpm, origin, .25, 96)
  await details(page, '.daw-grid-settings', false)
  const changed = await saved(page)
  metadataOnly(changed.project, before.project, { tempo: bpm, gridOriginSeconds: origin })
  expect(changed.project.revision).toBe(before.project.revision + 2)
  expectOriginals(changed, fixture)
  const fullAfter = await download(page, daw(page, 'export')), rangeAfter = await download(page, page.locator('[data-range-action="export"]'))
  expect(fullAfter.bytes.equals(fullBefore.bytes), 'grid-only changes preserve the entire PCM24 WAV byte for byte').toBe(true)
  expect(rangeAfter.bytes.equals(rangeBefore.bytes), 'precise range PCM is independent of beat phase').toBe(true)
  expect(readSelectionWav(fullAfter.bytes)).toMatchObject({ tag: 1, rate: sampleRate, bits: 24, channels: 2, frames: PROJECT_SECONDS * sampleRate })
  const nativeAfter = await previewProof(page, fullAfter.bytes)
  await daw(page, 'undo').click()
  const undoOrigin = await saved(page)
  metadataOnly(undoOrigin.project, before.project, { tempo: bpm })
  expect(undoOrigin.project).not.toHaveProperty('gridOriginSeconds')
  await expect(page.locator('.daw-grid-origin-marker')).toHaveCount(0)
  await daw(page, 'undo').click()
  expect((await saved(page)).project).toEqual(before.project)
  expect((await download(page, daw(page, 'export'))).bytes.equals(fullBefore.bytes)).toBe(true)
  await daw(page, 'redo').click(); await daw(page, 'redo').click()
  expect((await saved(page)).project).toEqual(changed.project)
  // New JS document and native decoding of a real downloaded archive.
  await page.reload(); await load(page, changed.bytes)
  const reloaded = await saved(page)
  expect(reloaded.project).toEqual(changed.project); expectOriginals(reloaded, fixture)
  const fullReloaded = await download(page, daw(page, 'export')), rangeReloaded = await download(page, page.locator('[data-range-action="export"]'))
  expect(fullReloaded.bytes.equals(fullBefore.bytes)).toBe(true)
  expect(rangeReloaded.bytes.equals(rangeBefore.bytes)).toBe(true)
  const nativeReloaded = await previewProof(page, fullReloaded.bytes)
  expect(nativeReloaded.decodes.map(item => item.rate).sort((a, b) => a - b)).toEqual([44100, 96000])
  expectQuiet(observed)
  await evidence(testInfo, `tempo-grid-native-${sampleRate}.json`, { sampleRate, before: before.project, changed: changed.project,
    reloaded: reloaded.project, geometry, nativeBefore, nativeAfter, nativeReloaded, observed,
    wavSha256: [fullBefore, fullAfter, fullReloaded].map(file => sha256(file.bytes)),
    rangeSha256: [rangeBefore, rangeAfter, rangeReloaded].map(file => sha256(file.bytes)),
    sourceHashes: Object.fromEntries([...fixture.originals].map(([id, bytes]) => [id, sha256(bytes)])) })
})

test('shifted fractional grid drives genuine clip gestures while numeric trim and disabled snap retain precision', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const fixture = await selectionFixture(), observed = observeRequests(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes); await setRange(page)
  const bpm = 137.5, origin = .137, division = .5, zoom = 96, step = 60 / bpm * division
  await changeTempo(page, bpm); await changeOrigin(page, origin)
  await page.locator('#daw-grid').selectOption(String(division)); await page.locator('#daw-zoom').selectOption(String(zoom))
  const geometry = await gridGeometry(page, bpm, origin, division, zoom)
  await details(page, '.daw-grid-settings', false)
  const baseline = await saved(page), originalWav = await download(page, daw(page, 'export')), movements = []
  const head = baseline.project.tracks[0].clips[0]
  const expectAt = async value => expect.poll(async () => Number(await page.locator('#daw-clip-at').inputValue())).toBeCloseTo(value, 12)
  await clip(page).click(); await clip(page).press('ArrowRight'); await expectAt(origin)
  movements.push({ action: 'off-grid keyboard right', from: head.atSeconds, expected: origin, actual: Number(await page.locator('#daw-clip-at').inputValue()) })
  await clip(page).press('ArrowRight'); await expectAt(origin + step)
  await clip(page).press('ArrowLeft'); await expectAt(origin)
  await daw(page, 'undo').click(); await daw(page, 'undo').click(); await daw(page, 'undo').click(); await expectAt(head.atSeconds)
  const middle = baseline.project.tracks[1].clips[0]
  await clip(page, middle.id).click()
  const previousBoundary = Math.max(0, origin + (Math.ceil((middle.atSeconds - origin) / step) - 1) * step)
  await daw(page, 'earlier').click(); await expectAt(previousBoundary)
  movements.push({ action: 'off-grid earlier button', from: middle.atSeconds, expected: previousBoundary, actual: Number(await page.locator('#daw-clip-at').inputValue()) })
  await daw(page, 'undo').click()
  const nextBoundary = origin + (Math.floor((middle.atSeconds - origin) / step) + 1) * step
  await daw(page, 'later').click(); await expectAt(nextBoundary); await daw(page, 'undo').click()
  await clip(page).click()
  const trimStart = .23456789, trimEnd = 2.34567891
  await page.locator('#daw-trim-start').fill(String(trimStart)); await page.locator('#daw-trim-end').fill(String(trimEnd)); await daw(page, 'trim').click()
  const trimmed = await saved(page), trimmedHead = trimmed.project.tracks[0].clips[0]
  expect(trimmedHead.atSeconds).toBeCloseTo(trimStart, 12)
  expect(trimmedHead.offsetSeconds).toBeCloseTo(head.offsetSeconds + trimStart - head.atSeconds, 12)
  expect(trimmedHead.durationSeconds).toBeCloseTo(trimEnd - trimStart, 12)
  expect(Math.abs((trimStart - origin) / step - Math.round((trimStart - origin) / step))).toBeGreaterThan(.1)
  expectOriginals(trimmed, fixture)
  await daw(page, 'undo').click(); expect((await saved(page)).project).toEqual(baseline.project)
  await details(page, '.daw-grid-settings'); await page.locator('#daw-snap').uncheck(); await details(page, '.daw-grid-settings', false)
  await page.locator('#daw-clip-at').fill('.987654'); await daw(page, 'move').click(); await expectAt(.988)
  await clip(page).press('ArrowRight'); await expectAt(.998)
  await daw(page, 'earlier').click(); await expectAt(.988)
  const unsnapped = (await saved(page)).project.tracks[0].clips[0]
  expect(unsnapped).toEqual({ ...head, atSeconds: .988 })
  await daw(page, 'undo').click(); await daw(page, 'undo').click(); await daw(page, 'undo').click()
  await details(page, '.daw-grid-settings'); await page.locator('#daw-snap').check(); await details(page, '.daw-grid-settings', false)
  // Pixel delta is chosen independently of any app geometry helper. Native
  // pointer events must commit origin + round((raw-origin)/step)*step.
  await clip(page).scrollIntoViewIfNeeded()
  const box = await clip(page).boundingBox(), delta = 137
  const raw = head.atSeconds + delta / zoom, expected = origin + Math.round((raw - origin) / step) * step
  await page.mouse.move(box.x + 30, box.y + 35); await page.mouse.down()
  await page.mouse.move(box.x + 30 + delta, box.y + 35, { steps: 9 }); await page.mouse.up()
  await expectAt(expected)
  const moved = await saved(page)
  const expectedProject = structuredClone(baseline.project)
  expectedProject.tracks[0].clips[0].atSeconds = expected; expectedProject.revision++
  expect(moved.project).toEqual(expectedProject); expectOriginals(moved, fixture)
  const movedWav = await download(page, daw(page, 'export'))
  expect(movedWav.bytes.equals(originalWav.bytes), 'moving a clip must change the rendered mix').toBe(false)
  const native = await previewProof(page, movedWav.bytes)
  const lastRender = native.renders.at(-1)
  const scheduled = native.starts.filter(item => item.kind === 'offline' && item.contextId === lastRender.contextId)
  expect(scheduled).toHaveLength(4)
  const movedSource = scheduled.find(item => item.rate === 44100 && item.args[1] === head.offsetSeconds && item.args[2] === head.durationSeconds)
  expect(movedSource.args[0]).toBeCloseTo(expected, 12)
  await daw(page, 'undo').click(); expect((await saved(page)).project).toEqual(baseline.project)
  expect((await download(page, daw(page, 'export'))).bytes.equals(originalWav.bytes)).toBe(true)
  await daw(page, 'redo').click(); expect((await saved(page)).project).toEqual(moved.project)
  expect((await download(page, daw(page, 'export'))).bytes.equals(movedWav.bytes)).toBe(true)
  await page.reload(); await load(page, moved.bytes)
  const reloaded = await saved(page)
  expect(reloaded.project).toEqual(moved.project); expectOriginals(reloaded, fixture)
  expect((await download(page, daw(page, 'export'))).bytes.equals(movedWav.bytes)).toBe(true)
  expectQuiet(observed)
  await evidence(testInfo, 'tempo-grid-gestures.json', { baseline: baseline.project, trimmed: trimmed.project, unsnapped, moved: moved.project,
    movements, pointer: { delta, zoom, raw, expected, nativeSchedule: movedSource }, geometry, native, observed,
    wavBeforeSha256: sha256(originalWav.bytes), wavMovedSha256: sha256(movedWav.bytes) })
})

/** Independent arithmetic over OBSERVED native timestamps, not the app helper. */
function tapOracle(events) {
  expect(events).toHaveLength(5)
  expect(events.every(event => event.trusted && !event.repeat && event.timestamps.length === 1)).toBe(true)
  const times = events.map(event => event.timestamps[0]), intervals = times.slice(1).map((time, index) => time - times[index])
  const ordered = [...intervals].sort((a, b) => a - b), center = (ordered[1] + ordered[2]) / 2
  expect(Math.max(...intervals.map(value => Math.abs(value - center)))).toBeLessThanOrEqual(center * .15)
  const bpm = roundBpm(60000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length))
  return { events, intervals, bpm }
}
async function collectTaps(page) {
  await openTempo(page)
  if (await tempo(page, 'reset').isEnabled()) await tempo(page, 'reset').click()
  await tempo(page, 'tap').scrollIntoViewIfNeeded(); await tempo(page, 'tap').focus()
  const first = await page.evaluate(() => window.__tempoNative.taps.length)
  for (let index = 0; index < 5; index++) {
    if (index) await page.waitForFunction(() => {
      const last = window.__tempoNative.taps.at(-1)?.timestamps.at(-1)
      return last !== undefined && performance.now() - last >= 700
    })
    if (index % 2) await page.keyboard.press(index === 1 ? 'Space' : 'Enter')
    else await tempo(page, 'tap').click()
    await expect(page.locator('.daw-tempo-status')).toContainText(index < 4 ? `${index + 1} / 5 下` : '5 下')
  }
  const events = await page.evaluate(start => window.__tempoNative.taps.slice(start), first), oracle = tapOracle(events)
  await expect(page.locator('.daw-tempo-candidate')).toHaveText(`${oracle.bpm} BPM`)
  await expect(tempo(page, 'apply')).toBeEnabled()
  return oracle
}

test('real tap clicks and keys require Apply and discard stale candidates after project, source and navigation changes', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const fixture = await selectionFixture(), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes)
  const before = await saved(page), wavBefore = await download(page, daw(page, 'export')), tapRuns = []
  await openTempo(page)
  await daw(page, 'begin').click(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  const startsBeforeTapping = await page.evaluate(() => window.__tempoNative.starts.length)
  tapRuns.push(await collectTaps(page))
  await expect(page.locator('#daw-tempo')).toHaveValue('120')
  await expect(daw(page, 'play')).toHaveText('暫停')
  const untakenNative = await nativeEvidence(page)
  expect(untakenNative.starts).toHaveLength(startsBeforeTapping)
  expect(untakenNative.previewPayloadSha256).toBe(sha256(readSelectionWav(wavBefore.bytes).data))
  expect(untakenNative.starts.filter(item => item.kind === 'realtime')).toHaveLength(1)
  expect(untakenNative.starts.every(item => item.playbackRate === 1 && item.detune === 0)).toBe(true)
  await daw(page, 'stop').click()
  // Saving reads actual command state and deliberately consumes the unsaved
  // candidate because the controller disables itself during a project job.
  const untaken = await saved(page)
  expect(untaken.project).toEqual(before.project)
  expect((await download(page, daw(page, 'export'))).bytes.equals(wavBefore.bytes)).toBe(true)
  const chosen = await collectTaps(page); tapRuns.push(chosen)
  await tempo(page, 'half').click(); await expect(page.locator('.daw-tempo-candidate')).toHaveText(`${roundBpm(chosen.bpm / 2)} BPM`)
  await tempo(page, 'double').click(); await expect(page.locator('.daw-tempo-candidate')).toHaveText(`${chosen.bpm} BPM`)
  await tempo(page, 'double').click(); await expect(page.locator('.daw-tempo-candidate')).toHaveText(`${roundBpm(chosen.bpm * 2)} BPM`)
  await expect(page.locator('#daw-tempo')).toHaveValue('120')
  await tempo(page, 'apply').click()
  await expect(page.locator('#daw-tempo')).toHaveValue(String(roundBpm(chosen.bpm * 2)))
  await expect(page.locator('.daw-tempo-candidate')).toBeHidden()
  const applied = await saved(page)
  metadataOnly(applied.project, before.project, { tempo: roundBpm(chosen.bpm * 2) })
  expect(applied.project.revision).toBe(before.project.revision + 1)
  expectOriginals(applied, fixture)
  const appliedWav = await download(page, daw(page, 'export'))
  expect(appliedWav.bytes.equals(wavBefore.bytes)).toBe(true)
  const native = await previewProof(page, appliedWav.bytes)
  await daw(page, 'undo').click(); expect((await saved(page)).project).toEqual(before.project)
  await daw(page, 'redo').click(); expect((await saved(page)).project).toEqual(applied.project)
  for (const invalidation of ['project', 'source', 'navigation']) {
    tapRuns.push(await collectTaps(page))
    if (invalidation === 'project') {
      await page.locator('#daw-name').fill('Changed while tapping'); await page.locator('#daw-name').press('Tab')
    } else if (invalidation === 'source') {
      page.once('dialog', async dialog => {
        expect(dialog.message()).toContain('開啟工程會取代此多軌專案')
        await dialog.accept()
      })
      await load(page, fixture.bytes)
    } else {
      await page.locator('#tab-lyrics').click(); await page.locator('#tab-editor').click(); await openTempo(page)
    }
    await expect(page.locator('.daw-tempo-candidate')).toBeHidden()
    await expect(page.locator('.daw-tempo-status')).toHaveText('至少 5 下')
    await expect(tempo(page, 'apply')).toBeDisabled()
  }
  const afterInvalidations = await saved(page)
  expect(afterInvalidations.project).toEqual(before.project); expectOriginals(afterInvalidations, fixture)
  expect((await download(page, daw(page, 'export'))).bytes.equals(wavBefore.bytes)).toBe(true)
  expectQuiet(observed)
  await evidence(testInfo, 'tempo-real-taps.json', { clock: 'Unmodified native performance.now observed during trusted UI events',
    tapRuns, before: before.project, applied: applied.project, afterInvalidations: afterInvalidations.project,
    untakenNative, native, observed, beforeWavSha256: sha256(wavBefore.bytes), appliedWavSha256: sha256(appliedWav.bytes) })
})

test('use playback position anchors the grid to the advancing native AudioContext clock and resets with history', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const fixture = await selectionFixture(), observed = observeRequests(page)
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes)
  const before = await saved(page), wavBefore = await download(page, daw(page, 'export'))
  await openTempo(page, true)
  await daw(page, 'begin').click(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  // Wait for real playback progress, not an arbitrary wall-clock sleep.
  await page.waitForFunction(() => Number(document.querySelector('#daw-seek').value) >= .35)
  await tempo(page, 'use-position').click()
  const origin = Number(await originField(page).inputValue()), native = await nativeEvidence(page)
  const clickClock = await page.evaluate(() => window.__tempoNative.positionClicks.at(-1))
  const started = native.starts.filter(item => item.kind === 'realtime').at(-1), quantum = 128 / started.contextRate
  expect(clickClock.trusted).toBe(true); expect(clickClock.after).not.toBeNull()
  expect(origin).toBeGreaterThan(.3)
  expect(origin).toBeGreaterThanOrEqual(started.args[1] + clickClock.before - started.contextTime - quantum)
  expect(origin).toBeLessThanOrEqual(started.args[1] + clickClock.after - started.contextTime + quantum)
  await expect(daw(page, 'play')).toHaveText('播放混音')
  const anchored = await saved(page)
  metadataOnly(anchored.project, before.project, { gridOriginSeconds: origin })
  expect(anchored.project.revision).toBe(before.project.revision + 1); expectOriginals(anchored, fixture)
  expect((await download(page, daw(page, 'export'))).bytes.equals(wavBefore.bytes)).toBe(true)
  await tempo(page, 'reset-origin').click(); await expect(originField(page)).toHaveValue('0')
  await expect(page.locator('.daw-grid-origin-marker')).toHaveCount(0)
  const reset = await saved(page)
  metadataOnly(reset.project, before.project, { gridOriginSeconds: 0 })
  await daw(page, 'undo').click(); expect((await saved(page)).project).toEqual(anchored.project)
  await daw(page, 'redo').click(); expect((await saved(page)).project).toEqual(reset.project)
  expectQuiet(observed)
  await evidence(testInfo, 'tempo-playback-origin.json', { started, clickClock, nativeQuantumSeconds: quantum, origin,
    before: before.project, anchored: anchored.project, reset: reset.project, native, observed })
})

async function horizontalGeometry(page) {
  return page.evaluate(() => ({ viewport: { width: innerWidth, height: innerHeight }, windowX: scrollX,
    nodes: ['html', 'body', '#app', '#mode-editor', '.daw-arrangement', '.daw-grid-fields', '#daw-tempo-tools', '.daw-tempo-controls'].map(selector => {
      const node = document.querySelector(selector), box = node.getBoundingClientRect()
      return { selector, box: box.toJSON(), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, scrollLeft: node.scrollLeft,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop, overflowX: getComputedStyle(node).overflowX }
    }) }))
}
function expectNoOverflow(geometry) {
  expect(geometry.windowX).toBe(0)
  for (const item of geometry.nodes) {
    expect(item.scrollWidth, `${item.selector} actual horizontal content`).toBeLessThanOrEqual(item.clientWidth)
    expect(item.scrollLeft).toBe(0)
    if (item.box.width) { expect(item.box.left).toBeGreaterThanOrEqual(-1); expect(item.box.right).toBeLessThanOrEqual(geometry.viewport.width + 1) }
  }
}
async function reachable(page, control) {
  await control.scrollIntoViewIfNeeded()
  const box = await control.boundingBox(), transport = await page.locator('.daw-transport').boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 1)
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(transport.y + 1)
  expect(await control.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) })).toBe(true)
  return box
}
async function keyboardDisclosure(page, selector, open, playing = false) {
  const disclosure = page.locator(selector), summary = disclosure.locator(':scope > summary')
  const before = await page.evaluate(() => ({ starts: window.__tempoNative.starts.length, renders: window.__tempoNative.renders.length,
    position: Number(document.querySelector('#daw-seek').value) }))
  await summary.focus(); await summary.press('Space')
  await expect.poll(() => disclosure.evaluate(node => node.open)).toBe(open)
  await expect(daw(page, 'play')).toHaveText(playing ? '暫停' : '播放混音')
  const after = await page.evaluate(() => ({ starts: window.__tempoNative.starts.length, renders: window.__tempoNative.renders.length,
    position: Number(document.querySelector('#daw-seek').value) }))
  expect(after.starts, 'Space on a summary must not start or restart native playback').toBe(before.starts)
  expect(after.renders, 'Space on a summary must not request audio rendering').toBe(before.renders)
  if (playing) expect(after.position).toBeGreaterThanOrEqual(before.position)
  return { selector, open, playing, before, after }
}
for (const width of [1440, 390]) test(`tempo guidance stays compact, reachable and free of horizontal overflow at ${width}×844`, async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const fixture = await selectionFixture(), observed = observeRequests(page)
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes)
  await expect(page.locator('.daw-tempo-controls')).not.toHaveAttribute('open', '')
  await expect(tempo(page, 'tap')).toBeHidden()
  const closed = await horizontalGeometry(page)
  expectNoOverflow(closed); await screenshot(page, testInfo, `tempo-closed-${width}.png`)
  const keyboard = []
  keyboard.push(await keyboardDisclosure(page, '.daw-grid-settings', true))
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-controls', true))
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-origin-details', true))
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-origin-details', false))
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-controls', false))
  expect((await page.locator('#daw-tempo-tools').boundingBox()).height).toBeLessThanOrEqual(60)
  const targets = {}
  for (const selector of ['#daw-tempo', '#daw-grid', '#daw-zoom', '.daw-tempo-controls > summary']) targets[selector] = await reachable(page, page.locator(selector))
  targets.snap = await reachable(page, page.locator('.daw-grid-fields .daw-check'))
  await screenshot(page, testInfo, `tempo-settings-${width}.png`)
  const tapRun = await collectTaps(page)
  await details(page, '.daw-tempo-origin-details')
  await originField(page).fill('.31234567'); await tempo(page, 'apply-origin').click()
  // Applying an origin invalidates the previous BPM proposal; repopulate it
  // through real interaction to inspect the complete set of active controls.
  const finalTapRun = await collectTaps(page)
  for (const name of ['tap', 'reset', 'half', 'double', 'apply', 'apply-origin', 'use-position', 'reset-origin']) {
    await expect(tempo(page, name)).toBeVisible(); await expect(tempo(page, name)).toBeEnabled()
    targets[name] = await reachable(page, tempo(page, name))
  }
  targets.origin = await reachable(page, originField(page))
  targets.originDisclosure = await reachable(page, page.locator('.daw-tempo-origin-details > summary'))
  const expanded = await horizontalGeometry(page)
  expectNoOverflow(expanded); await screenshot(page, testInfo, `tempo-expanded-${width}.png`)
  await daw(page, 'begin').click(); await daw(page, 'play').click()
  await expect(daw(page, 'play')).toHaveText('暫停')
  await page.waitForFunction(() => Number(document.querySelector('#daw-seek').value) >= .1)
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-origin-details', false, true))
  keyboard.push(await keyboardDisclosure(page, '.daw-tempo-controls', false, true))
  expect((await page.locator('#daw-tempo-tools').boundingBox()).height).toBeLessThanOrEqual(60)
  await expect(tempo(page, 'tap')).toBeHidden()
  keyboard.push(await keyboardDisclosure(page, '.daw-grid-settings', false, true))
  await daw(page, 'stop').click()
  const final = await horizontalGeometry(page)
  expectNoOverflow(final); expectQuiet(observed)
  await evidence(testInfo, `tempo-layout-${width}.json`, { closed, expanded, final, targets, keyboard, tapRun, finalTapRun, observed })
})
