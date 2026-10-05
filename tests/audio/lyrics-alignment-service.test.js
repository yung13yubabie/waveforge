import { describe, it, expect, vi } from 'vitest'
import { createLocalAlignmentService, planAlignmentWindows, prepareAlignmentWindow, chooseAnalysisChannel, joinWindowWords } from '../../src/js/lyrics/alignment-service.js'
import { validateWhisperInput } from '../../src/js/lyrics/whisper-config.js'
import { createSession, editLine } from '../../src/js/lyrics/session.js'

// These are timing/control tests with synthetic PCM and a MOCK recognizer.
// They neither download weights nor establish model/singing accuracy.
const hash = 'a'.repeat(64)
function audio(duration = 5, rate = 16000, levels = [.1]) {
  const channels = levels.map(level => new Float32Array(Math.ceil(duration * rate)).fill(level))
  return { duration: channels[0].length / rate, sampleRate: rate, numberOfChannels: channels.length,
    getChannelData: channel => channels[channel] }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const prepared = (_buffer, range) => Promise.resolve({ samples: new Float32Array(Math.round((range.end - range.start) * 16000)).fill(.1),
  sampleRate: 16000, offset: range.start, duration: range.end - range.start, silent: false })
function fixture(options = {}) {
  const buffer = audio(options.duration ?? 5)
  const source = { name: 'synthetic.wav', hash, duration: buffer.duration }, session = createSession('Hello', source)
  const client = { transcribe: vi.fn(async () => ({ chunks: [{ text: 'Hello', timestamp: [1, 2] }] })), dispose: vi.fn(), clearCache: vi.fn(async () => ({ deleted: true })) }
  const factory = vi.fn(() => client)
  const service = createLocalAlignmentService({ clientFactory: factory, prepareWindow: prepared, ...options })
  return { service, client, factory, session, args: { buffer, source, lines: session.lines, revision: session.revision,
    targetIds: ['line-1'], language: 'en', modelSourceApproved: true } }
}

class RecordingOfflineContext {
  constructor(channels, length, rate) { this.channels = channels; this.length = length; this.rate = rate; this.destination = {} }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length)
    return { sampleRate: rate, getChannelData: () => data, copyToChannel: input => data.set(input) }
  }
  createBufferSource() { const context = this; return { connect() {}, disconnect() {}, start() { context.input = this.buffer } } }
  async startRendering() {
    const input = this.input.getChannelData(0)
    return { getChannelData: () => Float32Array.from({ length: this.length }, (_, i) => input[Math.min(input.length - 1, Math.floor(i * this.input.sampleRate / this.rate))]) }
  }
}

describe('analysis PCM clock and window contract', () => {
  it.each([16000, 44100, 48000, 96000])('caps decimal 20-second windows to the model limit at %s Hz', async rate => {
    const buffer = audio(45, rate)
    for (const range of [{ start: 1.001, end: 21.001 }, { start: 18.004, end: 38.004000000000005 }]) {
      const result = await prepareAlignmentWindow(buffer, range, { OfflineContext: RecordingOfflineContext })
      expect(result.samples.length).toBeLessThanOrEqual(320000)
      expect(result.offset).toBe(Math.floor(range.start * rate) / rate)
      expect(result.duration).toBe(result.samples.length / 16000)
      expect(() => validateWhisperInput({ ...result, language: 'en' })).not.toThrow()
      expect(buffer.getChannelData(0).length).toBe(Math.ceil(45 * rate))
    }
  })

  it('avoids opposite-phase cancellation by selecting a source channel', async () => {
    const buffer = audio(1, 16000, [.1, -.1])
    expect(chooseAnalysisChannel(buffer)).toBe(0)
    expect(chooseAnalysisChannel(audio(1, 16000, [.1, .2]))).toBe(1)
    const result = await prepareAlignmentWindow(buffer, { start: 0, end: 1 })
    expect(result.silent).toBe(false)
    expect(result.samples[0]).toBeCloseTo(.1)
  })

  it('identifies digital silence without requiring any ML classifier', async () => {
    const result = await prepareAlignmentWindow(audio(1, 16000, [0]), { start: 0, end: 1 })
    expect(result.silent).toBe(true)
  })

  it('does not discard quiet nonzero audio as if it were digital silence', async () => {
    const result = await prepareAlignmentWindow(audio(1, 16000, [1e-7]), { start: 0, end: 1 })
    expect(result.silent).toBe(false)
    expect(result.samples[0]).toBeGreaterThan(0)
  })

  it('rejects malformed ranges, samples and cancellation without repairing input', async () => {
    const buffer = audio(21)
    for (const range of [{ start: 0, end: 21 }, { start: NaN, end: 3 }, { start: -1, end: 2 }, { start: 2, end: 2 }]) {
      await expect(prepareAlignmentWindow(buffer, range)).rejects.toThrow()
    }
    buffer.getChannelData(0)[10] = NaN
    await expect(prepareAlignmentWindow(buffer, { start: 0, end: 1 })).rejects.toThrow('無效')
    const controller = new AbortController(); controller.abort()
    await expect(prepareAlignmentWindow(audio(), { start: 0, end: 1 }, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('uses real anchor context and a shifted seam strategy on a second pass', () => {
    const lines = [{ id: 'a', start: 1, end: 3 }, { id: 'b', start: null, end: null }, { id: 'c', start: 9, end: 11 }]
    expect(planAlignmentWindows(lines, ['b'], 30, true)).toEqual([{ start: 1, end: 11 }])
    expect(planAlignmentWindows([{ id: 'a', start: null, end: null }], ['a'], 40, false)).toEqual([{ start: 0, end: 20 }, { start: 18, end: 38 }, { start: 36, end: 40 }])
    const second = planAlignmentWindows([{ id: 'a', start: null, end: null }], ['a'], 40, true)
    expect(second[0]).toEqual({ start: 0, end: 11 }); expect(second[1].start).toBe(9)
    expect(second.every(window => window.end - window.start <= 20)).toBe(true)
    expect(planAlignmentWindows([{ id: 'a', start: null, end: null }], ['a'], 8, true)).toEqual([{ start: 0, end: 5.2 }, { start: 3.2, end: 8 }])
    expect(() => planAlignmentWindows(lines, ['b'], 1201)).toThrow('20 分鐘')
  })

  it('adds crop offsets exactly once and resolves overlap by ownership, never averaging', () => {
    const grouped = [
      { start: 0, end: 20, offset: 0, duration: 20, chunks: [{ text: 'hello', timestamp: [18.6, 19.3] }] },
      { start: 18, end: 30, offset: 18, duration: 12, chunks: [{ text: 'hello', timestamp: [.85, 1.2] }, { text: 'later', timestamp: [5, 6] }] },
    ]
    const result = joinWindowWords(grouped, 30)
    expect(result.words).toHaveLength(2)
    expect([[18.6, 19.3], [18.85, 19.2]]).toContainEqual(result.words[0].timestamp)
    expect(result.words[1].timestamp).toEqual([23, 24])
  })

  it('leaves a gap for contradictory overlapping words and invalid endpoints', () => {
    const groups = [
      { start: 0, end: 20, offset: 0, duration: 20, chunks: [{ text: 'one', timestamp: [18.6, 19.3] }, { text: 'invalid', timestamp: [1, Infinity] }] },
      { start: 18, end: 30, offset: 18, duration: 12, chunks: [{ text: 'different', timestamp: [.85, 1.2] }] },
    ]
    const result = joinWindowWords(groups, 30)
    expect(result.words).toEqual([]); expect(result.conflicts).toHaveLength(1)
  })
})

describe('local alignment service lifecycle (mock recognizer)', () => {
  it('requires consent and language before creating any client', async () => {
    const { service, args, factory } = fixture()
    await expect(service.run({ ...args, modelSourceApproved: false })).rejects.toThrow('來源')
    await expect(service.run({ ...args, language: 'auto' })).rejects.toThrow('語言')
    expect(factory).not.toHaveBeenCalled()
  })

  it('returns audio-derived candidates with source revision, without mutating input', async () => {
    const { service, args, client } = fixture(), before = structuredClone(args.lines)
    const result = await service.run(args)
    expect(result.candidates[0]).toMatchObject({ id: 'line-1', text: 'Hello', status: 'matched', start: 1, end: 2 })
    expect(result.run).toMatchObject({ sourceHash: hash, sourceRevision: 0, language: 'en', backend: 'wasm', pass: 1 })
    expect(args.lines).toEqual(before); expect(client.transcribe).toHaveBeenCalledTimes(1)
  })

  it('never invokes a model for fully silent audio and leaves lyrics unresolved', async () => {
    const { service, args, factory } = fixture({ prepareWindow: async (...values) => ({ ...await prepared(...values), silent: true }) })
    const result = await service.run(args)
    expect(factory).not.toHaveBeenCalled()
    expect(result.candidates[0]).toMatchObject({ status: 'unresolved', start: null, end: null })
  })

  it('rejects protected targets and wrong source duration before starting inference', async () => {
    const { service, args, factory } = fixture()
    await expect(service.run({ ...args, lines: [{ ...args.lines[0], manualLocked: true }] })).rejects.toThrow('保護')
    await expect(service.run({ ...args, source: { ...args.source, duration: 100 } })).rejects.toThrow('來源')
    expect(factory).not.toHaveBeenCalled()
  })

  it('supports a target-only second pass between protected anchor lines', async () => {
    const { service, args, client } = fixture({ duration: 30 })
    let session = createSession('Before\nHello\nAfter', args.source)
    session = editLine(session, 'line-1', { start: 1, end: 3 }); session = editLine(session, 'line-3', { start: 9, end: 11 })
    client.transcribe.mockResolvedValue({ chunks: [{ text: 'Hello', timestamp: [4, 5] }] })
    const result = await service.run({ ...args, lines: session.lines, revision: session.revision, targetIds: ['line-2'], secondPass: true })
    expect(result.run.windows).toEqual([{ start: 1, end: 11 }])
    expect(result.candidates[1]).toMatchObject({ status: 'matched', start: 5, end: 6 })
    expect(result.candidates[0].status).toBe('protected'); expect(result.candidates[2].status).toBe('protected')
  })

  it('retires cancellation immediately during slow resampling and allows a new run', async () => {
    const pending = deferred(), next = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(prepared)
    const { service, args, client } = fixture({ prepareWindow: next }), controller = new AbortController()
    const old = service.run({ ...args, signal: controller.signal }); const oldResult = old.catch(error => error)
    controller.abort()
    const fresh = await service.run(args)
    pending.resolve(await prepared(args.buffer, { start: 0, end: 5 }))
    expect((await oldResult).name).toBe('AbortError')
    expect(fresh.candidates[0].status).toBe('matched'); expect(client.transcribe).toHaveBeenCalledTimes(1)
  })

  it('dispose allows immediate retry and ignores the retiring task completion', async () => {
    const pending = deferred(), next = vi.fn().mockImplementationOnce(() => pending.promise).mockImplementation(prepared)
    const { service, args } = fixture({ prepareWindow: next })
    const oldResult = service.run(args).catch(error => error)
    service.dispose()
    const fresh = await service.run(args)
    pending.resolve(await prepared(args.buffer, { start: 0, end: 5 }))
    expect((await oldResult).name).toBe('AbortError'); expect(fresh.candidates[0].status).toBe('matched')
  })

  it('keeps a genuine recognition error fail-closed with unchanged lyrics', async () => {
    const { service, args, client } = fixture(), before = JSON.stringify(args.lines)
    client.transcribe.mockRejectedValue(new Error('model output unsupported'))
    await expect(service.run(args)).rejects.toThrow('unsupported')
    expect(JSON.stringify(args.lines)).toBe(before)
  })

  it('a failed cache deletion does not poison the next approved client', async () => {
    const { service, args, client, factory } = fixture()
    client.clearCache.mockRejectedValueOnce(new Error('storage blocked'))
    await expect(service.clearCache()).rejects.toThrow('storage blocked')
    expect(client.dispose).toHaveBeenCalledTimes(1)
    await service.run(args)
    expect(factory.mock.calls.map(call => call[0].modelSourceApproved)).toEqual([false, true])
  })

  it('does not let analysis race a cache deletion', async () => {
    const { service, args, client } = fixture(), pending = deferred()
    client.clearCache.mockReturnValue(pending.promise)
    const deletion = service.clearCache()
    await expect(service.run(args)).rejects.toThrow('刪除模型')
    pending.resolve({ deleted: true }); await deletion
    expect((await service.run(args)).candidates[0].status).toBe('matched')
  })
})
