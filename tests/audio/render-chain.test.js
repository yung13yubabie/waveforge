// Unit-level wiring checks for the shared offline render chain. Real DSP
// correctness is covered by Playwright E2E (export + album render); here we use
// the mock OfflineAudioContext to confirm it wires up and returns a buffer at
// the requested sample rate without throwing across module on/off combinations.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AudioEngine } from '../../src/js/audio/engine.js'
import { renderMasterChain } from '../../src/js/audio/render-chain.js'

vi.mock('../../src/js/audio/lufs-worklet.js?url', () => ({ default: 'mock-lufs-url' }))
vi.mock('../../src/js/audio/dynamics-worklet.js?url', () => ({ default: 'mock-dyn-url' }))

describe('renderMasterChain', () => {
  let engine
  beforeEach(async () => { engine = new AudioEngine(); await engine.init() })

  function srcBuf(sr = 44100, secs = 1) {
    return engine.ctx.createBuffer(2, Math.round(sr * secs), sr)
  }

  it('renders at the requested 44.1kHz sample rate', async () => {
    const snap = engine.serialize()
    const out = await renderMasterChain({
      engine, sourceBuffer: srcBuf(44100), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })
    expect(out.sampleRate).toBe(44100)
    expect(out.numberOfChannels).toBe(2)
  })

  it('renders at 48kHz too (export path)', async () => {
    const snap = engine.serialize()
    const out = await renderMasterChain({
      engine, sourceBuffer: srcBuf(48000), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 48000, dynamicsWorkletUrl: 'mock-dyn-url',
    })
    expect(out.sampleRate).toBe(48000)
  })

  it('does not throw with all optional modules bypassed', async () => {
    const snap = engine.serialize()  // dyneq/ms/deesser/sat start bypassed
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })

  it('does not throw with dyneq + deesser + M/S active', async () => {
    engine.setModuleBypassed('dyneq', false)
    engine.setModuleBypassed('deesser', false)
    engine.setModuleBypassed('ms', false)
    const snap = engine.serialize()
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 44100, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })

  it('accepts a linear-phase magnitude without throwing', async () => {
    const snap = engine.serialize()
    const mag = new Float32Array(4096 / 2 + 1).fill(1)
    await expect(renderMasterChain({
      engine, sourceBuffer: srcBuf(48000), params: snap.params, bypassed: snap.bypassed,
      sampleRate: 48000, linPhaseMag: mag, dynamicsWorkletUrl: 'mock-dyn-url',
    })).resolves.toBeDefined()
  })
})
