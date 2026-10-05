import { describe, it, expect, vi } from 'vitest'
import { createPitchSourcePreview } from '../../src/js/pitch/source-preview.js'
const buffer = { duration: 120, getChannelData() {} }
function setup(resume = () => Promise.resolve()) {
  const nodes = [], contexts = []
  class Context {
    constructor() { this.state = 'running'; this.currentTime = 2; this.destination = {}; contexts.push(this) }
    resume() { return resume() }
    close() { this.state = 'closed'; return Promise.resolve() }
    createGain() { return { gain: { setValueAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() } }
    createBufferSource() { const source = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() }; nodes.push(source); return source }
  }
  return { preview: createPitchSourcePreview({ AudioContextClass: Context }), nodes, contexts }
}
describe('original pitch audition', () => {
  it('plays exact source range quietly without modifying it', async () => {
    const { preview, nodes, contexts } = setup()
    expect(await preview.play(buffer, { start: 10, end: 20 })).toEqual({ start: 10, end: 20, gain: 0.2, processed: false })
    expect(nodes[0].buffer).toBe(buffer); expect(nodes[0].start).toHaveBeenCalledWith(0, 10, 10)
    contexts[0].currentTime = 5; expect(preview.currentTime).toBe(13)
    nodes[0].onended(); expect(preview.playing).toBe(false); expect(nodes[0].disconnect).toHaveBeenCalled()
  })
  it('signals natural end once but never signals an intentional stop as completion', async () => {
    const { preview, nodes } = setup(); const onEnded = vi.fn()
    await preview.play(buffer, { start: 4, end: 6, onEnded }); const ended = nodes[0].onended
    ended(); ended(); expect(onEnded).toHaveBeenCalledExactlyOnceWith({ start: 4, end: 6 })
    await preview.play(buffer, { end: 1, onEnded }); preview.stop(); expect(onEnded).toHaveBeenCalledTimes(1)
  })
  it('a delayed resume cannot play after stop', async () => {
    let release; const { preview, nodes } = setup(() => new Promise(resolve => { release = resolve }))
    const pending = preview.play(buffer, { end: 1 }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    preview.stop(); await rejected; expect(nodes).toHaveLength(0); release()
  })
  it('caller cancellation retires pending playback without a late source', async () => {
    let release; const { preview, nodes } = setup(() => new Promise(resolve => { release = resolve })); const controller = new AbortController()
    const pending = preview.play(buffer, { end: 1, signal: controller.signal }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejected; expect(nodes).toHaveLength(0); release()
  })
  it('new playback stops the previous source; old callback cannot stop the new one', async () => {
    const { preview, nodes } = setup(); await preview.play(buffer, { end: 1 }); const oldEnd = nodes[0].onended
    await preview.play(buffer, { start: 2, end: 3 }); oldEnd()
    expect(nodes[0].stop).toHaveBeenCalled(); expect(nodes[1].stop).not.toHaveBeenCalled(); expect(preview.playing).toBe(true)
    preview.dispose(); expect(nodes[1].stop).toHaveBeenCalled(); await expect(preview.play(buffer, { end: 1 })).rejects.toThrow('已關閉')
  })
  it.each([[-1, 1], [2, 1], [0, 61], [120, 121], [0, NaN]])('rejects invalid range %s–%s without creating audio', async (start, end) => {
    const { preview, contexts } = setup(); await expect(preview.play(buffer, { start, end })).rejects.toThrow(); expect(contexts).toHaveLength(0)
  })
  it('rejects a stale source guard before starting after resume', async () => {
    let current = true, release; const { preview, nodes } = setup(() => new Promise(resolve => { release = resolve }))
    const pending = preview.play(buffer, { end: 1, isCurrent: () => current }); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    current = false; release(); await rejected; expect(nodes).toHaveLength(0)
  })
  it('times out a suspended resume and leaves no source behind', async () => {
    vi.useFakeTimers()
    try {
      const { preview, nodes } = setup(() => new Promise(() => {}))
      const pending = preview.play(buffer, { end: 1 }); const rejected = expect(pending).rejects.toThrow('逾時')
      await vi.advanceTimersByTimeAsync(10000); await rejected
      expect(nodes).toHaveLength(0); preview.dispose()
    } finally { vi.useRealTimers() }
  })
  it('does not allow an unbounded/loud audition gain', () => { expect(() => createPitchSourcePreview({ gain: 1 })).toThrow() })
})
