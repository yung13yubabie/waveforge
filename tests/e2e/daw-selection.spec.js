/** Real UI → native Web Audio → downloaded PCM24/ZIP regression evidence.
 * Synthetic media only. Native observers forward every decoder/render/start.
 * The cancellation case alone delays delivery of a REAL native render result;
 * it never fabricates PCM, successful rendering, decoding, or playback.
 * Browser execution belongs to authorized CI, not restricted local Chromium. */
import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { selectionFixture, readSelectionArchive, readSelectionWav, sha256,
  SELECTION_RANGE, PROJECT_SECONDS } from '../fixtures/daw-selection-fixture.js'

test.use({ screenshot: 'only-on-failure' })

const daw = (page, action) => page.locator(`[data-daw="${action}"]`)
const range = (page, action) => page.locator(`[data-range-action="${action}"]`)
const endpoint = (page, name) => page.locator(`[data-range-endpoint="${name}Seconds"]`)
const handle = (page, name) => page.locator(`[data-range-handle="${name}Seconds"]`)
async function evidence(testInfo, name, value) {
  const path = testInfo.outputPath(name)
  await writeFile(path, JSON.stringify(value, null, 2))
  await testInfo.attach(name, { path, contentType: 'application/json' })
}
async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path, fullPage: false })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}
function observeRequests(page) {
  const observed = { pageErrors: [], uploads: [], models: [] }
  page.on('pageerror', error => observed.pageErrors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT', 'PATCH'].includes(request.method())) observed.uploads.push(request.url())
    if (/huggingface|\.onnx(?:\?|$)/.test(request.url())) observed.models.push(request.url())
  })
  return observed
}
function expectQuiet(observed) { expect(observed).toEqual({ pageErrors: [], uploads: [], models: [] }) }
async function load(page, bytes) {
  await page.locator('#tab-editor').click()
  await page.locator('#daw-project-file').setInputFiles({ name: 'synthetic-selection.waveforge.zip', mimeType: 'application/zip', buffer: bytes })
  await expect(page.locator('#daw-status')).toContainText('工程已還原')
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
  await expect(page.locator('.daw-clip')).toHaveCount(4)
}
async function setRange(page, selection = SELECTION_RANGE) {
  const details = page.locator('.daw-selection-details')
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click()
  await endpoint(page, 'start').fill(String(selection.startSeconds))
  await endpoint(page, 'end').fill(String(selection.endSeconds))
  await range(page, 'apply').click()
  await expect(handle(page, 'start')).toHaveAttribute('aria-valuenow', String(selection.startSeconds))
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', String(selection.endSeconds))
  await details.locator('summary').click()
}
async function download(page, control) {
  const pending = page.waitForEvent('download')
  await control.click()
  const item = await pending
  expect(await item.failure()).toBeNull()
  return { name: item.suggestedFilename(), bytes: await readFile(await item.path()) }
}
async function savedProject(page) { return readSelectionArchive((await download(page, daw(page, 'save'))).bytes) }
function expectOriginals(saved, fixture) {
  expect(saved.project.assets).toEqual(fixture.project.assets)
  for (const [id, bytes] of fixture.originals) expect(saved.source(id).equals(bytes), `${id} remains byte-identical`).toBe(true)
}
function sliceProof(fullBytes, selectedBytes, rate, first, last) {
  const full = readSelectionWav(fullBytes), selected = readSelectionWav(selectedBytes)
  expect(full).toMatchObject({ tag: 1, rate, bits: 24, channels: 2, frames: PROJECT_SECONDS * rate })
  expect(selected).toMatchObject({ tag: 1, rate, bits: 24, channels: 2, frames: last - first })
  const expected = full.data.subarray(first * full.frameBytes, last * full.frameBytes)
  // One aggregate equality assertion, never hundreds of thousands of assertions.
  expect(selected.data.equals(expected), 'selected PCM24 must equal the exact half-open full-mix frame slice').toBe(true)
  return { rate, first, last, frames: last - first, fullFrames: full.frames,
    fullPayloadSha256: sha256(full.data), expectedPayloadSha256: sha256(expected), selectedPayloadSha256: sha256(selected.data) }
}

async function observeNative(page) {
  await page.addInitScript(() => {
    const state = window.__selectionNative = { starts: [], renders: [], holdNext: false, release: null }
    const ids = new WeakMap()
    let nextId = 1
    const id = buffer => { if (!ids.has(buffer)) ids.set(buffer, nextId++); return ids.get(buffer) }
    const create = BaseAudioContext.prototype.createBufferSource
    BaseAudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this, args), start = source.start
      const kind = this instanceof OfflineAudioContext ? 'offline' : 'realtime'
      source.start = function (...startArgs) {
        if (source.buffer) state.starts.push({ kind, buffer: source.buffer, bufferId: id(source.buffer), args: startArgs,
          loop: source.loop, loopStart: source.loopStart, loopEnd: source.loopEnd,
          playbackRate: source.playbackRate.value, detune: source.detune.value })
        return start.apply(source, startArgs)
      }
      return source
    }
    const render = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) {
      const hold = state.holdNext; state.holdNext = false
      const record = { rate: this.sampleRate, length: this.length, nativeComplete: false, held: hold, delivered: false }
      state.renders.push(record)
      return render.apply(this, args).then(buffer => {
        record.nativeComplete = true; record.nativeBuffer = buffer instanceof AudioBuffer; record.bufferId = id(buffer)
        if (!hold) return buffer
        // Explicit fault injection: withhold promise delivery, not native work.
        return new Promise(resolve => { state.release = () => { state.release = null; resolve(buffer) } })
      }).then(buffer => { record.delivered = true; return buffer })
    }
  })
}
async function nativeEvidence(page, first, last) {
  return page.evaluate(async ({ first, last }) => {
    const state = window.__selectionNative
    const realtime = state.starts.filter(item => item.kind === 'realtime')
    const record = realtime.at(-1)
    if (!record) throw new Error('No genuine realtime source.start observed')
    const buffer = record.buffer
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
    // Independent PCM24 conversion of the real audition buffer, not an app import.
    const bytes = new Uint8Array(buffer.length * channels.length * 3)
    let cursor = 0
    for (let frame = 0; frame < buffer.length; frame++) for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame]))
      const integer = Math.round(sample * (sample < 0 ? 8388608 : 8388607))
      bytes[cursor++] = integer & 255; bytes[cursor++] = (integer >> 8) & 255; bytes[cursor++] = (integer >> 16) & 255
    }
    const hash = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    return { renders: state.renders, sourceRates: [...new Set(state.starts.filter(item => item.kind === 'offline').map(item => item.buffer.sampleRate))].sort((a, b) => a - b),
      realtime: realtime.map(({ buffer, ...item }) => ({ ...item, nativeBuffer: buffer instanceof AudioBuffer,
        rate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels })),
      fullPayloadSha256: await hash(bytes), selectedPayloadSha256: await hash(bytes.subarray(first * channels.length * 3, last * channels.length * 3)) }
  }, { first, last })
}

for (const rate of [44100, 48000, 96000]) test(`selected PCM24 and real audition/loop equal the native mixed-rate full mix at ${rate} Hz`, async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const observed = observeRequests(page), fixture = await selectionFixture(rate)
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes)
  const full = await download(page, daw(page, 'export'))
  await setRange(page)
  // These non-integral decimal endpoints are deliberate. No production bounds
  // helper, saved manifest, download filename or render plan defines the oracle.
  const first = Math.floor(SELECTION_RANGE.startSeconds * rate), last = Math.ceil(SELECTION_RANGE.endSeconds * rate)
  const selected = await download(page, range(page, 'export'))
  expect(selected.name).toContain(`range-${first}-${last}.wav`)
  const equality = sliceProof(full.bytes, selected.bytes, rate, first, last)
  await range(page, 'play').click()
  await expect(page.locator('#daw-status')).toContainText('正在播放時間軸選區')
  await daw(page, 'stop').click()
  await range(page, 'loop').click()
  await expect(page.locator('#daw-status')).toContainText('正在循環時間軸選區')
  // Native start() may detach prior getChannelData backing stores. Export the
  // SAME cached selection while playing and after Stop, with no invalidating
  // edit between them; a stale-view bug otherwise creates a header-only WAV.
  const duringLoop = await download(page, range(page, 'export'))
  expect(duringLoop.bytes.equals(selected.bytes)).toBe(true)
  const native = await nativeEvidence(page, first, last)
  await daw(page, 'stop').click()
  const afterStop = await download(page, range(page, 'export'))
  expect(afterStop.bytes.equals(selected.bytes)).toBe(true)
  expect(native.sourceRates).toEqual([44100, 96000])
  expect(native.realtime).toHaveLength(2)
  const [audition, loop] = native.realtime
  for (const item of native.realtime) expect(item).toMatchObject({ nativeBuffer: true, rate, frames: PROJECT_SECONDS * rate, channels: 2, playbackRate: 1, detune: 0 })
  expect(audition.args).toHaveLength(3)
  expect(audition.args[0]).toBe(0); expect(audition.args[1]).toBe(first / rate)
  expect(audition.args[2]).toBeCloseTo((last - first) / rate, 12)
  expect(audition.loop).toBe(false)
  expect(loop.args).toEqual([0, first / rate]); expect(loop.loop).toBe(true)
  expect(loop.loopStart).toBe(first / rate); expect(loop.loopEnd).toBe(last / rate)
  expect(loop.bufferId).toBe(audition.bufferId)
  expect(loop.bufferId).toBe(native.renders.at(-1).bufferId)
  expect(native.renders.every(item => item.nativeBuffer && item.nativeComplete && item.delivered && !item.held)).toBe(true)
  expect(native.fullPayloadSha256).toBe(equality.fullPayloadSha256)
  expect(native.selectedPayloadSha256).toBe(equality.selectedPayloadSha256)
  let gapEquality = null
  if (rate === 48000) {
    await setRange(page, { startSeconds: 2.8, endSeconds: 3 })
    const gap = await download(page, range(page, 'export'))
    gapEquality = sliceProof(full.bytes, gap.bytes, rate, 134400, 144000)
    expect(readSelectionWav(gap.bytes).data.some(byte => byte !== 0), 'a valid all-gap range exports digital silence').toBe(false)
  }
  // Exact-frame EOF is a distinct regression: retain all 97 final frames,
  // including nonzero fade-out samples, with no ceil-induced extra frame.
  const tailFirst = PROJECT_SECONDS * rate - 97
  await setRange(page, { startSeconds: tailFirst / rate, endSeconds: PROJECT_SECONDS })
  const tail = await download(page, range(page, 'export'))
  const tailEquality = sliceProof(full.bytes, tail.bytes, rate, tailFirst, PROJECT_SECONDS * rate)
  const tailPcm = readSelectionWav(tail.bytes)
  expect(tailPcm.data.subarray(-tailPcm.frameBytes).some(byte => byte !== 0), 'the last EOF frame contains genuine fade-out audio').toBe(true)
  const saved = await savedProject(page)
  expectOriginals(saved, fixture); expect(saved.project.tracks).toEqual(fixture.project.tracks)
  expectQuiet(observed)
  await evidence(testInfo, `selection-native-${rate}.json`, { equality, tailEquality, gapEquality, native, observed,
    unchangedSelectionAfterPlayback: { duringLoopSha256: sha256(duringLoop.bytes), afterStopSha256: sha256(afterStop.bytes) },
    syntheticSourceHashes: Object.fromEntries([...fixture.originals].map(([id, bytes]) => [id, sha256(bytes)])) })
})

test('range ZIP survives a fresh document, selection undo/redo and tail deletion with atomic recovery', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const observed = observeRequests(page), fixture = await selectionFixture()
  await page.goto('/'); await load(page, fixture.bytes)
  const originalWav = await download(page, daw(page, 'export'))
  await setRange(page)
  const selectedWav = await download(page, range(page, 'export'))
  const selectedZip = await download(page, daw(page, 'save')), saved = readSelectionArchive(selectedZip.bytes)
  expect(saved.project.timelineSelection).toEqual(SELECTION_RANGE)
  expect(saved.project.tracks).toEqual(fixture.project.tracks); expectOriginals(saved, fixture)
  await daw(page, 'undo').click()
  await expect(range(page, 'export')).toBeHidden(); await expect(page.locator('[data-range-handle]')).toHaveCount(0)
  expect((await download(page, daw(page, 'export'))).bytes.equals(originalWav.bytes)).toBe(true)
  await daw(page, 'redo').click()
  expect((await download(page, range(page, 'export'))).bytes.equals(selectedWav.bytes)).toBe(true)
  // Saved archive, new JS document, real decoder: no in-memory project injection.
  await page.reload(); await load(page, selectedZip.bytes)
  await expect(handle(page, 'start')).toHaveAttribute('aria-valuenow', String(SELECTION_RANGE.startSeconds))
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', String(SELECTION_RANGE.endSeconds))
  expect((await download(page, range(page, 'export'))).bytes.equals(selectedWav.bytes)).toBe(true)
  expect((await download(page, daw(page, 'export'))).bytes.equals(originalWav.bytes)).toBe(true)
  await page.locator('.daw-clip[data-clip-id="tail-96"]').click()
  await daw(page, 'delete').click()
  await expect(page.locator('#daw-status')).toContainText('原選區已超出工程，已清除')
  await expect(range(page, 'export')).toBeHidden()
  const shrunk = await savedProject(page)
  expect(shrunk.project.timelineSelection).toBeUndefined()
  expect(shrunk.project.tracks.flatMap(track => track.clips).map(clip => clip.id)).not.toContain('tail-96')
  expect(readSelectionWav((await download(page, daw(page, 'export'))).bytes).frames).toBe(4.125 * 48000)
  await daw(page, 'undo').click()
  expect((await download(page, range(page, 'export'))).bytes.equals(selectedWav.bytes)).toBe(true)
  const restored = await savedProject(page)
  expect(restored.project).toEqual(saved.project); expectOriginals(restored, fixture)
  await daw(page, 'redo').click(); await expect(range(page, 'export')).toBeHidden()
  expectQuiet(observed)
  await evidence(testInfo, 'selection-history-archive.json', { before: fixture.project, saved: saved.project,
    shrunk: shrunk.project, restored: restored.project, selectedWavSha256: sha256(selectedWav.bytes), originalWavSha256: sha256(originalWav.bytes), observed })
})

test('cancel and workspace navigation reject delayed genuine native range renders with no late WAV or project commit', async ({ page }, testInfo) => {
  test.setTimeout(60000)
  const observed = observeRequests(page), fixture = await selectionFixture()
  await observeNative(page); await page.goto('/'); await load(page, fixture.bytes); await setRange(page)
  const baseline = await savedProject(page), unexpectedWavs = [], attempts = []
  const onDownload = item => { if (item.suggestedFilename().endsWith('.wav')) unexpectedWavs.push(item.suggestedFilename()) }
  page.on('download', onDownload)
  for (const interruption of ['cancel', 'navigate']) {
    await page.evaluate(() => { window.__selectionNative.holdNext = true })
    await range(page, 'export').click()
    await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'true')
    await page.waitForFunction(() => window.__selectionNative.renders.at(-1)?.nativeComplete && typeof window.__selectionNative.release === 'function')
    if (interruption === 'cancel') await daw(page, 'cancel').click()
    else { await page.locator('#tab-lyrics').click(); await expect(page.locator('#mode-editor')).toBeHidden() }
    // Release only after the real user action. Two animation frames allow the
    // rejected continuation and the queued download handoff to finish settling.
    await page.evaluate(async () => {
      window.__selectionNative.release()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await page.waitForFunction(() => window.__selectionNative.renders.at(-1)?.delivered)
    if (interruption === 'navigate') {
      await expect(page.locator('#mode-lyrics')).toBeVisible()
      await page.locator('#tab-editor').click()
    }
    await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
    const after = await savedProject(page)
    expect(after.project).toEqual(baseline.project); expectOriginals(after, fixture)
    expect(unexpectedWavs).toEqual([])
    attempts.push({ interruption, projectUnchanged: true, render: await page.evaluate(() => window.__selectionNative.renders.at(-1)) })
  }
  page.off('download', onDownload)
  const recovered = await download(page, range(page, 'export'))
  expect(readSelectionWav(recovered.bytes).frames).toBe(Math.ceil(SELECTION_RANGE.endSeconds * 48000) - Math.floor(SELECTION_RANGE.startSeconds * 48000))
  expect(attempts.every(item => item.render.nativeBuffer && item.render.nativeComplete && item.render.held && item.render.delivered)).toBe(true)
  expectQuiet(observed)
  await evidence(testInfo, 'selection-cancel-native-delivery.json', {
    faultInjection: 'Delay delivery of the real OfflineAudioContext.startRendering promise; keep native rendering and PCM untouched',
    attempts, unexpectedWavs, recoveredWavSha256: sha256(recovered.bytes), observed,
  })
})

async function horizontalGeometry(page) {
  return page.evaluate(() => ({ windowX: scrollX, viewport: { width: innerWidth, height: innerHeight },
    nodes: ['html', 'body', '#app', '#mode-editor', '.daw-arrangement', '.daw-selection-controls', '#daw-timeline'].map(selector => {
      const element = document.querySelector(selector), box = element.getBoundingClientRect(), css = getComputedStyle(element)
      return { selector, x: box.x, right: box.right, width: box.width, clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft, overflowX: css.overflowX }
    }) }))
}
function expectNoPageOverflow(snapshot) {
  expect(snapshot.windowX).toBe(0)
  for (const item of snapshot.nodes.filter(item => item.selector !== '#daw-timeline')) {
    expect(item.scrollWidth, `${item.selector} actual scroll width`).toBeLessThanOrEqual(item.clientWidth)
    expect(item.scrollLeft, `${item.selector} must not silently scroll horizontally`).toBe(0)
    expect(item.x).toBeGreaterThanOrEqual(-1); expect(item.right).toBeLessThanOrEqual(snapshot.viewport.width + 1)
  }
}
async function expectReachable(page, control, width) {
  await control.scrollIntoViewIfNeeded()
  const box = await control.boundingBox(), transport = await page.locator('.daw-transport').boundingBox()
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44)
  expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(transport.y + 1)
  expect(await control.evaluate(element => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) })).toBe(true)
  return box
}

for (const width of [1440, 390]) test(`range drawing, endpoint keyboard/drag and horizontal scrolling stay usable at ${width}×844`, async ({ page }, testInfo) => {
  const observed = observeRequests(page), fixture = await selectionFixture()
  await page.setViewportSize({ width, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/'); await load(page, fixture.bytes)
  const controls = page.locator('.daw-selection-controls'), timeline = page.locator('#daw-timeline')
  await expect(page.locator('.daw-selection-details')).not.toHaveAttribute('open', '')
  await expect(endpoint(page, 'start')).toBeHidden(); await expect(range(page, 'export')).toBeHidden()
  expect((await controls.boundingBox()).height).toBeLessThanOrEqual(60)
  const initial = await horizontalGeometry(page)
  await screenshot(page, testInfo, `selection-default-${width}.png`)
  expectNoPageOverflow(initial)
  await page.locator('.daw-grid-settings > summary').click()
  await page.locator('#daw-zoom').selectOption('96')
  await page.locator('#daw-grid').selectOption('0.25')
  await expect(page.locator('#daw-snap')).toBeChecked()
  await page.locator('.daw-grid-settings > summary').click()
  await range(page, 'draw').click()
  // Real wheel input scrolls only the arrangement. The page is never reset to
  // hide a horizontal layout defect; pointer coordinates use its live lane rect.
  await timeline.hover(); await page.mouse.wheel(280, 0)
  await expect.poll(() => timeline.evaluate(element => element.scrollLeft)).toBeGreaterThan(200)
  const lane = await page.locator('.daw-ruler-lane').boundingBox()
  const y = lane.y + 16
  await page.mouse.move(lane.x + 3.5 * 96, y); await page.mouse.down()
  await page.mouse.move(lane.x + 4.5 * 96, y, { steps: 8 }); await page.mouse.up()
  await expect(handle(page, 'start')).toHaveAttribute('aria-valuenow', '3.5')
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', '4.5')
  await range(page, 'draw').click()
  await handle(page, 'end').focus(); await page.keyboard.press('ArrowRight')
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', '4.625')
  await page.keyboard.press('ArrowLeft')
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', '4.5')
  const startTarget = await expectReachable(page, handle(page, 'start'), width)
  await page.mouse.move(startTarget.x + startTarget.width / 2, startTarget.y + startTarget.height / 2)
  await page.mouse.down(); await page.mouse.move(startTarget.x + startTarget.width / 2 + 48, startTarget.y + startTarget.height / 2, { steps: 6 }); await page.mouse.up()
  await expect(handle(page, 'start')).toHaveAttribute('aria-valuenow', '4')
  const targets = {}
  for (const name of ['draw', 'play', 'loop', 'export', 'clear']) targets[name] = await expectReachable(page, range(page, name), width)
  targets.precision = await expectReachable(page, page.locator('.daw-selection-details > summary'), width)
  for (const name of ['start', 'end']) targets[name] = await expectReachable(page, handle(page, name), width)
  expect((await controls.boundingBox()).height).toBeLessThanOrEqual(width === 390 ? 106 : 60)
  const activeToolbar = await controls.boundingBox(), transport = await page.locator('.daw-transport').boundingBox()
  expect(activeToolbar.y).toBeGreaterThanOrEqual(0)
  expect(activeToolbar.y + activeToolbar.height, 'both active command rows remain above the transport').toBeLessThanOrEqual(transport.y)
  const selected = await horizontalGeometry(page)
  await screenshot(page, testInfo, `selection-active-${width}.png`)
  expectNoPageOverflow(selected)
  expect(selected.nodes.find(item => item.selector === '#daw-timeline').scrollLeft).toBeGreaterThan(200)
  // Escape during a genuine pointer gesture discards only the preview.
  await range(page, 'draw').click()
  const currentLane = await page.locator('.daw-ruler-lane').boundingBox()
  await page.mouse.move(currentLane.x + 4.75 * 96, currentLane.y + 16); await page.mouse.down()
  await page.mouse.move(currentLane.x + 4.875 * 96, currentLane.y + 16, { steps: 3 })
  await page.keyboard.press('Escape'); await page.mouse.up()
  await expect(handle(page, 'start')).toHaveAttribute('aria-valuenow', '4')
  await expect(handle(page, 'end')).toHaveAttribute('aria-valuenow', '4.5')
  await expect(range(page, 'draw')).toHaveAttribute('aria-pressed', 'false')
  const saved = await savedProject(page)
  expect(saved.project.timelineSelection).toEqual({ startSeconds: 4, endSeconds: 4.5 })
  expect(saved.project.tracks).toEqual(fixture.project.tracks)
  expectQuiet(observed)
  await evidence(testInfo, `selection-layout-${width}.json`, { initial, selected, targets, savedRange: saved.project.timelineSelection, observed })
})
