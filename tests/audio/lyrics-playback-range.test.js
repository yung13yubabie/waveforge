import { describe, it, expect, vi } from 'vitest'
import { AudioEngine } from '../../src/js/audio/engine.js'

vi.mock('../../src/js/audio/lufs-worklet.js?url', () => ({ default: 'mock-lufs-url' }))
vi.mock('../../src/js/audio/dynamics-worklet.js?url', () => ({ default: 'mock-dyn-url' }))
async function ready() {
  const engine = new AudioEngine(); await engine.init()
  engine.buffer = { duration: 8 }; engine.duration = 8
  return engine
}

describe('sentence loop and full-song loop are independent controls', () => {
  it('does not change the full-song loop setting when auditioning a looping sentence', async () => {
    const engine = await ready(); engine.loop = false
    await engine.playRange(1, 2, true)
    expect(engine.loop).toBe(false)
    expect(engine.source.loop).toBe(true)
    engine.loop = true
    engine.stop(); engine.clearPlaybackRange()
    expect(engine.loop).toBe(true)
  })
  it('keeps sentence loop active when the separate full-song control is changed', async () => {
    const engine = await ready(); await engine.playRange(1, 2, true)
    engine.loop = false
    expect(engine.source.loop).toBe(true)
    engine.startTime = engine.ctx.currentTime - 4.4
    expect(engine.currentTime).toBeCloseTo(1.4)
  })
  it('stops a one-shot sentence at its end even if full-song looping is enabled', async () => {
    const engine = await ready(); engine.loop = true
    await engine.playRange(1, 2, false)
    expect(engine.loop).toBe(true)
    expect(engine.source.loop).toBe(false)
    const ended = vi.fn(); engine.onEnded(ended)
    engine.source.onended()
    expect(engine.isPlaying).toBe(false)
    expect(engine.currentTime).toBe(2)
    expect(ended).toHaveBeenCalledOnce()
  })
})
