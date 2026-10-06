import { test as base, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'

// These are workflow tests with MOCK ASR, not model-backed singing/timing QA.
// The tone fixture contains no lyrics. Only Worker messages are substituted:
// audio decoding/resampling, window planning, client validation, the matcher,
// session/history, persistence and all export serializers are production code.
const AUDIO_FILE = 'tests/fixtures/test-tone-8s.wav'
const ORIGINAL = 'Hello\n\nWorld'
const command = (page, id) => page.locator(`[data-command="${id}"]`)

function isModelRequest(value) {
  const { hostname, pathname } = new URL(value)
  return /(^|\.)(huggingface\.co|hf\.co|hf\.space|huggingfaceusercontent\.com)$/.test(hostname)
    || pathname.includes('whisper-worker')
    || /\.(onnx|safetensors|bin|wasm)$/i.test(pathname)
    || /\/(?:ort[-.]|transformers[-.])/.test(pathname)
}

const test = base.extend({
  mockAsr: async ({ page, context }, use, testInfo) => {
    const blockedModelRequests = [], pageErrors = [], actualAsrWorkers = []
    testInfo.annotations.push({ type: 'ASR', description: 'MOCK worker responses only; no model download, inference or quality claim' })
    // A second independent fail-closed guard prevents downloads even if the
    // application changes worker construction. Count attempts, not just success.
    await context.route('**/*', route => {
      if (isModelRequest(route.request().url())) {
        blockedModelRequests.push(route.request().url())
        return route.abort('blockedbyclient')
      }
      return route.continue()
    })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('worker', worker => {
      if (worker.url().includes('whisper-worker')) actualAsrWorkers.push(worker.url())
    })
    await page.addInitScript(() => {
      const NativeWorker = window.Worker
      const deliveries = []
      const callbacks = []
      const state = window.__mockLyricsAsr = {
        workers: [], jobs: [], deliveries, nativeWorkers: [],
        complete(index, chunks) {
          if (!callbacks[index]) throw new Error(`No mock ASR job ${index}`)
          callbacks[index]('result', { result: { chunks } })
        },
        progress(index, progress) {
          if (!callbacks[index]) throw new Error(`No mock ASR job ${index}`)
          callbacks[index]('progress', { progress })
        },
      }
      class MockAsrWorker extends EventTarget {
        constructor(url) {
          super()
          this.onmessage = null
          this.onerror = null
          this.onmessageerror = null
          this.record = { index: state.workers.length, url, terminated: false }
          state.workers.push(this.record)
        }
        postMessage(message, transfer) {
          if (message.type !== 'transcribe') throw new Error('Unexpected mock ASR request')
          const samples = message.samples
          const index = state.jobs.length
          state.jobs.push({
            index, worker: this.record.index, id: message.id,
            sampleCount: samples.length, sampleRate: message.sampleRate,
            language: message.language, approved: message.modelSourceApproved,
            float32: samples instanceof Float32Array,
            finite: samples.every(Number.isFinite),
            nonSilent: samples.some(sample => Math.abs(sample) > .0001),
            transfersCopy: transfer?.length === 1 && transfer[0] === samples.buffer,
          })
          callbacks[index] = (type, payload) => {
            // Intentionally deliver after terminate(), including colliding job
            // IDs from an immediate retry. The real client's stale-instance
            // guard must reject these messages, rather than the mock hiding them.
            deliveries.push({ job: index, type, afterTerminate: this.record.terminated })
            const event = new MessageEvent('message', { data: { type, id: message.id, ...payload } })
            this.onmessage?.(event)
            this.dispatchEvent(event)
          }
        }
        terminate() { this.record.terminated = true }
      }
      window.Worker = new Proxy(NativeWorker, {
        construct(target, args) {
          const url = String(args[0])
          // Matches both /src/.../whisper-worker.js and Vite's hashed asset.
          if (url.includes('whisper-worker')) return new MockAsrWorker(url)
          state.nativeWorkers.push(url)
          return Reflect.construct(target, args)
        },
      })
    })
    const harness = {
      jobs: () => page.evaluate(() => window.__mockLyricsAsr.jobs),
      workers: () => page.evaluate(() => window.__mockLyricsAsr.workers),
      waitForJobs: count => expect.poll(() => harness.jobs()).toHaveLength(count),
      complete: (index, chunks) => page.evaluate(({ index, chunks }) => window.__mockLyricsAsr.complete(index, chunks), { index, chunks }),
      progress: (index, progress) => page.evaluate(({ index, progress }) => window.__mockLyricsAsr.progress(index, progress), { index, progress }),
    }
    await use(harness)
    await testInfo.attach('mock-asr-network-safety.json', {
      body: JSON.stringify({ mode: 'mock-asr-only', blockedModelRequests, actualAsrWorkers, pageErrors }, null, 2),
      contentType: 'application/json',
    })
    expect(blockedModelRequests, 'No Hugging Face/model/runtime/real ASR worker request is permitted').toEqual([])
    expect(actualAsrWorkers, 'The actual model worker must never be constructed').toEqual([])
    expect(pageErrors).toEqual([])
  },
})

async function openDisclosure(page, id) {
  const disclosure = page.locator(id)
  if (!(await disclosure.evaluate(element => element.open))) await disclosure.locator(':scope > summary').click()
}

async function setup(page) {
  await page.goto('/')
  await page.setInputFiles('#file-input', AUDIO_FILE)
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.click('[data-mode="lyrics"]')
  await expect(page.locator('#lyrics-source')).toContainText('來源已連結')
  await page.locator('#lyrics-raw').fill(ORIGINAL)
  await command(page, 'lyrics.apply').click()
  await expect(page.locator('#lyrics-list [data-line]')).toHaveCount(3)
  await expect(page.locator('[data-line="line-2"]')).toHaveAttribute('data-timing-status', 'silent')
}

async function approveMockAnalysis(page) {
  // This exercises the UI consent gate; the harness still forbids real models.
  await openDisclosure(page, '#lyrics-model-settings')
  await page.locator('#lyrics-language').selectOption('en')
  await page.locator('#lyrics-model-consent').check()
  await expect(command(page, 'lyrics.align')).toBeEnabled()
}

async function downloaded(page, id) {
  const pending = page.waitForEvent('download')
  await command(page, id).click()
  const download = await pending
  expect(await download.failure()).toBeNull()
  return fs.readFile(await download.path(), 'utf8')
}

const project = async page => JSON.parse(await downloaded(page, 'lyrics.save'))

function expectOriginal(session) {
  expect(session.rawText).toBe(ORIGINAL)
  expect(session.lines.map(line => [line.id, line.text, line.sung])).toEqual([
    ['line-1', 'Hello', true], ['line-2', '', false], ['line-3', 'World', true],
  ])
}

function expectPreparedJob(job, sampleCount) {
  expect(job).toMatchObject({ sampleCount, sampleRate: 16000, language: 'en', approved: true,
    float32: true, finite: true, nonSilent: true, transfersCopy: true })
}

test.describe('Automatic lyrics workflow with mock ASR only', () => {
  test('consent, missing line, atomic adoption, protected retry, four exports and recovery', async ({ page, mockAsr }, testInfo) => {
    test.setTimeout(60_000)
    await setup(page)
    const baseline = await project(page)
    expectOriginal(baseline)
    expect(baseline.source).toEqual({ name: 'test-tone-8s.wav', duration: 8,
      hash: createHash('sha256').update(await fs.readFile(AUDIO_FILE)).digest('hex') })
    await expect(page.locator('#lyrics-language')).toHaveValue('')
    await expect(page.locator('#lyrics-model-consent')).not.toBeChecked()
    await expect(command(page, 'lyrics.align')).toBeDisabled()
    await page.locator('#lyrics-model-consent').check()
    await expect(command(page, 'lyrics.align')).toBeDisabled()
    await expect(page.locator('#lyrics-alignment-availability')).toContainText('請先選擇')
    await openDisclosure(page, '#lyrics-model-settings')
    await page.locator('#lyrics-language').selectOption('en')
    await page.locator('#lyrics-model-consent').uncheck()
    await expect(command(page, 'lyrics.align')).toBeDisabled()
    // Playwright's enabled-state matcher follows the enclosing label to its
    // enabled <select>. Check this native option's own gate instead.
    await expect(page.locator('#lyrics-command-select option[value="lyrics.align"]')).toHaveJSProperty('disabled', true)
    expect(await mockAsr.workers()).toEqual([])
    expect(await mockAsr.jobs()).toEqual([])
    await page.locator('#lyrics-model-consent').check()
    await expect(page.locator('#lyrics-command-select option[value="lyrics.align"]')).toHaveJSProperty('disabled', false)
    await command(page, 'lyrics.align').click()
    await mockAsr.waitForJobs(1)
    expectPreparedJob((await mockAsr.jobs())[0], 128000)
    await mockAsr.complete(0, [{ text: 'Hello', timestamp: [1, 2] }])
    await expect(page.locator('#lyrics-proposal-summary')).toContainText('找到 1 句時間；1 句尚未找到')
    await expect(page.locator('[data-preview-line="line-1"]')).toContainText('1.000–2.000')
    await expect(page.locator('[data-preview-line="line-3"]')).toContainText('尚未在音訊找到')
    await expect(page.locator('#lyrics-start-value')).toHaveValue('')
    expect(await project(page), 'Preview must not modify saved timings or provenance').toEqual(baseline)
    await page.locator('.lyrics-alignment').screenshot({ path: testInfo.outputPath('mock-asr-analysis-desktop.png') })

    await command(page, 'lyrics.align.adopt').click()
    const adopted = await project(page)
    expectOriginal(adopted)
    expect(adopted.revision).toBe(baseline.revision + 1)
    expect(adopted.lines[0]).toMatchObject({ start: 1, end: 2, confirmed: false, manualLocked: false,
      timingOrigin: 'automatic', alignment: { status: 'matched', pass: 1, language: 'en' } })
    expect(adopted.lines[2]).toMatchObject({ start: null, end: null, confirmed: false,
      timingOrigin: null, alignment: { status: 'unresolved', pass: 1, evidence: { coverage: 0 } } })
    await expect(page.locator('[data-line="line-3"]')).toHaveAttribute('data-timing-status', 'unresolved')
    await command(page, 'lyrics.undo').click()
    expect(await project(page), 'One undo must remove both the time and unresolved marker').toEqual(baseline)
    await command(page, 'lyrics.redo').click()
    expect(await project(page)).toEqual(adopted)

    await page.locator('[data-line="line-1"]').click()
    await command(page, 'lyrics.confirm').click()
    await expect(page.locator('#lyrics-manual-lock')).toBeChecked()
    await expect(command(page, 'lyrics.align.selected')).toBeDisabled()
    const helloLocked = (await project(page)).lines[0]
    expect(helloLocked).toMatchObject({ start: 1, end: 2, confirmed: true, manualLocked: true })
    await page.locator('[data-line="line-3"]').click()
    await command(page, 'lyrics.align.selected').click()
    await mockAsr.waitForJobs(2)
    // Real service plan: [0, 5.2] then [3.2, 8], with two-second overlap.
    // Put World in the first window, before the midpoint ownership seam (4.2).
    expectPreparedJob((await mockAsr.jobs())[1], 83200)
    await mockAsr.complete(1, [{ text: 'World', timestamp: [3, 4] }])
    await mockAsr.waitForJobs(3)
    expectPreparedJob((await mockAsr.jobs())[2], 76800)
    await expect(page.locator('#lyrics-proposal')).toBeHidden()
    await mockAsr.complete(2, [])
    await expect(page.locator('#lyrics-proposal-summary')).toContainText('找到 1 句時間；0 句尚未找到')
    await expect(page.locator('#lyrics-proposal-list [data-preview-line]')).toHaveCount(1)
    await expect(page.locator('[data-preview-line="line-3"]')).toContainText('3.000–4.000')
    await command(page, 'lyrics.align.adopt').click()
    await expect(page.locator('#lyrics-start-value')).toHaveValue('3')
    await expect(page.locator('#lyrics-end-value')).toHaveValue('4')
    await expect(page.locator('#lyrics-diagnostics')).toContainText('line-3：尚未確認')
    await command(page, 'lyrics.confirm').click()
    const complete = await project(page)
    expectOriginal(complete)
    expect(complete.lines[0], 'Selected-line retry must leave the confirmed anchor byte-for-byte intact').toEqual(helloLocked)
    expect(complete.lines[2]).toMatchObject({ start: 3, end: 4, confirmed: true, manualLocked: true,
      timingOrigin: 'automatic', alignment: { status: 'matched', pass: 2, language: 'en', backend: 'wasm',
        engine: 'transformers.js-whisper@3.8.1', model: 'Xenova/whisper-tiny',
        modelRevision: '5332fcc35e32a33b86612b9a57a89be7906102b1' } })
    // This provenance records the configured application pipeline; ASR above
    // is mocked and this assertion does not establish real model execution.
    await expect(command(page, 'lyrics.align')).toBeDisabled()
    expect(await downloaded(page, 'lyrics.export.txt')).toBe(ORIGINAL)
    expect(await downloaded(page, 'lyrics.export.srt')).toBe('1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n')
    expect(await downloaded(page, 'lyrics.export.lrc')).toBe('[00:01.00]Hello\n[00:02.00]\n[00:03.00]World\n[00:04.00]\n')
    const ass = await downloaded(page, 'lyrics.export.ass')
    expect(ass).toContain('Dialogue: 0,00:00:01.00,00:00:02.00,Default,,0,0,0,,Hello\n')
    expect(ass).toContain('Dialogue: 0,00:00:03.00,00:00:04.00,Default,,0,0,0,,World\n')

    await command(page, 'lyrics.undo').click()
    const beforeReload = await project(page)
    expect(beforeReload.lines[2]).toMatchObject({ start: 3, end: 4, confirmed: false, manualLocked: false,
      alignment: { status: 'matched', pass: 2 } })
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('waveforge.lyrics.recovery.v1')))).toEqual(beforeReload)
    await page.reload()
    await page.click('[data-mode="lyrics"]')
    await command(page, 'lyrics.recover').click()
    await expect(page.locator('#lyrics-source')).toContainText('來源未連結')
    await expect(command(page, 'lyrics.export.srt')).toBeDisabled()
    await expect(page.locator('#lyrics-raw')).toHaveValue(ORIGINAL)
    expect(await project(page)).toEqual(beforeReload)
    await expect(page.locator('#lyrics-model-consent')).not.toBeChecked()
    await expect(page.locator('#lyrics-language')).toHaveValue('')
    expect(await mockAsr.workers()).toEqual([])
    await page.setInputFiles('#file-input', AUDIO_FILE)
    await expect(page.locator('#lyrics-source')).toContainText('來源已連結')
    await page.locator('[data-line="line-3"]').click()
    await expect(page.locator('#lyrics-start-value')).toHaveValue('3')
    await expect(page.locator('#lyrics-diagnostics')).toContainText('line-3：尚未確認')
    await command(page, 'lyrics.confirm').click()
    expect(await project(page)).toEqual(complete)
  })

  test('keyboard cancellation restores visible focus before another analysis', async ({ page, mockAsr }) => {
    await setup(page)
    await approveMockAnalysis(page)
    await command(page, 'lyrics.align').click()
    await mockAsr.waitForJobs(1)
    await command(page, 'lyrics.align.cancel').focus()
    await page.keyboard.press('Enter')
    await expect(command(page, 'lyrics.align.cancel')).toBeHidden()
    await expect(page.locator('#lyrics-model-settings > summary')).toBeFocused()
    await expect(command(page, 'lyrics.align')).toBeEnabled()
    expect(await mockAsr.workers()).toMatchObject([{ terminated: true }])
  })

  test('cancelled native resampling blocks allocation until settlement, then permits retry', async ({ page, mockAsr }) => {
    await setup(page)
    await approveMockAnalysis(page)
    const baseline = await project(page)
    // Real Web Audio renders the synthetic fixture. Hold only delivery of its
    // promise to deterministically cover Cancel while native work is pending.
    // This is lifecycle coverage, not a heap measurement or real-ASR test.
    await page.evaluate(() => {
      const NativeContext = window.OfflineAudioContext, releases = []
      const state = window.__lyricsNativeLifecycle = { contexts: 0, inputFrames: 0, sources: 0, disconnects: 0, pending: 0, held: true,
        release() { state.held = false; releases.splice(0).forEach(resolve => resolve()) } }
      window.OfflineAudioContext = class extends NativeContext {
        constructor(...args) { super(...args); state.contexts++ }
        createBuffer(channels, length, rate) { state.inputFrames += length; return super.createBuffer(channels, length, rate) }
        createBufferSource() {
          const node = super.createBufferSource(), disconnect = node.disconnect.bind(node)
          state.sources++
          node.disconnect = (...args) => { state.disconnects++; return disconnect(...args) }
          return node
        }
        startRendering() {
          const rendered = super.startRendering()
          if (!state.held) return rendered
          state.pending++
          const delivery = new Promise(resolve => releases.push(resolve))
          // Consume the native rejection immediately as well as delaying its
          // delivery, so a browser failure cannot become an unhandled rejection.
          return rendered.then(buffer => delivery.then(() => buffer), error => delivery.then(() => { throw error }))
            .finally(() => { state.pending-- })
        }
      }
    })
    const state = () => page.evaluate(() => {
      const { contexts, inputFrames, sources, disconnects } = window.__lyricsNativeLifecycle
      return { contexts, inputFrames, sources, disconnects }
    })
    await command(page, 'lyrics.align').click()
    await expect.poll(state).toMatchObject({ contexts: 1, sources: 1, disconnects: 0 })
    const pending = await state()
    await command(page, 'lyrics.align.cancel').click()
    await expect.poll(state).toMatchObject({ contexts: 1, disconnects: 1 })
    for (let attempt = 0; attempt < 3; attempt++) {
      await command(page, 'lyrics.align').click()
      await expect(page.locator('#lyrics-alignment-message')).toContainText('上一段音訊仍在完成取樣轉換')
      await expect(command(page, 'lyrics.align.cancel')).toBeHidden()
      expect(await state()).toEqual({ ...pending, disconnects: 1 })
    }
    expect(await mockAsr.jobs()).toEqual([])
    expect(await mockAsr.workers()).toEqual([])
    expect(await project(page)).toEqual(baseline)
    await page.evaluate(() => window.__lyricsNativeLifecycle.release())
    // Let the real native completion (if still running) and its delivery settle
    // before asking the app to create the next context.
    await expect.poll(() => page.evaluate(() => window.__lyricsNativeLifecycle.pending)).toBe(0)
    await command(page, 'lyrics.align').click()
    await mockAsr.waitForJobs(1)
    expect(await state()).toMatchObject({ contexts: 2, sources: 2, disconnects: 2 })
    await mockAsr.complete(0, [{ text: 'Hello', timestamp: [1, 2] }])
    await expect(page.locator('#lyrics-proposal-summary')).toContainText('找到 1 句時間')
    expect(await project(page)).toEqual(baseline)
  })

  test('cancel permits a same-turn retry and ignores late progress/results from terminated mock ASR', async ({ page, mockAsr }) => {
    await setup(page)
    await approveMockAnalysis(page)
    const baseline = await project(page)
    await command(page, 'lyrics.align').click()
    await mockAsr.waitForJobs(1)
    await mockAsr.progress(0, { phase: 'loading', message: 'MOCK ASR progress only', aggregateLoaded: 1048576, aggregateTotal: 2097152 })
    await expect(page.locator('#lyrics-model-progress')).toBeVisible()
    await expect(page.locator('#lyrics-model-progress')).toHaveAttribute('max', '2097152')
    await expect(page.locator('#lyrics-model-progress')).toHaveJSProperty('value', 1048576)
    await expect(page.locator('#lyrics-alignment-progress')).toHaveAttribute('aria-busy', 'true')
    // Dispatch actual UI commands in one browser turn so promise cleanup from
    // the canceled task cannot mask an immediate-retry race.
    const retryWasEnabled = await page.evaluate(() => {
      document.querySelector('[data-command="lyrics.align.cancel"]').click()
      const retry = document.querySelector('[data-command="lyrics.align"]')
      const enabled = !retry.disabled
      retry.click()
      return enabled
    })
    expect(retryWasEnabled).toBe(true)
    await mockAsr.waitForJobs(2)
    const jobs = await mockAsr.jobs()
    expectPreparedJob(jobs[0], 128000)
    expectPreparedJob(jobs[1], 128000)
    expect(jobs[0].id, 'New client deliberately reuses the numeric request ID').toBe(jobs[1].id)
    expect(jobs[0].worker).not.toBe(jobs[1].worker)
    expect(await mockAsr.workers()).toMatchObject([{ terminated: true }, { terminated: false }])
    const liveMessage = await page.locator('#lyrics-alignment-message').textContent()
    await mockAsr.progress(0, { phase: 'loading', message: 'STALE MOCK PROGRESS', aggregateLoaded: 1, aggregateTotal: 1 })
    await mockAsr.complete(0, [{ text: 'Hello', timestamp: [6, 7] }, { text: 'World', timestamp: [7, 8] }])
    await expect(page.locator('#lyrics-alignment-message')).toHaveText(liveMessage)
    await expect(page.locator('#lyrics-alignment-progress')).toHaveAttribute('aria-busy', 'true')
    await expect(command(page, 'lyrics.align.cancel')).toBeEnabled()
    await expect(page.locator('#lyrics-proposal')).toBeHidden()
    await expect(page.locator('#lyrics-model-progress')).toBeHidden()
    expect(await project(page)).toEqual(baseline)
    await mockAsr.complete(1, [{ text: 'Hello', timestamp: [1, 2] }])
    await expect(page.locator('#lyrics-proposal-summary')).toContainText('找到 1 句時間；1 句尚未找到')
    await mockAsr.complete(0, [{ text: 'Hello', timestamp: [6, 7] }, { text: 'World', timestamp: [7, 8] }])
    await expect(page.locator('[data-preview-line="line-1"]')).toContainText('1.000–2.000')
    await command(page, 'lyrics.align.adopt').click()
    const adopted = await project(page)
    expectOriginal(adopted)
    expect(adopted.revision).toBe(baseline.revision + 1)
    expect(adopted.lines[0]).toMatchObject({ start: 1, end: 2, confirmed: false })
    expect(adopted.lines[2]).toMatchObject({ start: null, end: null, alignment: { status: 'unresolved' } })
    expect(await page.evaluate(() => window.__mockLyricsAsr.deliveries.filter(event => event.afterTerminate))).toEqual([
      { job: 0, type: 'progress', afterTerminate: true },
      { job: 0, type: 'result', afterTerminate: true },
      { job: 0, type: 'result', afterTerminate: true },
    ])
  })

  test('390px analysis card remains usable with mock-ASR missing-line results', async ({ page, mockAsr }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setup(page)
    await approveMockAnalysis(page)
    await command(page, 'lyrics.align').click()
    await mockAsr.waitForJobs(1)
    await mockAsr.complete(0, [{ text: 'Hello', timestamp: [1, 2] }])
    await expect(page.locator('#lyrics-proposal-summary')).toContainText('找到 1 句時間；1 句尚未找到')
    await expect(page.locator('#lyrics-language-help')).toContainText('歌唱時間邊界與多語準確度尚未校準')
    await expect(page.locator('#lyrics-raw')).toHaveValue(ORIGINAL)
    const card = page.locator('.lyrics-alignment')
    await card.scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await card.screenshot({ path: testInfo.outputPath('mock-asr-analysis-mobile-390.png') })
    await command(page, 'lyrics.align.discard').click()
    await expect(page.locator('#lyrics-proposal')).toBeHidden()
    await expect(command(page, 'lyrics.align')).toBeEnabled()
    const untouched = await project(page)
    expectOriginal(untouched)
    expect(untouched.lines.every(line => line.start === null && line.end === null && line.alignment === null)).toBe(true)
  })
})
