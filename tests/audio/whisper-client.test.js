// @vitest-environment node
// MOCKED LIFECYCLE / SOURCE CONTRACT TESTS. No model downloads or inference.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createWhisperClient } from '../../src/js/lyrics/whisper-client.js'
import {
  WHISPER_FILES, WHISPER_INFO, WHISPER_MODEL_INFO, WHISPER_REVISION,
  WHISPER_CACHE_NAME, validateWhisperInput, validateWhisperChunks, isExactDigitalSilence,
} from '../../src/js/lyrics/whisper-config.js'
import {
  verifyModelBytes, prepareVerifiedModelCache, assertCrossAttentionOutputs,
  isAllowedRuntimeRequest, installWhisperFrameCorrection,
} from '../../src/js/lyrics/whisper-worker.js'

vi.mock('@huggingface/transformers', () => { throw new Error('Default tests must never import the real model runtime') })

const input = () => ({ samples: new Float32Array(16000).fill(0.01), sampleRate: 16000, language: 'zh' })
const words = () => [{ text: '原文', timestamp: [0.2, 0.8] }]
function fixture(options = {}) {
  const workers = []
  const workerFactory = vi.fn(() => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() }
    workers.push(worker)
    return worker
  })
  const client = createWhisperClient({ modelSourceApproved: true, workerFactory, ...options })
  const message = (type, extra = {}, worker = workers.at(-1), id = worker.postMessage.mock.calls[0][0].id) => worker.onmessage({ data: { type, id, ...extra } })
  return { client, workers, workerFactory, message }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('mocked Whisper client lifecycle (no models)', () => {
  it('is side-effect free on creation and requires explicit model-source approval', async () => {
    const { client, workerFactory } = fixture({ modelSourceApproved: false })
    expect(client.info).toBe(WHISPER_INFO)
    expect(workerFactory).not.toHaveBeenCalled()
    await expect(client.transcribe(input())).rejects.toMatchObject({ name: 'ModelSourceApprovalError' })
    expect(workerFactory).not.toHaveBeenCalled()
    client.dispose()
  })
  it('transfers a copy and returns only relative validated words and honest metadata', async () => {
    const { client, workers, message } = fixture()
    const data = input(); data.samples[10] = 0.5
    const pending = client.transcribe(data)
    const [request, transfers] = workers[0].postMessage.mock.calls[0]
    expect(request.samples).not.toBe(data.samples)
    expect(request.samples.buffer).not.toBe(data.samples.buffer)
    expect(request.samples[10]).toBe(0.5)
    expect(transfers).toEqual([request.samples.buffer])
    expect(data.samples.byteLength).toBe(64000)
    message('result', { result: { chunks: words() } })
    const result = await pending
    expect(result.chunks).toEqual(words())
    expect(result.revision).toBe(WHISPER_REVISION)
    expect(result.timestampOrigin).toBe('window-relative')
    expect(result.modelValidation).toBe('pending-model-backed-validation')
    expect(result.chunks[0]).not.toHaveProperty('confidence')
    client.dispose()
  })
  it('reuses a worker for sequential windows and forwards measured progress only', async () => {
    const { client, workerFactory, workers, message } = fixture()
    const onProgress = vi.fn()
    const first = client.transcribe({ ...input(), onProgress })
    const progress = { phase: 'downloading', file: 'config.json', loaded: 12, total: 2248 }
    message('progress', { progress })
    expect(onProgress).toHaveBeenCalledWith(progress)
    message('result', { result: { chunks: words() } }); await first
    const second = client.transcribe(input())
    const secondId = workers[0].postMessage.mock.calls[1][0].id
    message('result', { result: { chunks: [] } }, workers[0], secondId)
    expect((await second).chunks).toEqual([])
    expect(workerFactory).toHaveBeenCalledOnce()
    client.dispose()
  })
  it('rejects concurrent work without disturbing the running job', async () => {
    const { client, message } = fixture()
    const first = client.transcribe(input())
    await expect(client.transcribe(input())).rejects.toMatchObject({ name: 'BusyError' })
    message('result', { result: { chunks: words() } }); await first; client.dispose()
  })
  it('terminates on cancellation and ignores messages from the old worker', async () => {
    const { client, workers, message } = fixture()
    const signal = new AbortController()
    const first = client.transcribe({ ...input(), signal: signal.signal })
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    signal.abort(); await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const second = client.transcribe(input())
    message('result', { result: { chunks: words() } }, workers[0])
    message('result', { result: { chunks: [] } }, workers[1])
    expect((await second).chunks).toEqual([]); client.dispose()
  })
  it('does not start a pre-aborted request', async () => {
    const { client, workerFactory } = fixture()
    await expect(client.transcribe({ ...input(), signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(workerFactory).not.toHaveBeenCalled(); client.dispose()
  })
  it('times out, terminates, and can create a clean replacement', async () => {
    vi.useFakeTimers()
    const { client, workers, message } = fixture({ timeoutMs: 50 })
    const pending = client.transcribe(input())
    const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(50); await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const next = client.transcribe(input())
    message('result', { result: { chunks: [] } }); await next; client.dispose()
  })
  it.each(['error', 'crash', 'messageerror'])('fails closed on worker %s', async mode => {
    const { client, workers, message } = fixture()
    const pending = client.transcribe(input())
    const rejection = expect(pending).rejects.toThrow()
    if (mode === 'error') message('error', { error: { message: 'cross-attentions missing' } })
    if (mode === 'crash') workers[0].onerror({ message: 'worker crashed', preventDefault: vi.fn() })
    if (mode === 'messageerror') workers[0].onmessageerror()
    await rejection; expect(workers[0].terminate).toHaveBeenCalledOnce(); client.dispose()
  })
  it('fails closed rather than repairing malformed model timestamps', async () => {
    const { client, workers, message } = fixture()
    const pending = client.transcribe(input())
    const rejection = expect(pending).rejects.toThrow(/timestamps/)
    message('result', { result: { chunks: [{ text: 'x', timestamp: [0, 2] }] } })
    await rejection; expect(workers[0].terminate).toHaveBeenCalledOnce(); client.dispose()
  })
  it('clears only the exact model cache and releases the current worker', async () => {
    const storage = { delete: vi.fn().mockResolvedValue(true), keys: vi.fn() }
    const { client, workers } = fixture({ cacheStorage: storage })
    const pending = client.transcribe(input())
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const result = await client.clearCache(); await rejection
    expect(result.deleted).toBe(true)
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(WHISPER_CACHE_NAME)
    expect(storage.keys).not.toHaveBeenCalled()
    expect(workers[0].terminate).toHaveBeenCalledOnce(); client.dispose()
  })
  it('disposal is idempotent, aborts work, and rejects future work', async () => {
    const { client, workers } = fixture()
    const pending = client.transcribe(input())
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    client.dispose(); client.dispose(); await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    await expect(client.transcribe(input())).rejects.toThrow(/disposed/)
  })
  it('serializes repeated cache clears and prevents loading while deletion is pending', async () => {
    let finishDelete
    const storage = { delete: vi.fn(() => new Promise(resolve => { finishDelete = resolve })) }
    const { client, workerFactory } = fixture({ cacheStorage: storage })
    const first = client.clearCache(), second = client.clearCache()
    await expect(client.transcribe(input())).rejects.toMatchObject({ name: 'BusyError' })
    expect(workerFactory).not.toHaveBeenCalled()
    finishDelete(true)
    expect((await first).deleted).toBe(true)
    expect((await second).deleted).toBe(true)
    expect(storage.delete).toHaveBeenCalledOnce(); client.dispose()
  })
})

describe('Whisper input and timestamp safety contracts', () => {
  it('returns no words for exact digital silence without creating a worker or executing a model', async () => {
    const { client, workerFactory } = fixture()
    const onProgress = vi.fn()
    const result = await client.transcribe({ ...input(), samples: new Float32Array(32000), onProgress })
    expect(result.chunks).toEqual([])
    expect(result.duration).toBe(2)
    expect(result.modelExecuted).toBe(false)
    expect(result.timingMethod).toBe('exact-digital-silence')
    expect(workerFactory).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ phase: 'complete' })
    client.dispose()
  })
  it('does not treat very quiet samples, noise, invalid values, or missing audio as silence', () => {
    expect(isExactDigitalSilence(Float32Array.of(0, -0))).toBe(true)
    expect(isExactDigitalSilence(Float32Array.of(0, 2 ** -149))).toBe(false)
    expect(isExactDigitalSilence(Float32Array.of(0, -0.00000001))).toBe(false)
    expect(isExactDigitalSilence(Float32Array.of(NaN))).toBe(false)
    expect(isExactDigitalSilence(new Float32Array())).toBe(false)
    expect(isExactDigitalSilence([0, 0])).toBe(false)
  })
  it('still requires approval and valid input before the exact-silence shortcut', async () => {
    const { client } = fixture({ modelSourceApproved: false })
    await expect(client.transcribe({ ...input(), samples: new Float32Array(32000) })).rejects.toMatchObject({ name: 'ModelSourceApprovalError' })
    client.dispose()
    const approved = fixture()
    await expect(approved.client.transcribe({ ...input(), samples: new Float32Array(319) })).rejects.toThrow(/20 ms/)
    expect(approved.workerFactory).not.toHaveBeenCalled()
    approved.client.dispose()
  })
  it.each([
    { samples: new Float32Array() }, { samples: [0, 1] }, { samples: new Float32Array(320001) },
    { samples: new Float32Array(319) },
    { samples: new Float32Array(320).fill(NaN) }, { samples: new Float32Array(320).fill(Infinity) },
    { sampleRate: 44100 }, { language: undefined }, { language: 'auto' }, { language: 'yue' },
  ])('rejects unsupported input %j without creating a worker', async override => {
    const { client, workerFactory } = fixture()
    await expect(client.transcribe({ ...input(), ...override })).rejects.toThrow()
    expect(workerFactory).not.toHaveBeenCalled(); client.dispose()
  })
  it('accepts exactly 20 seconds and explicit supported languages', () => {
    expect(validateWhisperInput({ samples: new Float32Array(320000), sampleRate: 16000, language: 'ja' })).toBe(20)
  })
  it.each([
    null, [{ text: 'x', timestamp: [null, 1] }], [{ text: 'x', timestamp: [NaN, 1] }],
    [{ text: 'x', timestamp: [0, Infinity] }], [{ text: 'x', timestamp: [-1, 0.5] }],
    [{ text: 'x', timestamp: [0.5, 0.5] }], [{ text: 'x', timestamp: [0.8, 0.2] }],
    [{ text: 'x', timestamp: [0, 1.01] }], [{ text: '', timestamp: [0, 1] }],
    [{ text: 'x', timestamp: [0, 0.8] }, { text: 'y', timestamp: [0.7, 1] }],
  ])('rejects malformed word results %j', chunks => {
    expect(() => validateWhisperChunks(chunks, 1)).toThrow()
  })
  it('preserves real gaps and exact word strings without adding confidence', () => {
    expect(validateWhisperChunks([{ text: ' 你好！', timestamp: [0.2, 0.4], confidence: 1 }, { text: ' friend', timestamp: [0.7, 1] }], 1))
      .toEqual([{ text: ' 你好！', timestamp: [0.2, 0.4] }, { text: ' friend', timestamp: [0.7, 1] }])
  })
})

describe('version-pinned mel-to-encoder crop correction (synthetic only)', () => {
  it.each([[2000, 1000], [1000, 500], [101, 50], [1999, 999], [3, 1], [2, 1]])('converts %i mel frames to %i encoder frames once, without changing outputs', (melFrames, encoderFrames) => {
    const sentinel = { token_timestamps: Float32Array.of(0.12, 0.28) }
    const original = vi.fn(function () { expect(this).toBe(model); return sentinel })
    const model = { _extract_token_timestamps: original }
    const outputs = { cross_attentions: 'synthetic-placeholder' }, heads = [[2, 2]]
    installWhisperFrameCorrection(model, '3.8.1')
    const wrapped = model._extract_token_timestamps
    installWhisperFrameCorrection(model, '3.8.1')
    expect(model._extract_token_timestamps).toBe(wrapped)
    expect(model._extract_token_timestamps(outputs, heads, melFrames, 0.02)).toBe(sentinel)
    expect(original).toHaveBeenCalledExactlyOnceWith(outputs, heads, encoderFrames, 0.02)
    expect([...sentinel.token_timestamps]).toEqual([...Float32Array.of(0.12, 0.28)])
  })
  it.each([0, 1, -1, 2.5, 2001, NaN, Infinity, null, undefined, '2000'])('rejects invalid mel-frame count %s before delegation', melFrames => {
    const original = vi.fn(), model = { _extract_token_timestamps: original }
    installWhisperFrameCorrection(model, '3.8.1')
    expect(() => model._extract_token_timestamps({}, [], melFrames)).toThrow(/frame/)
    expect(original).not.toHaveBeenCalled()
  })
  it('refuses another version or an altered extractor instead of double-dividing', () => {
    const model = { _extract_token_timestamps: vi.fn() }
    expect(() => installWhisperFrameCorrection(model, '4.3.0')).toThrow(/3.8.1/)
    expect(() => installWhisperFrameCorrection({}, '3.8.1')).toThrow(/extractor/)
    installWhisperFrameCorrection(model, '3.8.1')
    model._extract_token_timestamps = vi.fn()
    expect(() => installWhisperFrameCorrection(model, '3.8.1')).toThrow(/changed/)
  })
  it('asserts the exact installed upstream frame-unit contract without importing runtime code', () => {
    const pipeline = readFileSync(new URL('../../node_modules/@huggingface/transformers/src/pipelines.js', import.meta.url), 'utf8')
    const model = readFileSync(new URL('../../node_modules/@huggingface/transformers/src/models.js', import.meta.url), 'utf8')
    expect(pipeline).toContain('generation_config.num_frames = Math.floor(chunk.stride[0] / hop_length)')
    expect(model).toContain('_extract_token_timestamps(generate_outputs, alignment_heads, num_frames = null, time_precision = 0.02)')
    expect(model).toContain('cross_attentions[l].slice(null, h, null, [0, num_frames])')
    const worker = readFileSync(new URL('../../src/js/lyrics/whisper-worker.js', import.meta.url), 'utf8')
    expect(worker).toContain('installWhisperFrameCorrection(asr.model, env.version)')
  })
})

describe('mocked integrity cache (tiny synthetic bytes; NOT model files)', () => {
  const bytes = new TextEncoder().encode('abc')
  const file = { path: 'fixture.json', bytes: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', url: 'https://fixture.invalid/fixed/fixture.json' }
  it('verifies byte count and SHA-256, rejecting mutation and missing crypto', async () => {
    expect(await verifyModelBytes(bytes, file, webcrypto)).toBe(bytes)
    await expect(verifyModelBytes(bytes.subarray(0, 2), file, webcrypto)).rejects.toThrow(/size/)
    await expect(verifyModelBytes(new TextEncoder().encode('abd'), file, webcrypto)).rejects.toThrow(/integrity/)
    await expect(verifyModelBytes(bytes, file, {})).rejects.toThrow(/SHA-256/)
  })
  it('fetches a static GET, verifies before caching, and exposes only known keys', async () => {
    const persistent = { match: vi.fn().mockResolvedValue(undefined), put: vi.fn().mockResolvedValue() }
    const fetchImpl = vi.fn().mockResolvedValue(new Response(bytes))
    const onProgress = vi.fn()
    const cache = await prepareVerifiedModelCache({ files: [file], fetchImpl, cryptoImpl: webcrypto, cacheStorage: { open: vi.fn().mockResolvedValue(persistent) }, onProgress })
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(file.url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
    expect(persistent.put).toHaveBeenCalledOnce()
    expect(await (await cache.match(file.url)).text()).toBe('abc')
    expect(await cache.match('https://other.invalid/model.onnx')).toBeUndefined()
    await expect(cache.put()).rejects.toThrow(/verified/)
    expect(onProgress.mock.calls.map(([p]) => p)).toContainEqual({ phase: 'downloading', file: file.path, loaded: 3, total: 3, aggregateLoaded: 3, aggregateTotal: 3 })
  })
  it('revalidates persisted bytes and never silently redownloads corrupt data', async () => {
    const fetchImpl = vi.fn()
    const persistent = { match: vi.fn().mockResolvedValue(new Response('abd')), put: vi.fn() }
    await expect(prepareVerifiedModelCache({ files: [file], fetchImpl, cryptoImpl: webcrypto, cacheStorage: { open: vi.fn().mockResolvedValue(persistent) } })).rejects.toThrow(/integrity/)
    expect(fetchImpl).not.toHaveBeenCalled(); expect(persistent.put).not.toHaveBeenCalled()
  })
  it('uses valid cache without network and handles unavailable persistent storage', async () => {
    const fetchImpl = vi.fn()
    await prepareVerifiedModelCache({ files: [file], fetchImpl, cryptoImpl: webcrypto, cacheStorage: { open: vi.fn().mockResolvedValue({ match: vi.fn().mockResolvedValue(new Response(bytes)) }) } })
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValue(new Response(bytes))
    const cache = await prepareVerifiedModelCache({ files: [file], fetchImpl, cryptoImpl: webcrypto, cacheStorage: { open: vi.fn().mockRejectedValue(new Error('private mode')) } })
    expect(await (await cache.match(file.url)).text()).toBe('abc')
  })
  it.each([new Response('abc', { status: 403 }), new Response('ab'), new Response('abcd')])('rejects incomplete, oversized or failed HTTP responses', async response => {
    await expect(prepareVerifiedModelCache({ files: [file], fetchImpl: vi.fn().mockResolvedValue(response), cryptoImpl: webcrypto, cacheStorage: null })).rejects.toThrow()
  })
})

describe('pinned source and no-model default-test contracts', () => {
  it('has exact model size, immutable revision, metadata aliases and hashes', () => {
    expect(WHISPER_MODEL_INFO).toBe(WHISPER_INFO)
    expect(WHISPER_INFO.downloadBytes).toBe(66406756)
    expect(WHISPER_INFO.license).toBe('Apache-2.0')
    expect(WHISPER_INFO.languages).toHaveLength(99)
    expect(WHISPER_FILES).toHaveLength(7)
    for (const file of WHISPER_FILES) {
      expect(file.url).toContain(`/resolve/${WHISPER_REVISION}/`)
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })
  it('requires actual ONNX session outputs, not merely alignment_heads config', () => {
    expect(() => assertCrossAttentionOutputs({ model: { config: { alignment_heads: [[2, 2]] } } })).toThrow(/cross-attention/)
    expect(() => assertCrossAttentionOutputs({ model: { sessions: { decoder_model_merged: { outputNames: ['logits', ...[0, 1, 2, 3].map(i => `cross_attentions.${i}`)] } } } })).not.toThrow()
  })
  it('allows only specified same-origin runtime assets and GET without payloads', () => {
    const url = 'https://waveforge.example/assets/ort-pinned.wasm'
    expect(isAllowedRuntimeRequest(url, {}, [url])).toBe(true)
    expect(isAllowedRuntimeRequest(url, { method: 'POST', body: 'audio' }, [url])).toBe(false)
    expect(isAllowedRuntimeRequest(url + '?audio=private', {}, [url])).toBe(false)
    expect(isAllowedRuntimeRequest('https://cdn.jsdelivr.net/other.wasm', {}, [url])).toBe(false)
  })
  it('pins dependencies and keeps real inference out of default test commands', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(pkg.dependencies['@huggingface/transformers']).toBe('3.8.1')
    expect(pkg.scripts.test).toBe('vitest run')
    const source = readFileSync(new URL('../../src/js/lyrics/whisper-worker.js', import.meta.url), 'utf8')
    expect(source).toContain("await import('@huggingface/transformers')")
    expect(source).toContain('chunk_length_s: 0')
    expect(source).not.toContain('cdn.jsdelivr.net')
    expect(source).not.toContain("method: 'POST'")
  })
})

// This suite is OFF in npm test/build/CI. It is a real browser/model probe, not
// permission to execute it. Both an exact approved revision and a local, owned
// fixture manifest must be supplied AFTER the user approves this model source.
describe.skipIf(process.env.WAVEFORGE_REAL_MODEL_TEST !== '1')('OPT-IN real browser model fixture (not yet executed)', () => {
  it('checks a user-approved local fixture against manually annotated anchors', async () => {
    expect(process.env.WAVEFORGE_MODEL_APPROVED_REVISION).toBe(WHISPER_REVISION)
    const fixturePath = process.env.WAVEFORGE_MODEL_FIXTURE
    if (!fixturePath) throw new Error('WAVEFORGE_MODEL_FIXTURE must name an authorized, manually annotated local fixture')
    const origin = new URL(process.env.WAVEFORGE_TEST_URL || 'http://127.0.0.1:5173/')
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
      throw new Error('Real-model fixture tests only target a local development server')
    }
    const manifest = JSON.parse(readFileSync(fixturePath, 'utf8'))
    if (manifest.rightsConfirmed !== true || !Array.isArray(manifest.expectedAnchors) || manifest.expectedAnchors.length < 2) {
      throw new Error('Fixture requires confirmed rights and at least two manual timestamp anchors')
    }
    const pcmBytes = readFileSync(resolve(dirname(fixturePath), manifest.pcmFile))
    if (!pcmBytes.length || pcmBytes.length % 4 !== 0) throw new Error('Fixture PCM must contain float32 little-endian samples')
    const samples = Float32Array.from({ length: pcmBytes.length / 4 }, (_, i) => pcmBytes.readFloatLE(i * 4))
    validateWhisperInput({ samples, sampleRate: manifest.sampleRate, language: manifest.language })
    const tolerance = manifest.maxBoundaryErrorSeconds
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) throw new Error('Fixture must set an explicit boundary tolerance <= 1 second')
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      // During this probe no external HTTP body may carry audio/lyrics.
      await page.route('**/*', route => {
        const request = route.request()
        const url = new URL(request.url())
        if (url.origin !== origin.origin && (request.method() !== 'GET' || request.postData() != null)) return route.abort()
        return route.continue()
      })
      await page.goto(origin.href)
      const result = await page.evaluate(async ({ samples, language, sampleRate }) => {
        const { createWhisperClient } = await import('/src/js/lyrics/whisper-client.js')
        const client = createWhisperClient({ modelSourceApproved: true, timeoutMs: 540000 })
        try { return await client.transcribe({ samples: Float32Array.from(samples), language, sampleRate }) }
        finally { client.dispose() }
      }, { samples: [...samples], language: manifest.language, sampleRate: manifest.sampleRate })
      expect(result.revision).toBe(WHISPER_REVISION)
      expect(result.chunks.length).toBeGreaterThan(0)
      let previousIndex = -1
      for (const anchor of manifest.expectedAnchors) {
        const index = result.chunks.findIndex((chunk, i) => i > previousIndex && chunk.text.trim() === anchor.text)
        expect(index, `Missing reference anchor: ${anchor.text}`).toBeGreaterThan(previousIndex)
        const chunk = result.chunks[index]
        expect(Math.abs(chunk.timestamp[0] - anchor.timestamp[0])).toBeLessThanOrEqual(tolerance)
        expect(Math.abs(chunk.timestamp[1] - anchor.timestamp[1])).toBeLessThanOrEqual(tolerance)
        previousIndex = index
      }
    } finally { await browser.close() }
  }, 600000)
})
