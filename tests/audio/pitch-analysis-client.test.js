// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPitchAnalysisClient } from '../../src/js/pitch/analysis-client.js'
import { createPitchWorkerHandler } from '../../src/js/pitch/analysis-worker.js'
import { analyzePitch, PITCH_ANALYSIS_INFO } from '../../src/js/pitch/analysis.js'
import { fakeAudioBuffer, tone } from './pitch-analysis-fixtures.js'

function fixture(options = {}) {
  const workers = []
  const workerFactory = vi.fn(() => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() }
    workers.push(worker)
    return worker
  })
  const client = createPitchAnalysisClient({ workerFactory, ...options })
  const request = (worker = workers.at(-1)) => worker.postMessage.mock.calls.at(-1)[0]
  const message = (type, extra = {}, worker = workers.at(-1), id = request(worker).id) => worker.onmessage({ data: { type, id, ...extra } })
  async function complete(worker = workers.at(-1)) {
    const job = request(worker)
    const result = await analyzePitch(job.samples, job.sampleRate, { start: job.start })
    message('result', { result }, worker, job.id)
    return result
  }
  return { client, workers, workerFactory, request, message, complete }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('pitch worker client lifecycle (mock Worker, real DSP results)', () => {
  it('is lazy and preserves selected source PCM while transferring only a window copy', async () => {
    const { client, workerFactory, request, workers, complete } = fixture()
    expect(client.info).toBe(PITCH_ANALYSIS_INFO)
    expect(workerFactory).not.toHaveBeenCalled()
    const source = tone({ duration: 1 })
    const snapshot = source.slice()
    const pending = client.analyze(fakeAudioBuffer([source]), { start: 0.2, duration: 0.3 })
    const job = request()
    expect(job.start).toBe(0.2)
    expect(job.samples.length).toBe(14400)
    expect(job.samples.buffer).not.toBe(source.buffer)
    expect(workers[0].postMessage.mock.calls[0][1]).toEqual([job.samples.buffer])
    expect(job.samples).toEqual(source.slice(9600, 24000))
    await complete()
    const result = await pending
    expect(result.frames[0].time).toBeCloseTo(0.232)
    expect(result.channel).toBe(0)
    expect(result.analyzedChannel).toBe(0)
    expect(source).toEqual(snapshot)
    expect(source.byteLength).toBe(48000 * 4)
    client.dispose()
  })
  it('analyzes an explicitly selected channel, without stereo phase cancellation', async () => {
    const { client, complete } = fixture()
    const left = tone({ frequency: 440 })
    const right = Float32Array.from(left, value => -value)
    const resultPromise = client.analyze(fakeAudioBuffer([left, right]), { channel: 1 })
    await complete()
    const result = await resultPromise
    expect(result.analyzedChannel).toBe(1)
    expect(result.summary.medianFrequencyHz).toBeCloseTo(440, 0)
    client.dispose()
  })
  it('caps an unspecified window to 60 seconds before transfer and rejects explicit oversized selections', async () => {
    const { client, request } = fixture()
    const audio = fakeAudioBuffer([new Float32Array(8000 * 61)], 8000)
    await expect(client.analyze(audio, { duration: 61 })).rejects.toThrow(/60 seconds/)
    const pending = client.analyze(audio)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(request().samples.length).toBe(8000 * 60)
    client.cancel(); await rejection; client.dispose()
  })
  it('rejects invalid buffers, selection, channels, and timeout settings without starting a worker', async () => {
    const { client, workerFactory } = fixture()
    for (const data of [null, {}, fakeAudioBuffer([tone()], 1)]) await expect(client.analyze(data)).rejects.toThrow()
    for (const options of [{ start: -1 }, { start: 9 }, { duration: NaN }, { duration: -1 }, { duration: 60 }, { channel: 1 }, { channel: 0.2 }]) await expect(client.analyze(fakeAudioBuffer(), options)).rejects.toThrow()
    expect(workerFactory).not.toHaveBeenCalled()
    for (const timeoutMs of [0, -1, NaN, Infinity]) expect(() => createPitchAnalysisClient({ timeoutMs })).toThrow()
    client.dispose()
  })
  it('latest request aborts the previous worker and ignores stale results/progress', async () => {
    const { client, workers, complete, message } = fixture()
    const oldProgress = vi.fn()
    const first = client.analyze(fakeAudioBuffer(), { onProgress: oldProgress })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const progress = vi.fn()
    const second = client.analyze(fakeAudioBuffer(), { onProgress: progress })
    await rejected
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    message('result', { result: {} }, workers[0])
    message('progress', { progress: { progress: 1 } }, workers[0])
    message('progress', { progress: { progress: 0.5 } }, workers[1], 1000)
    expect(progress).not.toHaveBeenCalled()
    await complete(workers[1])
    expect((await second).summary.voicedFrames).toBeGreaterThan(0)
    client.dispose()
  })
  it('reuses a worker sequentially and discards old IDs on that same instance', async () => {
    const { client, workers, workerFactory, complete, message, request } = fixture()
    const first = client.analyze(fakeAudioBuffer())
    const firstId = request().id
    await complete(); await first
    const onProgress = vi.fn(() => { throw new Error('observer failure') })
    const second = client.analyze(fakeAudioBuffer(), { onProgress })
    message('result', { result: {} }, workers[0], firstId)
    message('progress', { progress: { phase: 'analyzing', progress: 0.5 } })
    await complete()
    expect((await second).summary.voicedFrames).toBeGreaterThan(0)
    expect(onProgress).toHaveBeenCalledOnce()
    expect(workerFactory).toHaveBeenCalledOnce()
    client.dispose()
  })
  it('honors AbortSignal and explicit cancellation, with a clean later retry', async () => {
    const { client, workers, complete } = fixture()
    await expect(client.analyze(fakeAudioBuffer(), { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(workers).toHaveLength(0)
    const controller = new AbortController()
    const first = client.analyze(fakeAudioBuffer(), { signal: controller.signal })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const next = client.analyze(fakeAudioBuffer())
    await complete(); await next
    client.dispose()
  })
  it('times out and permits a replacement, with no late result accepted', async () => {
    vi.useFakeTimers()
    const { client, workers, message } = fixture({ timeoutMs: 20 })
    const pending = client.analyze(fakeAudioBuffer())
    const rejection = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(20); await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    message('result', { result: {} }, workers[0])
    vi.useRealTimers()
    const next = client.analyze(fakeAudioBuffer())
    const nextRejected = expect(next).rejects.toMatchObject({ name: 'AbortError' })
    client.cancel(); await nextRejected; client.dispose()
  })
  it.each(['error', 'crash', 'decode', 'unknown', 'malformed'])('fails closed on %s and terminates', async mode => {
    const { client, workers, message } = fixture()
    const pending = client.analyze(fakeAudioBuffer())
    const rejected = expect(pending).rejects.toThrow()
    if (mode === 'error') message('error', { error: { message: 'bad input' } })
    if (mode === 'crash') workers[0].onerror({ message: 'crash', preventDefault: vi.fn() })
    if (mode === 'decode') workers[0].onmessageerror()
    if (mode === 'unknown') message('surprise')
    if (mode === 'malformed') message('result', { result: { frames: [] } })
    await rejected
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    client.dispose()
  })
  it('fails closed if a worker supplies pitch for an unknown frame', async () => {
    const { client, message, request } = fixture()
    const pending = client.analyze(fakeAudioBuffer())
    const rejected = expect(pending).rejects.toThrow(/Unknown pitch/)
    const input = request()
    const result = await analyzePitch(input.samples, input.sampleRate)
    result.frames[0].state = 'uncertain'
    message('result', { result }); await rejected
    client.dispose()
  })
  it('handles worker startup and postMessage failures', async () => {
    for (const workerFactory of [() => { throw new Error('unsupported') }, () => ({ terminate() {}, postMessage() { throw new Error('transfer failed') } })]) {
      const client = createPitchAnalysisClient({ workerFactory })
      await expect(client.analyze(fakeAudioBuffer())).rejects.toThrow()
      client.dispose()
    }
  })
  it('disposes idempotently and cannot be reused', async () => {
    const { client, workers } = fixture()
    const pending = client.analyze(fakeAudioBuffer())
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    client.dispose(); client.dispose(); await rejection
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    await expect(client.analyze(fakeAudioBuffer())).rejects.toThrow(/disposed/)
  })
})

describe('real pitch worker message handler', () => {
  it('runs real DSP and returns matching source-time metadata with no network/model dependency', async () => {
    const messages = []
    const handler = createPitchWorkerHandler(message => messages.push(message))
    const samples = tone()
    const snapshot = samples.slice()
    await handler({ data: { type: 'analyze', id: 1, samples, sampleRate: 48000, start: 5 } })
    const result = messages.find(message => message.type === 'result')
    expect(result.id).toBe(1)
    expect(result.result.start).toBe(5)
    expect(result.result.frames[0].time).toBeCloseTo(5.032)
    expect(result.result.summary.medianFrequencyHz).toBeCloseTo(440, 0)
    expect(samples).toEqual(snapshot)
  })
  it('cancels a worker job and never emits a successful stale result', async () => {
    const messages = []
    const handler = createPitchWorkerHandler(message => messages.push(message))
    const pending = handler({ data: { type: 'analyze', id: 1, samples: tone({ duration: 2 }), sampleRate: 48000 } })
    await handler({ data: { type: 'cancel', id: 1 } })
    await pending
    expect(messages.some(message => message.type === 'result')).toBe(false)
    expect(messages.at(-1)).toMatchObject({ type: 'error', id: 1, error: { name: 'AbortError' } })
  })
  it('supersedes old jobs and reports only the current completion', async () => {
    const messages = []
    const handler = createPitchWorkerHandler(message => messages.push(message))
    const first = handler({ data: { type: 'analyze', id: 1, samples: tone({ duration: 2 }), sampleRate: 48000 } })
    const second = handler({ data: { type: 'analyze', id: 2, samples: tone({ frequency: 220 }), sampleRate: 48000 } })
    await Promise.all([first, second])
    expect(messages.filter(message => message.type === 'result').map(message => message.id)).toEqual([2])
    expect(messages.some(message => message.type === 'error' && message.id === 1)).toBe(false)
  })
  it('ignores malformed messages and reports invalid PCM as a job error', async () => {
    const messages = []
    const handler = createPitchWorkerHandler(message => messages.push(message))
    await handler({ data: { type: 'other', id: 1 } })
    await handler({ data: { type: 'analyze', id: -1 } })
    expect(messages).toHaveLength(0)
    await handler({ data: { type: 'analyze', id: 1, samples: null, sampleRate: 48000 } })
    expect(messages[0]).toMatchObject({ type: 'error', id: 1, error: { name: 'TypeError' } })
  })
})
