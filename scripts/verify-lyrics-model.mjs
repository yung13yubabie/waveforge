#!/usr/bin/env node
/**
 * Explicit opt-in evidence runner. Never part of npm test, build, or deployment.
 * Only downloads the seven approved manifest URLs; all bytes are reverified
 * before any model runtime import. Weights must remain outside this repository.
 * Node CPU and browser Worker/WASM modes produce separate evidence artifacts.
 * Neither mode is a manually annotated lyric-alignment accuracy benchmark.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  WHISPER_FILES, WHISPER_REVISION, WHISPER_MODEL_ID, WHISPER_VERSION,
  WHISPER_INFO, WHISPER_CACHE_NAME, validateWhisperInput, validateWhisperChunks,
} from '../src/js/lyrics/whisper-config.js'
import { assertCrossAttentionOutputs, installWhisperFrameCorrection } from '../src/js/lyrics/whisper-timestamps.js'
import { matchLyricsToAsr } from '../src/js/lyrics/alignment-matcher.js'
import { planAlignmentWindows, prepareAlignmentWindow, joinWindowWords } from '../src/js/lyrics/alignment-service.js'
import { createWhisperClient } from '../src/js/lyrics/whisper-client.js'

const run = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (!args.length || args.includes('--help')) {
  console.log('Opt-in fixed-model evidence: --approved-revision <exact revision> [--download] [--probe|--infer|--browser] [--live-download] [--server-mode dev|built] [--test-url http://127.0.0.1:5173/] [--cache-dir <outside repo>] [--output <JSON>]')
  console.log('No action is performed by default. Requires prior approval. --infer is Node CPU evidence, never browser/WASM or alignment accuracy validation.')
  process.exit(0)
}
const option = name => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const approved = option('--approved-revision')
const download = args.includes('--download')
const infer = args.includes('--infer')
const browserSmoke = args.includes('--browser')
const liveDownload = args.includes('--live-download')
const probe = args.includes('--probe') || infer
const cacheRoot = resolve(option('--cache-dir') || resolve(repo, '../waveforge-model-cache'))
const output = resolve(option('--output') || resolve(repo, `docs/validation/real-model/${browserSmoke ? 'browser-smoke' : 'node-cpu'}-evidence.json`))
const modelDir = resolve(cacheRoot, WHISPER_REVISION, WHISPER_MODEL_ID)
const REFERENCE_LINES = Object.freeze(['Twinkle, twinkle, little star', 'How I wonder what you are',
  'Up above the world so high', 'Like a diamond in the sky', 'When the blazing sun is gone'])
const started = new Date().toISOString()
const report = {
  schemaVersion: 1, startedAt: started, completedAt: null, status: 'starting',
  model: WHISPER_MODEL_ID, revision: WHISPER_REVISION, transformersVersion: WHISPER_VERSION,
  nodeVersion: process.version, platform: process.platform, architecture: process.arch,
  dtype: WHISPER_INFO.dtype,
  backend: browserSmoke ? 'browser-worker-wasm' : 'node-cpu', browserWasmValidated: false, singingAccuracyValidated: false,
  fixtureHasManualGold: false, files: [], graph: null, runs: [], limitations: [
    'Node CPU execution does not verify browser Worker, WASM, browser caching, or browser network behavior.',
    'The CC0 fixture has no manually verified transcript or timestamp gold; no recognition/boundary accuracy metric is claimed.',
    'One English singing excerpt does not validate Mandarin, multilingual, mixed-language, or full-song quality.',
  ],
}
async function checkpoint(status) {
  report.status = status
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }
async function verifyFile(file, path) {
  const size = (await stat(path)).size
  if (size !== file.bytes) throw new Error(`Model size mismatch: ${file.path}: expected ${file.bytes}, got ${size}`)
  const sha256 = hash(await readFile(path))
  if (sha256 !== file.sha256) throw new Error(`Model SHA-256 mismatch: ${file.path}`)
  return { path: file.path, url: file.url, bytes: size, sha256, verified: true }
}
function readPcm16Wav(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Expected WAV fixture')
  let format, data
  for (let i = 12; i + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', i, i + 4), size = bytes.readUInt32LE(i + 4), start = i + 8
    if (start + size > bytes.length) throw new Error('Truncated WAV fixture')
    if (type === 'fmt ') format = bytes.subarray(start, start + size)
    if (type === 'data') data = bytes.subarray(start, start + size)
    i = start + size + size % 2
  }
  if (!format || !data || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1 || format.readUInt32LE(4) !== 16000 || format.readUInt16LE(14) !== 16 || data.length % 2) {
    throw new Error('Fixture must be mono PCM signed-16-bit 16000 Hz WAV')
  }
  return Float32Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2) / 32768)
}
async function authorizedFixture() {
  const fixtureDir = resolve(repo, 'tests/fixtures/lyrics-alignment/cc0-twinkle')
  const manifest = JSON.parse(await readFile(resolve(fixtureDir, 'provenance.json'), 'utf8'))
  if (manifest.rightsConfirmed !== true) throw new Error('Fixture rights are not confirmed')
  const wav = await readFile(resolve(fixtureDir, manifest.audioFile))
  if (hash(wav) !== manifest.sha256 || wav.length !== manifest.sizeBytes) throw new Error('Fixture hash/size mismatch')
  const samples = readPcm16Wav(wav)
  const duration = validateWhisperInput({ samples, sampleRate: 16000, language: manifest.language })
  report.fixture = { fixtureId: manifest.fixtureId, sha256: manifest.sha256, durationSeconds: duration,
    language: manifest.language, rightsConfirmed: true, transcriptVerified: manifest.transcriptVerified,
    source: manifest.source.descriptionUrl, license: manifest.source.licenseId }
  return { manifest, samples, duration }
}
function matchReferenceLyrics(chunks, duration) {
  const lines = REFERENCE_LINES
    .map((text, index) => ({ id: `reference-${index + 1}`, text, sung: true }))
  const sourceText = lines.map(line => line.text).join('\n')
  const result = matchLyricsToAsr(lines, chunks, { duration })
  return {
    referenceSource: 'https://en.wikisource.org/wiki/Rhymes_for_the_Nursery/The_Star',
    scope: 'Public-domain reference lines matched to actual ASR output, NOT manually verified performance transcript or timing gold',
    sourceText, sourceTextUnchanged: lines.map(line => line.text).join('\n') === sourceText,
    matchedCount: result.candidates.filter(row => row.status === 'matched').length,
    unresolvedCount: result.candidates.filter(row => row.status === 'unresolved').length,
    result,
  }
}
async function runAppUiSmoke(page, expect) {
  const rawText = REFERENCE_LINES.join('\n')
  const ui = report.uiIntegration = {
    status: 'running', currentStep: 'load-authorized-audio', startedAt: new Date().toISOString(),
    path: 'real built/dev application UI → alignment service → real Worker/WASM → matcher → session',
    mockAsrUsed: false, manualAccuracyValidated: false,
    confirmationScope: 'The first-line confirmation button is exercised only to test lock preservation; no human listening or correct-boundary assertion is implied',
    referenceText: rawText, projects: {}, downloads: [], exportGates: {},
  }
  const manifestGets = () => report.network.requests.filter(request => request.manifestPath).length
  const whisperWorkers = () => report.workers.filter(worker => worker.url.includes('whisper-worker')).length
  const beforeGets = manifestGets(), beforeWorkers = whisperWorkers()
  const command = id => page.locator(`[data-command="${id}"]`)
  const onDownload = download => ui.downloads.push({ filename: download.suggestedFilename(), at: new Date().toISOString() })
  page.on('download', onDownload)
  const assertOriginal = project => {
    expect(project.rawText, 'The reference lyrics must never be rewritten by ASR or adoption').toBe(rawText)
    expect(project.lines.map(line => line.text)).toEqual([...REFERENCE_LINES])
    expect(project.lines.map(line => line.id)).toEqual(REFERENCE_LINES.map((_, index) => `line-${index + 1}`))
    expect(project.lines.every(line => line.sung === true)).toBe(true)
    expect(project.source.hash).toBe(report.fixture.sha256)
  }
  async function downloadText(id) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }), command(id).click(),
    ])
    expect(await download.failure()).toBeNull()
    const path = await download.path()
    if (!path) throw new Error(`Download did not yield a local artifact: ${id}`)
    return readFile(path, 'utf8')
  }
  async function saveProject(stage) {
    const project = JSON.parse(await downloadText('lyrics.save'))
    assertOriginal(project)
    ui.projects[stage] = project
    return project
  }
  async function awaitProposal() {
    await page.waitForFunction(() => {
      const progress = document.getElementById('lyrics-alignment-progress')
      const proposal = document.getElementById('lyrics-proposal')
      const message = document.getElementById('lyrics-alignment-message')?.textContent || ''
      return !proposal?.hidden || (progress?.getAttribute('aria-busy') === 'false' && /分析失敗|分析未能|已取消/.test(message))
    }, null, { timeout: 540000 })
    ui.latestAlignmentMessage = await page.locator('#lyrics-alignment-message').textContent()
    await expect(page.locator('#lyrics-proposal'), ui.latestAlignmentMessage).toBeVisible()
  }
  try {
    await checkpoint('browser-ui-load-authorized-audio')
    await page.setInputFiles('#file-input', resolve(repo, 'tests/fixtures/lyrics-alignment/cc0-twinkle/first-20s-mono-16k.wav'))
    await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 120000 })
    await page.locator('[data-mode="lyrics"]').click()
    await expect(page.locator('#lyrics-source')).toContainText('來源已連結', { timeout: 120000 })
    await page.locator('#lyrics-raw').fill(rawText)
    await command('lyrics.apply').click()
    await expect(page.locator('#lyrics-list [data-line]')).toHaveCount(REFERENCE_LINES.length)
    const baseline = await saveProject('beforeAnalysis')
    expect(baseline.lines.every(line => line.start === null && line.end === null && line.confirmed === false)).toBe(true)
    await expect(command('lyrics.align')).toBeDisabled()
    await page.locator('#lyrics-language').selectOption('en')
    await expect(command('lyrics.align')).toBeDisabled()
    await page.locator('#lyrics-model-consent').check()
    await expect(command('lyrics.align')).toBeEnabled()

    ui.currentStep = 'real-ui-asr-and-candidates'
    await checkpoint('browser-ui-real-asr-and-candidates')
    await command('lyrics.align').click()
    await awaitProposal()
    ui.firstProposalSummary = await page.locator('#lyrics-proposal-summary').textContent()
    ui.firstProposalRows = await page.locator('#lyrics-proposal-list [data-preview-line]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.previewLine, text: row.textContent })))
    const counts = ui.firstProposalSummary.match(/找到 (\d+) 句時間；(\d+) 句尚未找到/)
    expect(counts, 'Real UI should report matched and unresolved candidates').not.toBeNull()
    ui.firstMatchedCount = Number(counts[1]); ui.firstMissingCount = Number(counts[2])
    expect(ui.firstMatchedCount).toBeGreaterThan(0)
    expect(ui.firstMissingCount).toBeGreaterThan(0)
    await expect(page.locator('#lyrics-raw')).toHaveValue(rawText)
    const pendingProject = await saveProject('proposalNotYetAdopted')
    expect(pendingProject, 'A real ASR proposal must not mutate the current project before adoption').toEqual(baseline)
    const missingRow = ui.firstProposalRows.find(row => row.text.includes('尚未在音訊找到'))
    expect(missingRow).toBeTruthy()
    await page.locator(`#lyrics-proposal-list [data-preview-line="${missingRow.id}"]`).click()
    ui.missingCandidateDiagnostic = await page.locator('#lyrics-candidate-reasons').textContent()
    expect(ui.missingCandidateDiagnostic).toContain('文字吻合')
    expect(ui.missingCandidateDiagnostic).toMatch(/未找到|需確認|衝突/)

    ui.currentStep = 'adopt-once-and-confirm-lock-first-line'
    await command('lyrics.align.adopt').click()
    await expect(page.locator('#lyrics-proposal')).toBeHidden()
    const adopted = await saveProject('afterSingleBatchAdoption')
    expect(adopted.revision).toBe(baseline.revision + 1)
    expect(adopted.lines.some(line => line.alignment?.status === 'matched')).toBe(true)
    const missingLines = adopted.lines.filter(line => line.alignment?.status === 'unresolved')
    expect(missingLines.length).toBeGreaterThan(0)
    expect(missingLines.every(line => line.start === null && line.end === null && !line.confirmed)).toBe(true)
    await page.locator('#lyrics-list [data-line="line-1"]').click()
    await expect(command('lyrics.confirm')).toBeEnabled()
    await command('lyrics.confirm').click()
    await expect(page.locator('#lyrics-manual-lock')).toBeChecked()
    await expect(page.locator('#lyrics-list [data-line="line-1"]')).toHaveAttribute('data-timing-status', 'confirmed')
    const lockedProject = await saveProject('afterFirstLineConfirmedAndLocked')
    const locked = lockedProject.lines[0]
    expect(locked.confirmed).toBe(true); expect(locked.manualLocked).toBe(true)
    expect([locked.start, locked.end]).toEqual([adopted.lines[0].start, adopted.lines[0].end])

    ui.currentStep = 'retry-one-unlocked-line-with-lock-preserved'
    await checkpoint('browser-ui-targeted-retry')
    const target = lockedProject.lines.find(line => line.id === 'line-3' && !line.manualLocked && !line.confirmed)
    expect(target).toBeTruthy()
    ui.retryTargetId = target.id
    await page.locator(`#lyrics-list [data-line="${target.id}"]`).click()
    await expect(page.locator('#lyrics-manual-lock')).not.toBeChecked()
    await expect(command('lyrics.align.selected')).toBeEnabled()
    await command('lyrics.align.selected').click()
    await awaitProposal()
    const retryRows = page.locator('#lyrics-proposal-list [data-preview-line]')
    await expect(retryRows).toHaveCount(1)
    await expect(retryRows).toHaveAttribute('data-preview-line', target.id)
    ui.retryProposalSummary = await page.locator('#lyrics-proposal-summary').textContent()
    ui.retryCandidateDiagnostic = await page.locator('#lyrics-candidate-reasons').textContent()
    const afterRetry = await saveProject('afterTargetedRetryBeforeAdoption')
    expect(afterRetry.lines[0], 'Confirmed/locked first line must survive real targeted inference byte-for-byte').toEqual(locked)
    expect(afterRetry, 'Targeted proposal must not silently replace any existing times').toEqual(lockedProject)
    ui.lockedLinePreserved = true
    await command('lyrics.align.discard').click()
    await expect(page.locator('#lyrics-proposal')).toBeHidden()

    ui.currentStep = 'draft-json-txt-and-timed-export-gates'
    const timedBefore = ui.downloads.length
    for (const format of ['lrc', 'srt', 'ass']) {
      await command(`lyrics.export.${format}`).click()
      await expect(page.locator('#lyrics-status')).toContainText(/尚未|缺少|未確認|待確認|待打點|重疊/)
      ui.exportGates[format] = { blocked: true, message: await page.locator('#lyrics-status').textContent() }
    }
    expect(ui.downloads.length, 'Unconfirmed/missing sung lines must not produce timed subtitle downloads').toBe(timedBefore)
    const txt = await downloadText('lyrics.export.txt')
    expect(txt).toBe(rawText)
    ui.exportGates.txt = { allowedAsDraft: true, originalTextPreserved: txt === rawText }
    ui.exportGates.json = { allowedAsDraft: true, sourceHashPreserved: true, unconfirmedLinesRetained: true }
    expect(ui.downloads.every(item => /\.(json|txt)$/.test(item.filename))).toBe(true)
    await expect(page.locator('#lyrics-raw')).toHaveValue(rawText)
    ui.modelFileGets = manifestGets() - beforeGets
    ui.whisperWorkersCreated = whisperWorkers() - beforeWorkers
    expect(ui.modelFileGets, 'The real UI must reuse the verified cache from the preceding smoke').toBe(0)
    expect(ui.whisperWorkersCreated, 'The UI must create a genuine Whisper worker').toBeGreaterThan(0)
    ui.currentStep = 'complete'; ui.status = 'passed'; ui.completedAt = new Date().toISOString()
    await checkpoint('browser-ui-smoke-passed-not-accuracy-validation')
  } catch (error) {
    ui.status = 'failed'; ui.error = { name: error.name, message: error.message }
    ui.modelFileGets = manifestGets() - beforeGets
    ui.whisperWorkersCreated = whisperWorkers() - beforeWorkers
    ui.latestStatus = await page.locator('#lyrics-status').textContent().catch(() => null)
    ui.latestAlignmentMessage = await page.locator('#lyrics-alignment-message').textContent().catch(() => null)
    throw error
  } finally { page.off('download', onDownload) }
}
async function runBrowserSmoke() {
  const origin = new URL(option('--test-url') || 'http://127.0.0.1:5173/')
  if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) {
    throw new Error('Browser smoke only targets an already-running localhost server')
  }
  const serverMode = option('--server-mode') || 'dev'
  if (!['dev', 'built'].includes(serverMode)) throw new Error('--server-mode must be dev or built')
  const { manifest, samples, duration } = await authorizedFixture()
  report.serverMode = serverMode === 'built' ? 'built-application-local-static-server' : 'vite-development-server'
  report.testOrigin = origin.origin
  report.modelTransport = liveDownload
    ? 'Live browser GETs to the seven fixed source URLs and their HTTPS redirect chains; the product Worker verifies all lengths and SHA-256 hashes before execution'
    : 'Fixed model GETs fulfilled from externally cached, independently SHA-verified manifest files; no live browser CDN/CORS claim'
  report.liveBrowserModelDownloadValidated = false
  report.limitations[0] = `This smoke validates ${serverMode === 'built' ? 'the built assets on a local static server' : 'the local Vite development route'}; deployed-host response headers remain a separate acceptance gate${liveDownload ? '.' : ', as do live browser CDN/CORS.'}`
  report.network = { allowlist: [origin.origin, ...WHISPER_FILES.map(file => file.url)],
    redirectRule: liveDownload ? 'HTTPS GET descendants of an exact manifest request only' : 'No remote redirects; approved model GETs use verified fixture bytes',
    requests: [], forbiddenRequests: [], blockedDevelopmentWebSockets: [] }
  report.workers = []
  report.pageErrors = []
  const { chromium, expect } = await import('@playwright/test')
  // Official Playwright default; no custom executable, sandbox flags, ignored
  // certificate errors, or other fallback launch paths are used here.
  const browser = await chromium.launch({ headless: true })
  report.browserVersion = browser.version()
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    // HMR is unnecessary for a smoke run. Do not open a data-bearing socket to
    // any server; this restriction is additional to the GET-only HTTP fence.
    await context.routeWebSocket('**/*', async socket => {
      const url = new URL(socket.url())
      const local = url.hostname === origin.hostname && url.port === origin.port && url.protocol === 'ws:'
      // Vite may put an ephemeral HMR token in its query; never retain it.
      const entry = { url: `${url.origin}${url.pathname}`, queryOmitted: Boolean(url.search), blocked: true }
      if (local) report.network.blockedDevelopmentWebSockets.push(entry)
      else report.network.forbiddenRequests.push({ ...entry, method: 'WEBSOCKET' })
      await socket.close({ code: 1000, reason: 'No WebSockets in local model smoke' })
    })
    const knownFiles = new Map(WHISPER_FILES.map(file => [file.url, file]))
    const sourceFile = request => {
      let root = request
      while (root.redirectedFrom()) root = root.redirectedFrom()
      return knownFiles.get(root.url())
    }
    const requestAllowed = request => {
      const url = new URL(request.url()), file = sourceFile(request)
      return request.method() === 'GET' && request.postData() == null &&
        (url.origin === origin.origin || (file && url.protocol === 'https:' && (liveDownload || knownFiles.has(url.href))))
    }
    context.on('request', request => {
      const url = new URL(request.url()), file = sourceFile(request)
      // Signed redirect and Vite HMR tokens must not enter retained artifacts.
      const entry = { url: `${url.origin}${url.pathname}`, queryOmitted: Boolean(url.search), method: request.method(),
        hasBody: request.postData() != null, manifestPath: file?.path,
        delivery: file ? (liveDownload ? 'live-approved-model-get' : 'verified-manifest-file') : 'localhost-server' }
      report.network.requests.push(entry)
      if (!requestAllowed(request)) report.network.forbiddenRequests.push(entry)
    })
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      const file = knownFiles.get(url.href)
      if (!requestAllowed(request)) return route.abort('blockedbyclient')
      if (file && !liveDownload) return route.fulfill({ path: resolve(modelDir, file.path), contentType: 'application/octet-stream',
        headers: { 'Access-Control-Allow-Origin': origin.origin, 'Cache-Control': 'no-store' } })
      return route.continue()
    })
    const page = await context.newPage()
    page.on('worker', worker => { report.workers.push({ url: worker.url(), createdAt: new Date().toISOString() }) })
    page.on('pageerror', error => { report.pageErrors.push(error.message) })
    await page.goto(origin.href, { waitUntil: 'networkidle', timeout: 30000 })
    report.clientModuleUrl = await page.evaluate(async serverMode => {
      if (serverMode === 'dev') return new URL('/src/js/lyrics/whisper-client.js', location.href).href
      // Discover the real entry from served production HTML, then its emitted
      // dynamic client chunk. No test hook is added to production application.
      const entries = [...document.querySelectorAll('script[type="module"][src]')].map(script => script.src)
      for (const entry of entries) {
        if (new URL(entry).origin !== location.origin || new URL(entry).pathname.startsWith('/src/')) continue
        const response = await fetch(entry)
        if (!response.ok) throw new Error('Unable to read served built entry module')
        const source = await response.text()
        const match = source.match(/["'`]([^"'`]*whisper-client-[^"'`]+\.js)["'`]/)
        if (match) {
          const module = new URL(match[1], entry)
          if (module.origin !== location.origin) throw new Error('Built client module must be same-origin')
          return module.href
        }
      }
      throw new Error('No emitted Whisper client chunk found through the served built HTML entry')
    }, serverMode)
    await page.evaluate(async ({ samples, language, clientModuleUrl }) => {
      const module = await import(clientModuleUrl)
      globalThis.waveforgeSmoke = { createClient: module.createWhisperClient, samples: Float32Array.from(samples), language, client: null }
    }, { samples: [...samples], language: manifest.language, clientModuleUrl: report.clientModuleUrl })
    async function browserRun(id, action) {
      const entry = { id, startedAt: new Date().toISOString() }
      report.runs.push(entry)
      const modelGetCount = () => report.network.requests.filter(request => request.manifestPath).length
      const beforeGets = modelGetCount(), beforeWorkers = report.workers.length
      await checkpoint(`running-${id}`)
      const start = performance.now()
      try {
        Object.assign(entry, await page.evaluate(async action => {
          const state = globalThis.waveforgeSmoke
          const phases = new Set(), cacheReadFiles = new Set(), downloadedFiles = new Set()
          let events = 0, controller, cancelledAtTranscribing = false
          const onProgress = progress => {
            events++; phases.add(progress.phase)
            if (progress.phase === 'reading-cache') cacheReadFiles.add(progress.file)
            if (progress.phase === 'downloading') downloadedFiles.add(progress.file)
            if (controller && progress.phase === 'transcribing') { cancelledAtTranscribing = true; controller.abort() }
          }
          if (action === 'fresh' || action === 'cached') {
            state.client?.dispose()
            state.client = state.createClient({ modelSourceApproved: true, timeoutMs: 540000 })
          }
          if (!state.client) state.client = state.createClient({ modelSourceApproved: true, timeoutMs: 540000 })
          if (action === 'cancel') controller = new AbortController()
          try {
            const result = await state.client.transcribe({
              samples: action === 'silence' ? new Float32Array(32000) : state.samples,
              sampleRate: 16000, language: state.language, onProgress, signal: controller?.signal,
            })
            return { status: 'completed', result, phases: [...phases], cacheReadFiles: [...cacheReadFiles],
              downloadedFiles: [...downloadedFiles], progressEvents: events, cancelledAtTranscribing }
          } catch (error) {
            return { status: 'failed', error: { name: error.name, message: error.message }, phases: [...phases],
              cacheReadFiles: [...cacheReadFiles], downloadedFiles: [...downloadedFiles], progressEvents: events, cancelledAtTranscribing }
          }
        }, action))
      } finally {
        entry.elapsedMilliseconds = Math.round(performance.now() - start)
        entry.modelFileGets = modelGetCount() - beforeGets
        entry.workersCreated = report.workers.length - beforeWorkers
        if (entry.result) {
          entry.text = entry.result.chunks.map(word => word.text).join('')
          entry.audioSeconds = action === 'silence' ? 2 : duration
          entry.validatedChunks = validateWhisperChunks(entry.result.chunks, entry.audioSeconds)
          entry.timestampContractPassed = true
        }
        console.log(JSON.stringify(entry))
        await checkpoint(`finished-${id}`)
      }
      return entry
    }
    const silence = await browserRun('exact-silence-preflight', 'silence')
    if (silence.status !== 'completed' || silence.result.chunks.length || silence.workersCreated || silence.modelFileGets) throw new Error('Exact-silence browser preflight failed')
    const first = await browserRun('cc0-singing-first-worker-wasm', 'fresh')
    if (first.status !== 'completed' || !first.result.chunks.length || !first.workersCreated || first.downloadedFiles.length !== WHISPER_FILES.length) throw new Error('First real Worker/WASM inference did not pass')
    report.graph = { backend: 'browser-worker-wasm',
      evidence: 'The product Worker asserts all four actual decoder session outputNames before the first inference; successful inference passed that assertion.',
      requiredCrossAttentionOutputsPresent: true, requiredOutputs: [0, 1, 2, 3].map(index => `cross_attentions.${index}`) }
    report.browserCache = await page.evaluate(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url).sort() }), WHISPER_CACHE_NAME)
    if (JSON.stringify(report.browserCache.urls) !== JSON.stringify(WHISPER_FILES.map(file => file.url).sort())) throw new Error('Browser cache did not contain exactly the seven pinned model URLs')
    report.referenceLyricMapping = matchReferenceLyrics(first.validatedChunks, duration)
    const repeat = await browserRun('cc0-singing-repeat-same-worker', 'repeat')
    report.repeatIdenticalTextAndChunks = JSON.stringify(first.result.chunks) === JSON.stringify(repeat.result?.chunks)
    if (!report.repeatIdenticalTextAndChunks || repeat.workersCreated || repeat.modelFileGets) throw new Error('Repeated browser inference was not identical or reused the model incorrectly')
    const cached = await browserRun('cc0-singing-new-worker-from-cache', 'cached')
    if (cached.status !== 'completed' || cached.cacheReadFiles.length !== WHISPER_FILES.length || cached.modelFileGets || !cached.workersCreated) throw new Error('Verified persistent model cache reuse failed')
    const cancelled = await browserRun('cancel-after-transcribing-began', 'cancel')
    if (cancelled.error?.name !== 'AbortError' || !cancelled.cancelledAtTranscribing) throw new Error('Real Worker cancellation did not abort after transcription began')
    const retry = await browserRun('retry-after-worker-cancellation', 'repeat')
    if (retry.status !== 'completed' || !retry.workersCreated || retry.modelFileGets || retry.cacheReadFiles.length !== WHISPER_FILES.length || JSON.stringify(first.result.chunks) !== JSON.stringify(retry.result.chunks)) throw new Error('Retry after cancellation did not recreate a cached Worker with stable output')
    report.safetyChecks = {
      exactDigitalSilenceProductPreflight: silence.result,
      cancelledRunningWorkerThenRetried: true,
      verifiedNewWorkerCacheReuse: true,
      incorrectTextSource: 'synthetic unrelated lyrics; not fixture ground truth',
      actualSingingWithIncorrectText: matchLyricsToAsr([{ id: 'unrelated-negative', text: 'Cobalt submarines catalog geometric invoices', sung: true }], first.validatedChunks, { duration }).candidates,
    }
    await page.evaluate(() => globalThis.waveforgeSmoke.client?.dispose())
    await runAppUiSmoke(page, expect)
    expect(report.pageErrors, 'The actual application must have no unhandled page errors during browser smoke').toEqual([])
    if (report.network.forbiddenRequests.length) throw new Error('The browser attempted a request outside the GET/no-body allowlist')
    report.browserWasmValidated = true
    report.liveBrowserModelDownloadValidated = liveDownload
    report.completedAt = new Date().toISOString()
    await checkpoint('browser-smoke-passed-not-accuracy-validation')
  } finally { await browser.close() }
}
async function main() {
  if (!download && !probe && !browserSmoke) throw new Error('Choose --download and/or --probe/--infer/--browser; no model action runs by default')
  if (browserSmoke && probe) throw new Error('Browser smoke and Node CPU evidence must be separate invocations')
  if (liveDownload && !browserSmoke) throw new Error('--live-download is only valid with --browser')
  if (approved !== WHISPER_REVISION) throw new Error('Pass the exact --approved-revision only after explicit approval of this source and execution')
  const withinRepo = relative(repo, cacheRoot)
  if (!withinRepo || (!withinRepo.startsWith(`..${sep}`) && withinRepo !== '..')) throw new Error('Model cache must be outside the repository')
  await checkpoint('verifying-files')
  for (const file of WHISPER_FILES) {
    const path = resolve(modelDir, file.path)
    let exists = true
    try { await stat(path) } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error }
    if (!exists) {
      if (!download) throw new Error(`Missing ${file.path}; downloading requires --download`)
      await mkdir(dirname(path), { recursive: true })
      const partial = `${path}.partial`
      console.log(`Downloading exact manifest file: ${file.path}`)
      // curl follows the source's regular HTTPS CDN redirects. It receives no
      // audio, credentials, cookies, or form data; the destination is fixed.
      await run('curl', ['--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
        '--silent', '--show-error', '--max-time', '600', '--max-filesize', String(file.bytes),
        '--output', partial, file.url], { maxBuffer: 1024 * 1024 })
      await verifyFile(file, partial)
      await rename(partial, path)
    }
    report.files.push({ ...await verifyFile(file, path), source: exists ? 'existing-cache' : 'download' })
    console.log(`Verified ${file.path}: ${file.bytes} bytes, SHA-256 matches`)
    await checkpoint('verifying-files')
  }
  report.totalVerifiedBytes = report.files.reduce((sum, file) => sum + file.bytes, 0)
  if (browserSmoke) { await runBrowserSmoke(); return }
  if (!probe) { report.completedAt = new Date().toISOString(); await checkpoint('verified-only'); return }
  // There is no network permission after the exact manifest acquisition step.
  globalThis.fetch = async () => { throw new Error('Network disabled during exact-weight Node probe') }
  await checkpoint('probing-graph')
  const ort = await import('onnxruntime-node')
  report.onnxRuntimeNodeVersion = JSON.parse(await readFile(resolve(repo, 'node_modules/onnxruntime-node/package.json'), 'utf8')).version
  const session = await ort.InferenceSession.create(resolve(modelDir, 'onnx/decoder_model_merged_quantized.onnx'), {
    executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1,
  })
  report.graph = { backend: 'onnxruntime-node/cpu', inputNames: session.inputNames, outputNames: session.outputNames }
  try {
    assertCrossAttentionOutputs({ model: { sessions: { decoder_model_merged: session } } })
    report.graph.requiredCrossAttentionOutputsPresent = true
  } catch (error) {
    report.graph.requiredCrossAttentionOutputsPresent = false
    throw error
  } finally { await session.release() }
  console.log('ACTUAL GRAPH PASS: all four cross_attentions.0–3 outputs present')
  await checkpoint('graph-passed')
  if (!infer) { report.completedAt = new Date().toISOString(); await checkpoint('graph-passed'); return }

  const { manifest, samples, duration } = await authorizedFixture()
  const { env, pipeline } = await import('@huggingface/transformers')
  if (env.version !== WHISPER_VERSION) throw new Error('Unexpected Transformers.js runtime version')
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useFSCache = false
  env.useBrowserCache = false
  env.useCustomCache = false
  env.localModelPath = `${cacheRoot}/${WHISPER_REVISION}/`
  const loadStart = performance.now()
  const asr = await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
    revision: WHISPER_REVISION, local_files_only: true, device: 'cpu', dtype: { ...WHISPER_INFO.dtype },
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  })
  report.pipelineLoadMilliseconds = Math.round(performance.now() - loadStart)
  assertCrossAttentionOutputs(asr)
  installWhisperFrameCorrection(asr.model, env.version)
  const originalExtractor = asr.model._extract_token_timestamps
  asr.model._extract_token_timestamps = function (...values) {
    const active = report.runs.at(-1)
    active.melFrames = values[2]
    active.correctedEncoderFrames = Math.floor(values[2] / 2)
    active.crossAttentionShapes = values[0]?.cross_attentions?.[0]?.map(tensor => tensor.dims)
    return originalExtractor.apply(this, values)
  }
  async function transcribe(id, inputSamples) {
    const seconds = validateWhisperInput({ samples: inputSamples, sampleRate: 16000, language: manifest.language })
    const entry = { id, audioSeconds: seconds, startedAt: new Date().toISOString() }
    report.runs.push(entry)
    await checkpoint(`running-${id}`)
    const before = performance.now()
    try {
      const result = await asr(inputSamples, { language: manifest.language, task: 'transcribe',
        return_timestamps: 'word', chunk_length_s: 0, force_full_sequences: false })
      entry.elapsedMilliseconds = Math.round(performance.now() - before)
      entry.text = result.text
      entry.rawChunks = result.chunks
      try { entry.validatedChunks = validateWhisperChunks(result.chunks, seconds); entry.timestampContractPassed = true }
      catch (error) { entry.timestampContractPassed = false; entry.timestampValidationError = error.message }
      entry.status = 'completed'
    } catch (error) { entry.status = 'failed'; entry.error = { name: error.name, message: error.message }; entry.elapsedMilliseconds = Math.round(performance.now() - before) }
    console.log(JSON.stringify(entry))
    await checkpoint(`finished-${id}`)
    return entry
  }
  try {
    const first = await transcribe('cc0-singing-20s-first', samples)
    if (first.validatedChunks) report.referenceLyricMapping = matchReferenceLyrics(first.validatedChunks, duration)
    const second = await transcribe('cc0-singing-20s-repeat', samples)
    report.repeatIdenticalTextAndChunks = first.status === 'completed' && second.status === 'completed' &&
      first.text === second.text && JSON.stringify(first.rawChunks) === JSON.stringify(second.rawChunks)
    if (report.referenceLyricMapping) {
      const targetId = 'reference-3'
      const lines = report.referenceLyricMapping.result.candidates.map(row => ({
        id: row.id, text: row.text, sung: true, start: row.start, end: row.end, confirmed: false, manualLocked: false,
      }))
      const before = report.referenceLyricMapping.result.candidates.find(row => row.id === targetId)
      const windows = planAlignmentWindows(lines, [targetId], duration, true)
      const buffer = { sampleRate: 16000, numberOfChannels: 1, duration, length: samples.length, getChannelData: () => samples }
      const groups = []
      report.targetedSecondPass = {
        targetId, referenceText: before.text, backend: 'node-cpu',
        scope: 'Real second inference using production planner, crop preparation, offset/overlap join, and matcher; not manual-gold accuracy',
        planner: 'planAlignmentWindows(lines, [reference-3], 20, true)', contextLines: lines, windows,
        offsetsAppliedBy: 'joinWindowWords once, using measured prepareAlignmentWindow offset',
        before: { status: before.status, coverage: before.evidence.coverage,
          missingUnits: before.evidence.unmatchedNormalizedUnits, start: before.start, end: before.end },
        crops: [],
      }
      for (const [index, range] of windows.entries()) {
        const prepared = await prepareAlignmentWindow(buffer, range, { channel: 0 })
        const cropRun = await transcribe(`cc0-targeted-second-pass-${index + 1}`, prepared.samples)
        report.targetedSecondPass.crops.push({ range, offset: prepared.offset, duration: prepared.duration,
          inputFloat32PcmSha256: hash(Buffer.from(prepared.samples.buffer, prepared.samples.byteOffset, prepared.samples.byteLength)),
          runId: cropRun.id, timestampContractPassed: cropRun.timestampContractPassed })
        if (!cropRun.validatedChunks) { report.targetedSecondPass.status = 'rejected-invalid-asr-window'; break }
        groups.push({ ...range, ...prepared, samples: undefined, chunks: cropRun.validatedChunks })
      }
      if (groups.length === windows.length) {
        const joined = joinWindowWords(groups, duration)
        const result = matchLyricsToAsr(lines, joined.words, { duration, targetIds: [targetId], protectedIds: [] })
        const after = result.candidates.find(row => row.id === targetId)
        report.targetedSecondPass = { ...report.targetedSecondPass, status: 'completed', absoluteWords: joined.words,
          seamConflicts: joined.conflicts, result,
          after: { status: after.status, coverage: after.evidence.coverage,
            missingUnits: after.evidence.unmatchedNormalizedUnits, start: after.start, end: after.end },
          comparison: { coverageDelta: after.evidence.coverage - before.evidence.coverage,
            lexicalCoverageImproved: after.evidence.coverage > before.evidence.coverage,
            startDeltaSeconds: after.start == null ? null : after.start - before.start,
            endDeltaSeconds: after.end == null ? null : after.end - before.end,
            boundaryAccuracyMeasured: false, originalReferenceTextPreserved: after.text === before.text },
        }
      }
      console.log('TARGETED SECOND PASS', JSON.stringify(report.targetedSecondPass))
      await checkpoint('targeted-second-pass-recorded')
    }
    await transcribe('cc0-singing-first-5s-short-padding', samples.slice(0, 80000))
    const silence = await transcribe('synthetic-silence-2s', new Float32Array(32000))
    let seed = 50574
    const noise = Float32Array.from({ length: 32000 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed / 4294967296) * 2 - 1) * 0.02 })
    const noiseRun = await transcribe('synthetic-seeded-noise-2s', noise)
    const unrelatedLyrics = [{ id: 'unrelated-negative', text: 'Cobalt submarines catalog geometric invoices', sung: true }]
    const silenceClient = createWhisperClient({ modelSourceApproved: true,
      workerFactory: () => { throw new Error('Exact-silence preflight must never create a worker') } })
    const silencePreflight = await silenceClient.transcribe({ samples: new Float32Array(32000), sampleRate: 16000, language: manifest.language })
    silenceClient.dispose()
    report.safetyChecks = {
      incorrectTextSource: 'synthetic unrelated lyrics; not fixture ground truth',
      actualSingingWithIncorrectText: first.validatedChunks
        ? matchLyricsToAsr(unrelatedLyrics, first.validatedChunks, { duration }).candidates
        : { status: 'not-fed-to-matcher', reason: 'ASR timestamp contract failed' },
      silenceHasNonemptyRawText: Boolean(silence.text?.trim()),
      exactDigitalSilenceProductPreflight: silencePreflight,
      noiseHasNonemptyRawText: Boolean(noiseRun.text?.trim()),
      noFabricatedTimestampRepair: true,
    }
  } finally { await asr.dispose() }
  report.timestampContractAllPassed = report.runs.every(run => run.timestampContractPassed === true)
  report.completedAt = new Date().toISOString()
  await checkpoint(report.runs.every(run => run.status === 'completed') ? 'inference-evidence-complete' : 'inference-evidence-with-failures')
}

try { await main() }
catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack }
  report.completedAt = new Date().toISOString()
  await checkpoint('failed')
  console.error(error)
  process.exitCode = 1
}
