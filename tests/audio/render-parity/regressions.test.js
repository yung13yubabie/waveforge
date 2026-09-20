import { it, expect } from 'vitest'
import { AudioEngine } from '../../../src/js/audio/engine.js'
import { renderMasterChain } from '../../../src/js/audio/render-chain.js'

it('compressor bypass removes makeup and selects the dry route even after Mix edits', async () => {
  const e = new AudioEngine(); await e.init()
  e.setCompMakeup(12); e.setModuleBypassed('comp', true); e.setMBCMix(75)
  expect(e.nodes.makeupGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.01)
  expect(e.nodes.mbcWetGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 0, 0.01)
  expect(e.nodes.mbcDryGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.01)
  e.setModuleBypassed('comp', false)
  expect(e.nodes.makeupGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(10 ** (12 / 20), 0, 0.01)
  expect(e.nodes.mbcWetGain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.75, 0, 0.01)
})

it('restores threshold edits made while compression was bypassed', async () => {
  const e = new AudioEngine(); await e.init()
  e.setModuleBypassed('comp', true)
  e.setMBCBandThresh(0, -42)
  e.setModuleBypassed('comp', false)
  expect(e.nodes.compBands[0].threshold.setTargetAtTime).toHaveBeenLastCalledWith(-42, 0, 0.01)
})

it('refuses export when an enabled dynamics module is unavailable', async () => {
  const e = new AudioEngine(); await e.init(); e.dynamicsAvailable = false
  await expect(renderMasterChain({ engine: e, sourceBuffer: e.ctx.createBuffer(2, 480, 48000),
    params: e.params, bypassed: { ...e.bypassed, dyneq: false }, sampleRate: 48000,
  })).rejects.toThrow(/Dynamic EQ/)
})
