/** Genuine Signalsmith Worker/WASM ownership, separate from PCM-equality observers.
 * Uses only UI and transparent Web API observers. No retained PCM/AudioBuffer or
 * Worker references in evidence; WeakRefs are diagnostic, never a heap guarantee.
 * Works with dev and hashed built worker URLs; imports no app modules in-page.
 * The second test injects a labelled Worker error after real DSP progress. It
 * does not claim a spontaneous crash, timeout or successful native error path.
 */
import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { encodeWAV } from '../../src/js/audio/wav.js'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)
const review = page => page.locator('#daw-replacement-review')
function fixture() {
  const rate = 48000, length = rate * 2
  const channels = [220, 330].map(frequency => Float32Array.from({ length }, (_, i) => .08 * Math.sin(2 * Math.PI * frequency * i / rate)))
  return { name: 'synthetic-lifecycle.wav', mimeType: 'audio/wav', buffer: Buffer.from(encodeWAV(channels, rate, 24)) }
}
async function savedProjectHash(page) {
  const ready = page.waitForEvent('download')
  await action(page, 'save').click()
  const download = await ready
  expect(await download.failure()).toBeNull()
  return createHash('sha256').update(await readFile(await download.path())).digest('hex')
}
const snapshot = page => page.evaluate(() => window.__signalsmithLifecycle.snapshot())
async function ownershipSettled(page) {
  await expect.poll(async () => {
    const observed = await snapshot(page)
    return [observed.liveWorkers, observed.connectedSources, observed.pendingNativeRenders, observed.objectURLs]
  }).toEqual([0, 0, 0, 0])
}
async function loadSource(page) {
  await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles(fixture())
  await expect(page.locator('.daw-clip')).toHaveCount(1)
  if (!await page.locator('#daw-transpose-details').evaluate(el => el.open)) await page.locator('#daw-transpose-details > summary').click()
  await page.locator('#daw-transpose-semitones').fill('1')
  await page.locator('#daw-transpose-semitones').dispatchEvent('change')
  await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
}
async function installProbe(page, records) {
  await page.route('**/*', route => {
    const request = route.request()
    if (!['GET', 'HEAD'].includes(request.method()) || request.postDataBuffer() || /huggingface|cdn-lfs|\.onnx(?:\?|$)/.test(request.url())) {
      records.unexpectedNetwork.push({ method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0 })
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
  page.on('pageerror', error => records.pageErrors.push(error.message))
  page.on('dialog', dialog => dialog.accept())
  await page.addInitScript(() => {
    const workers = new Set(), sources = new Set(), renders = new Set(), urls = new Set()
    const seenBuffers = new WeakSet(), attempts = [], nativeRenders = []
    let nextId = 0, buffers = [], interruption = null, cancelNextRender = false, realtimeStarts = 0
    const trackBuffer = buffer => {
      if (buffer && !seenBuffers.has(buffer)) {
        seenBuffers.add(buffer)
        buffers.push({ ref: new WeakRef(buffer), bytes: buffer.length * buffer.numberOfChannels * 4 })
      }
      return buffer
    }
    const click = name => {
      const button = document.querySelector(`[data-daw="${name}"]`)
      if (!button || button.disabled) throw new Error(`Lifecycle interruption control unavailable: ${name}`)
      button.click()
    }
    window.Worker = new Proxy(window.Worker, {
      construct(Target, args, NewTarget) {
        const worker = Reflect.construct(Target, args, NewTarget)
        if (!/\/signalsmith-worker(?:-[^/?]+)?\.js(?:\?|$)/.test(String(args[0]))) return worker
        const id = ++nextId, entry = { id, url: String(args[0]), posts: 0, transferredBytes: 0, detached: false,
          dspProgress: null, results: 0, terminateCalls: 0, interruption: null, injectedError: false }
        attempts.push(entry); workers.add(id)
        const nativePost = worker.postMessage, nativeTerminate = worker.terminate
        worker.postMessage = function (message, ...rest) {
          const pcm = message?.type === 'render' ? message.channels : null
          if (pcm) { entry.posts++; entry.transferredBytes = pcm.reduce((sum, channel) => sum + channel.byteLength, 0) }
          const returned = nativePost.call(this, message, ...rest)
          if (pcm) entry.detached = pcm.every(channel => channel.buffer.byteLength === 0)
          return returned
        }
        worker.terminate = function (...args) {
          entry.terminateCalls++; const returned = nativeTerminate.apply(this, args); workers.delete(id); return returned
        }
        worker.addEventListener('message', ({ data }) => {
          if (data?.type === 'result') entry.results++
          if (data?.type !== 'progress' || !(data.progress > .08 && data.progress < 1)) return
          // Source audit: >.08 is emitted only after wasm._process(), while .08
          // itself can be pre-load progress. Do not confuse the two boundaries.
          entry.dspProgress ??= data.progress
          if (!interruption) return
          const kind = interruption; interruption = null; entry.interruption = kind
          if (kind === 'injected-error') {
            entry.injectedError = true
            worker.dispatchEvent(new ErrorEvent('error', { message: 'TEST-ONLY injected Signalsmith Worker error after real DSP progress', cancelable: true }))
          } else click('cancel')
        })
        return worker
      },
    })
    const base = BaseAudioContext.prototype, createSource = base.createBufferSource, createBuffer = base.createBuffer, decode = base.decodeAudioData
    base.createBuffer = function (...args) { return trackBuffer(createBuffer.apply(this, args)) }
    base.decodeAudioData = function (...args) {
      const pending = decode.apply(this, args)
      pending.then(trackBuffer, () => {})
      return pending
    }
    base.createBufferSource = function (...args) {
      const node = createSource.apply(this, args), id = ++nextId, connect = node.connect, disconnect = node.disconnect, start = node.start
      const realtime = !(this instanceof OfflineAudioContext)
      node.connect = function (...args) { const returned = connect.apply(this, args); sources.add(id); return returned }
      node.disconnect = function (...args) { const returned = disconnect.apply(this, args); sources.delete(id); return returned }
      node.start = function (...args) { if (realtime) realtimeStarts++; return start.apply(this, args) }
      return node
    }
    const abort = AbortController.prototype.abort
    AbortController.prototype.abort = function (...args) {
      for (const entry of nativeRenders) if (entry.cancelRequested && renders.has(entry.id)) entry.abortObservedWhilePending = true
      return abort.apply(this, args)
    }
    const render = OfflineAudioContext.prototype.startRendering
    OfflineAudioContext.prototype.startRendering = function (...args) {
      const id = ++nextId, entry = { id, cancelRequested: false, cancelTriggeredWhilePending: false, abortObservedWhilePending: false, settled: false, rejected: false }
      nativeRenders.push(entry); renders.add(id)
      let pending
      try { pending = render.apply(this, args) } catch (error) { renders.delete(id); entry.settled = true; entry.rejected = true; throw error }
      pending.then(buffer => { trackBuffer(buffer); renders.delete(id); entry.settled = true }, () => { renders.delete(id); entry.settled = true; entry.rejected = true })
      if (cancelNextRender) {
        cancelNextRender = false; entry.cancelRequested = true
        queueMicrotask(() => { entry.cancelTriggeredWhilePending = renders.has(id); click('cancel') })
      }
      return pending
    }
    const createURL = URL.createObjectURL, revokeURL = URL.revokeObjectURL
    URL.createObjectURL = function (...args) { const url = createURL.apply(this, args); urls.add(url); return url }
    URL.revokeObjectURL = function (url) { const returned = revokeURL.call(this, url); urls.delete(url); return returned }
    window.__signalsmithLifecycle = {
      arm(kind) { if (!['cancel', 'injected-error'].includes(kind)) throw new Error('Unsupported lifecycle action'); interruption = kind },
      cancelDuringNextNativeRender() { cancelNextRender = true },
      snapshot() {
        buffers = buffers.filter(entry => entry.ref.deref())
        return { liveWorkers: workers.size, connectedSources: sources.size, pendingNativeRenders: renders.size, objectURLs: urls.size, realtimeStarts,
          observedLiveAudioBuffers: buffers.length, observedLivePcmBytes: buffers.reduce((sum, entry) => sum + entry.bytes, 0),
          attempts: attempts.map(entry => ({ ...entry })), nativeRenders: nativeRenders.map(entry => ({ ...entry })) }
      },
    }
  })
}
async function withEvidence(testInfo, name, records, run) {
  const path = testInfo.outputPath(name)
  let originalFailure
  const persist = () => writeFile(path, JSON.stringify({ ...records,
    ownershipTolerance: { liveWorkers: 0, connectedSources: 0, pendingNativeRenders: 0, objectURLs: 0 },
    heapAcceptanceThreshold: null,
    caveat: 'Scalar ownership evidence and WeakRef observations only. No strong audio references, no whole-browser/native-memory bound or leak-free claim.' }, null, 2))
  try { await run(persist); records.completed = true }
  catch (error) { originalFailure = error; records.failure = { name: error.name, message: error.message }; throw error }
  finally {
    try { await persist(); await testInfo.attach(name, { path, contentType: 'application/json' }) }
    catch (error) { if (!originalFailure) throw error; console.error('Lifecycle evidence write failed:', error.message) }
  }
}
function checkAttempt(entry) {
  expect(entry.posts).toBe(1); expect(entry.transferredBytes).toBeGreaterThan(0); expect(entry.detached).toBe(true)
  expect(entry.dspProgress).toBeGreaterThan(.08); expect(entry.dspProgress).toBeLessThan(1)
  expect(entry.terminateCalls).toBe(1)
}

test('real DSP progress cancellation, genuine retries and Clear release Signalsmith and native audition ownership', async ({ page }, testInfo) => {
  test.setTimeout(180000)
  const records = { completed: false, rounds: [], unexpectedNetwork: [], pageErrors: [] }
  await withEvidence(testInfo, 'signalsmith-lifecycle.json', records, async persist => {
    await installProbe(page, records); await page.goto('/')
    for (let round = 0; round < 6; round++) {
      await loadSource(page)
      const accepted = await savedProjectHash(page)
      await page.evaluate(() => window.__signalsmithLifecycle.arm('cancel'))
      await action(page, 'transpose-render').click()
      await expect.poll(async () => (await snapshot(page)).attempts.at(-1)?.interruption).toBe('cancel')
      await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
      await expect(review(page)).toBeHidden()
      records.latestObserved = await snapshot(page)
      const cancelled = records.latestObserved.attempts.at(-1)
      checkAttempt(cancelled)
      expect(await savedProjectHash(page)).toBe(accepted)
      // No fault injection or held request on this retry: genuine script/WASM,
      // native candidate construction and serialization all run unchanged.
      await action(page, 'transpose-render').click()
      await expect(review(page)).toBeVisible({ timeout: 60000 })
      await expect(action(page, 'replacement-confirm')).toBeEnabled()
      records.latestObserved = await snapshot(page)
      const succeeded = records.latestObserved.attempts.at(-1)
      checkAttempt(succeeded); expect(succeeded.results).toBe(1); expect(succeeded.interruption).toBeNull()
      expect(await savedProjectHash(page)).toBe(accepted)
      // Cancel through the real UI after startRendering, before its native
      // promise settles. Clear afterward; neither native operation is delayed
      // or replaced, and a confirmation dialog cannot race the Cancel boundary.
      await page.evaluate(() => window.__signalsmithLifecycle.cancelDuringNextNativeRender())
      await action(page, 'replacement-preview').click()
      await expect(review(page)).toBeHidden()
      await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
      records.latestObserved = await snapshot(page)
      const interruptedNative = records.latestObserved.nativeRenders.at(-1)
      expect(interruptedNative.cancelRequested).toBe(true)
      expect(interruptedNative.cancelTriggeredWhilePending).toBe(true)
      expect(interruptedNative.abortObservedWhilePending).toBe(true)
      expect(await savedProjectHash(page)).toBe(accepted)
      await action(page, 'clear').click(); await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
      await ownershipSettled(page)
      const observed = await snapshot(page), native = observed.nativeRenders.at(-1)
      expect(native.settled).toBe(true); expect(observed.realtimeStarts).toBe(0)
      expect(observed.attempts).toHaveLength((round + 1) * 2)
      records.rounds.push({ round, acceptedProjectSha256: accepted, cancelled, succeeded, observed })
      await persist()
    }
    expect(records.unexpectedNetwork).toEqual([]); expect(records.pageErrors).toEqual([])
  })
})

test('TEST-ONLY injected Worker error after real DSP progress cleans ownership and allows an untouched genuine retry', async ({ page }, testInfo) => {
  test.setTimeout(90000)
  const records = { completed: false, faultInjection: 'Synthetic ErrorEvent on the real Worker after progress >0.08; not a spontaneous crash or timeout', rounds: [], unexpectedNetwork: [], pageErrors: [] }
  await withEvidence(testInfo, 'signalsmith-injected-error-lifecycle.json', records, async persist => {
    await installProbe(page, records); await page.goto('/'); await loadSource(page)
    const accepted = await savedProjectHash(page)
    await page.evaluate(() => window.__signalsmithLifecycle.arm('injected-error'))
    await action(page, 'transpose-render').click()
    await expect(page.locator('#daw-status')).toContainText('TEST-ONLY injected Signalsmith Worker error')
    await expect(page.locator('#mode-editor')).toHaveAttribute('aria-busy', 'false')
    await expect(review(page)).toBeHidden()
    records.latestObserved = await snapshot(page)
    const failed = records.latestObserved.attempts.at(-1)
    checkAttempt(failed); expect(failed.injectedError).toBe(true)
    expect(await savedProjectHash(page)).toBe(accepted)
    await action(page, 'transpose-render').click()
    await expect(review(page)).toBeVisible({ timeout: 60000 })
    records.latestObserved = await snapshot(page)
    const succeeded = records.latestObserved.attempts.at(-1)
    checkAttempt(succeeded); expect(succeeded.results).toBe(1); expect(succeeded.injectedError).toBe(false)
    expect(await savedProjectHash(page)).toBe(accepted)
    await action(page, 'clear').click(); await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
    await ownershipSettled(page)
    records.rounds.push({ acceptedProjectSha256: accepted, failed, succeeded, observed: await snapshot(page) }); await persist()
    expect(records.unexpectedNetwork).toEqual([]); expect(records.pageErrors).toEqual([])
  })
})
