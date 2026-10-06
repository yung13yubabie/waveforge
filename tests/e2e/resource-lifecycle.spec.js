/** CI-only native-browser probe. Synthetic audio only; never requests models.
 * Ownership assertions are strict. Heap/WeakRef observations are diagnostic,
 * not a pass/fail claim about the native audio allocator or permanent leaks.
 */
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

function fixture(name = 'resource-probe.wav') {
  const rate = 48000, pcm = new Float32Array(rate)
  for (let i = 0; i < pcm.length; i++) pcm[i] = .05 * Math.sin(2 * Math.PI * 440 * i / rate)
  return { name, mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV([pcm], rate, 24)) }
}
const action = (page, name) => page.locator(`[data-daw="${name}"]`)

async function instrument(page) {
  await page.addInitScript(() => {
    const workers = new Set(), sources = new Set(), urls = new Set(), listeners = new Set()
    const ids = new WeakMap(), seenBuffers = new WeakSet(); let nextId = 0, buffers = []
    const id = value => { if (!ids.has(value)) ids.set(value, ++nextId); return ids.get(value) }
    const trackBuffer = buffer => {
      if (buffer && !seenBuffers.has(buffer)) {
        seenBuffers.add(buffer); buffers.push({ ref: new WeakRef(buffer), bytes: buffer.length * buffer.numberOfChannels * 4 })
      }
      return buffer
    }
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(...args) { super(...args); workers.add(id(this)) }
      terminate() { workers.delete(id(this)); return super.terminate() }
    }
    const base = BaseAudioContext.prototype, createSource = base.createBufferSource, createBuffer = base.createBuffer
    base.createBuffer = function (...args) { return trackBuffer(createBuffer.apply(this, args)) }
    base.createBufferSource = function (...args) {
      const node = createSource.apply(this, args), key = id(node), connect = node.connect, disconnect = node.disconnect
      node.connect = function (...args) { const result = connect.apply(this, args); sources.add(key); return result }
      node.disconnect = function (...args) { const result = disconnect.apply(this, args); sources.delete(key); return result }
      return node
    }
    const decode = base.decodeAudioData
    base.decodeAudioData = function (...args) { return decode.apply(this, args).then(trackBuffer) }
    const render = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) { return render.apply(this, args).then(trackBuffer) }
    const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL
    URL.createObjectURL = function (...args) { const value = createURL.apply(this, args); urls.add(value); return value }
    URL.revokeObjectURL = function (value) { urls.delete(value); return revokeURL.call(this, value) }
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener
    const listenerKey = (target, type, fn, options) => `${target === window ? 'window' : 'document'}:${type}:${Boolean(typeof options === 'boolean' ? options : options?.capture)}:${id(fn)}`
    EventTarget.prototype.addEventListener = function (type, fn, options) {
      // Once-listeners remove themselves natively; do not count those as leaks.
      if ((this === window || this === document) && fn && !options?.once) listeners.add(listenerKey(this, type, fn, options))
      return add.call(this, type, fn, options)
    }
    EventTarget.prototype.removeEventListener = function (type, fn, options) {
      if ((this === window || this === document) && fn) listeners.delete(listenerKey(this, type, fn, options))
      return remove.call(this, type, fn, options)
    }
    const arrayBuffer = Blob.prototype.arrayBuffer; let blockedReads = 0, releaseRead
    Blob.prototype.arrayBuffer = function (...args) {
      if (this.name !== 'resource-delayed.wav') return arrayBuffer.apply(this, args)
      blockedReads++
      return arrayBuffer.apply(this, args).then(bytes => new Promise(resolve => { releaseRead = () => resolve(bytes) }))
    }
    window.__resourceProbe = {
      releaseRead: () => releaseRead?.(),
      snapshot() {
        buffers = buffers.filter(entry => entry.ref.deref())
        return { workers: workers.size, connectedSources: sources.size, objectURLs: urls.size,
          globalListeners: listeners.size, observedLiveAudioBuffers: buffers.length,
          observedLivePcmBytes: buffers.reduce((sum, item) => sum + item.bytes, 0), blockedReads, readReady: Boolean(releaseRead) }
      },
    }
  })
}

test('cancelled input reads remain single-flight through clear and retry', async ({ page }) => {
  await instrument(page); await page.goto('/'); await page.locator('#tab-editor').click()
  await page.setInputFiles('#daw-audio-files', fixture('resource-delayed.wav'))
  await expect(action(page, 'cancel')).toBeVisible(); await action(page, 'cancel').click()
  for (let index = 0; index < 10; index++) {
    await page.setInputFiles('#daw-audio-files', fixture('resource-delayed.wav'))
    await expect(page.locator('#daw-status')).toContainText('上一批音檔')
  }
  expect((await page.evaluate(() => window.__resourceProbe.snapshot())).blockedReads).toBe(1)
  await expect.poll(async () => (await page.evaluate(() => window.__resourceProbe.snapshot())).readReady).toBe(true)
  await page.evaluate(() => window.__resourceProbe.releaseRead())
  await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
  await page.setInputFiles('#daw-audio-files', fixture())
  await expect(page.locator('#daw-summary')).toContainText('1 軌 · 1 片段')
})

test('warmed repeated import, pitch cancel, render, download, restore and clear release owned resources', async ({ page, context }, testInfo) => {
  test.setTimeout(120000)
  const unexpectedNetwork = [], errors = []
  await page.route('**/*', route => {
    const request = route.request()
    if (!['GET', 'HEAD'].includes(request.method()) || request.postDataBuffer() || /huggingface|cdn-lfs|\.onnx(?:\?|$)/.test(request.url())) {
      unexpectedNetwork.push({ method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0 })
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept())
  await instrument(page); await page.goto('/')
  const cdp = await context.newCDPSession(page), samples = []
  const sample = async round => {
    await cdp.send('HeapProfiler.collectGarbage')
    await page.waitForTimeout(25)
    await cdp.send('HeapProfiler.collectGarbage')
    return { round, ...await page.evaluate(() => window.__resourceProbe.snapshot()), heap: await cdp.send('Runtime.getHeapUsage') }
  }
  let warmed
  for (let round = 0; round < 10; round++) {
    await page.setInputFiles('#file-input', fixture())
    await expect(page.locator('#pitch-source')).toContainText('resource-probe.wav')
    await page.locator('#tab-pitch').click()
    // Same-turn cancellation is deterministic even when a fast CPU finishes a
    // one-second analysis before a second Playwright click can arrive.
    await page.evaluate(() => { document.getElementById('pitch-analyze').click(); document.getElementById('pitch-cancel').click() })
    await expect(page.locator('#pitch-status')).toContainText('已取消分析')
    await page.locator('#tab-editor').click(); await page.setInputFiles('#daw-audio-files', fixture())
    await expect(page.locator('#daw-summary')).toContainText('1 軌 · 1 片段')
    await action(page, 'play').click(); await expect(action(page, 'play')).toHaveText('暫停'); await action(page, 'stop').click()
    const downloadReady = page.waitForEvent('download'); await action(page, 'save').click()
    const zip = await readFile(await (await downloadReady).path())
    // A failed ZIP open must preserve the accepted source and editing state.
    const before = await page.locator('#daw-summary').textContent()
    await page.setInputFiles('#daw-project-file', { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('not a ZIP') })
    await expect(page.locator('#daw-status')).toHaveAttribute('data-error', 'true')
    expect(await page.locator('#daw-summary').textContent()).toBe(before)
    await action(page, 'clear').click(); await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
    await page.setInputFiles('#daw-project-file', { name: 'restore.waveforge.zip', mimeType: 'application/zip', buffer: zip })
    await expect(page.locator('#daw-status')).toContainText('工程已還原')
    await action(page, 'clear').click()
    await page.locator('.mode-tab[data-mode="master"]').click()
    await page.locator('#session-privacy').evaluate(element => { element.open = true })
    await page.locator('#clear-session-btn').click()
    await expect(page.locator('#pitch-source')).toHaveText('尚未載入音訊')
    // The 1000/1500 ms download handoff timers are part of intentional ownership.
    await expect.poll(async () => (await page.evaluate(() => window.__resourceProbe.snapshot())).objectURLs).toBe(0)
    const observed = await sample(round); samples.push(observed)
    expect(observed.connectedSources).toBe(0); expect(observed.workers).toBe(0)
    if (round === 2) warmed = observed
    if (round > 2) expect(observed.globalListeners).toBe(warmed.globalListeners)
  }
  const measured = samples.slice(3), first = measured[0].heap.usedSize, last = measured.at(-1).heap.usedSize
  await testInfo.attach('resource-lifecycle.json', { body: JSON.stringify({ warmupRounds: 3, measuredRounds: 7,
    ownershipTolerance: { connectedSources: 0, objectURLs: 0, workers: 0, globalListenerGrowth: 0 },
    heapAcceptanceThreshold: null, warmedHeapDeltaBytes: last - first, samples,
    caveat: 'Heap/WeakRef observations do not measure all native allocations or prove absence of leaks. Review warmed trends and retaining paths; do not use a single RSS drop.' }, null, 2), contentType: 'application/json' })
  expect(unexpectedNetwork).toEqual([]); expect(errors).toEqual([])
})
