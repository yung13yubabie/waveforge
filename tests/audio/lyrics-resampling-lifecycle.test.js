import { describe, it, expect, vi } from 'vitest'
import { createLocalAlignmentService, prepareAlignmentWindow } from '../../src/js/lyrics/alignment-service.js'

// Synthetic PCM and controlled native promises only. Counts below establish
// ownership/allocation bounds, not browser heap retention or model accuracy.
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function audio(duration = .1, sampleRate = 48000) {
  const data = new Float32Array(Math.round(duration * sampleRate)).fill(.1)
  const slice = vi.spyOn(data, 'slice')
  return { duration, sampleRate, numberOfChannels: 1, getChannelData: () => data, slice }
}
function harness() {
  const contexts = [], nodes = [], jobs = []
  let failure = null
  const fail = stage => { if (failure === stage) throw new Error(`native ${stage} failure`) }
  class Context {
    constructor(_channels, length) { fail('constructor'); this.length = length; this.destination = {}; contexts.push(this) }
    createBuffer(_channels, length) {
      fail('createBuffer')
      this.inputFrames = length
      return { copyToChannel: () => fail('copyToChannel') }
    }
    createBufferSource() {
      fail('createBufferSource')
      const node = { buffer: null, connect: vi.fn(() => fail('connect')), start: vi.fn(() => fail('start')), disconnect: vi.fn() }
      nodes.push(node)
      return node
    }
    startRendering() {
      fail('startRendering')
      const job = deferred()
      job.output = { getChannelData: vi.fn(() => new Float32Array(this.length).fill(.1)) }
      jobs.push(job)
      return job.promise
    }
  }
  return { Context, contexts, nodes, jobs, failAt: stage => { failure = stage },
    settle: index => jobs[index].resolve(jobs[index].output),
    drain: async () => { jobs.forEach(job => job.resolve(job.output)); await Promise.allSettled(jobs.map(job => job.promise)) } }
}
function fixture(native, buffer = audio()) {
  const client = { transcribe: vi.fn(async () => ({ chunks: [] })), dispose: vi.fn() }
  const factory = vi.fn(() => client)
  const service = createLocalAlignmentService({ clientFactory: factory,
    prepareWindow: (source, range, options) => prepareAlignmentWindow(source, range, { ...options, OfflineContext: native.Context }) })
  const args = { buffer, source: { hash: 'a'.repeat(64), duration: buffer.duration },
    lines: [{ id: 'line-1', text: 'Hello', sung: true, start: null, end: null }],
    revision: 0, targetIds: ['line-1'], language: 'en', modelSourceApproved: true }
  return { service, args, client, factory }
}
const range = { start: 0, end: .1 }

describe('alignment native resampling resource ownership', () => {
  it('bounds ten same-turn cancel/retry attempts before any extra PCM copy or native allocation', async () => {
    const native = harness(), buffer = audio(20), { service, args, factory } = fixture(native, buffer), calls = []
    try {
      for (let index = 0; index < 10; index++) {
        const controller = new AbortController()
        calls.push(service.run({ ...args, signal: controller.signal }).catch(error => error))
        controller.abort()
      }
      expect(native.contexts).toHaveLength(1)
      expect(native.jobs).toHaveLength(1)
      expect(native.nodes).toHaveLength(1)
      expect(buffer.slice).toHaveBeenCalledTimes(1)
      expect(native.contexts[0].inputFrames).toBe(960000)
      expect(native.nodes[0].disconnect).toHaveBeenCalledTimes(1)
      expect(factory).not.toHaveBeenCalled()
    } finally { await native.drain(); await Promise.all(calls); service.dispose() }
  })

  it('disconnects rejected rendering and releases ownership for a successful retry', async () => {
    const native = harness(), buffer = audio()
    const failed = prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })
    native.jobs[0].reject(new Error('native rendering failure'))
    await expect(failed).rejects.toThrow('native rendering failure')
    expect(native.nodes[0].disconnect).toHaveBeenCalledTimes(1)
    const retry = prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })
    native.settle(1)
    expect((await retry).samples).toHaveLength(1600)
    expect(native.nodes[1].disconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['resolve', 'reject'])('cancels promptly but holds the native slot until late %s', async outcome => {
    const native = harness(), buffer = audio(), controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const cancelled = prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context, signal: controller.signal })
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    try {
      controller.abort()
      await rejected
      expect(native.nodes[0].disconnect).toHaveBeenCalledTimes(1)
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      await expect(prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })).rejects.toThrow('上一段音訊')
      expect(buffer.slice).toHaveBeenCalledTimes(1)
      expect(native.contexts).toHaveLength(1)
      if (outcome === 'resolve') native.settle(0)
      else native.jobs[0].reject(new Error('late native failure'))
      await native.drain()
      expect(native.jobs[0].output.getChannelData).not.toHaveBeenCalled()
      const retry = prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })
      native.settle(1)
      await expect(retry).resolves.toMatchObject({ sampleRate: 16000, duration: .1 })
      expect(native.nodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
    } finally { await native.drain() }
  })

  it.each(['constructor', 'createBuffer', 'copyToChannel', 'createBufferSource', 'connect', 'start', 'startRendering'])(
    'releases ownership and cleans any source after synchronous %s failure', async stage => {
      const native = harness(), buffer = audio()
      native.failAt(stage)
      await expect(prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })).rejects.toThrow(`native ${stage} failure`)
      expect(native.nodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
      native.failAt(null)
      const retry = prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context })
      native.settle(0)
      await expect(retry).resolves.toHaveProperty('samples')
      expect(native.nodes.every(node => node.disconnect.mock.calls.length === 1)).toBe(true)
    },
  )

  it('does not replace a rendering failure when disconnect itself throws', async () => {
    const native = harness(), pending = prepareAlignmentWindow(audio(), range, { OfflineContext: native.Context })
    native.nodes[0].disconnect.mockImplementation(() => { throw new Error('disconnect failed') })
    native.jobs[0].reject(new Error('render failed'))
    await expect(pending).rejects.toThrow('render failed')
    expect(native.nodes[0].disconnect).toHaveBeenCalledTimes(1)
    const retry = prepareAlignmentWindow(audio(), range, { OfflineContext: native.Context })
    native.settle(1)
    await expect(retry).resolves.toHaveProperty('samples')
  })

  it('releases the pre-allocation claim when PCM validation fails', async () => {
    const native = harness(), invalid = audio()
    invalid.getChannelData(0)[0] = NaN
    await expect(prepareAlignmentWindow(invalid, range, { OfflineContext: native.Context })).rejects.toThrow('無效數值')
    expect(native.contexts).toHaveLength(0)
    const retry = prepareAlignmentWindow(audio(), range, { OfflineContext: native.Context })
    native.settle(0)
    await expect(retry).resolves.toHaveProperty('samples')
  })

  it('does not allocate or copy when already cancelled', async () => {
    const native = harness(), buffer = audio(), controller = new AbortController()
    controller.abort()
    await expect(prepareAlignmentWindow(buffer, range, { OfflineContext: native.Context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(buffer.slice).not.toHaveBeenCalled()
    expect(native.contexts).toHaveLength(0)
  })

  it.each(['start', 'startRendering'])('handles cancellation during %s before the abort listener is installed', async stage => {
    const native = harness(), controller = new AbortController()
    class CancellingContext extends native.Context {
      createBufferSource() {
        const node = super.createBufferSource()
        if (stage === 'start') node.start.mockImplementation(() => controller.abort())
        return node
      }
      startRendering() { const promise = super.startRendering(); controller.abort(); return promise }
    }
    const pending = prepareAlignmentWindow(audio(), range, { OfflineContext: CancellingContext, signal: controller.signal })
    try {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      expect(native.nodes[0].disconnect).toHaveBeenCalledTimes(1)
      expect(native.jobs).toHaveLength(stage === 'start' ? 0 : 1)
    } finally { await native.drain() }
    const retry = prepareAlignmentWindow(audio(), range, { OfflineContext: native.Context })
    native.settle(native.jobs.length - 1)
    await expect(retry).resolves.toHaveProperty('samples')
  })

  it.each(['abort', 'dispose'])('keeps a newer 16 kHz service run active after %s and late native completion', async cancel => {
    const native = harness(), { service, args, client, factory } = fixture(native), controller = new AbortController()
    const previous = service.run({ ...args, signal: controller.signal }).catch(error => error)
    const recognition = deferred()
    client.transcribe.mockReturnValue(recognition.promise)
    let newer
    try {
      if (cancel === 'abort') controller.abort()
      else service.dispose()
      expect((await previous).name).toBe('AbortError')
      const another = fixture(native)
      await expect(another.service.run(another.args)).rejects.toThrow('上一段音訊')
      expect(another.args.buffer.slice).not.toHaveBeenCalled()
      expect(another.factory).not.toHaveBeenCalled()
      another.service.dispose()
      newer = service.run({ ...args, buffer: audio(.1, 16000) })
      await vi.waitFor(() => expect(client.transcribe).toHaveBeenCalledTimes(1))
      native.settle(0)
      await native.drain()
      await expect(service.run(args)).rejects.toThrow('已有分析')
      expect(factory).toHaveBeenCalledTimes(1)
      expect(client.dispose).not.toHaveBeenCalled()
      expect(native.jobs[0].output.getChannelData).not.toHaveBeenCalled()
      recognition.resolve({ chunks: [] })
      await expect(newer).resolves.toHaveProperty('candidates')
      const retry = service.run(args)
      native.settle(1)
      await expect(retry).resolves.toHaveProperty('candidates')
    } finally { recognition.resolve({ chunks: [] }); await native.drain(); await newer; service.dispose() }
  })
})
