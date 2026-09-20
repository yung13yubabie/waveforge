import { it, expect } from 'vitest'
import { AudioEngine } from '../../src/js/audio/engine.js'
import { buildProcessingGraph } from '../../src/js/audio/processing-graph.js'

it('all numeric controls can be changed before an audio file is loaded', () => {
  const e = new AudioEngine()
  expect(() => {
    e.setHPFreq(127); e.setLPFreq(12000); e.setMBCBandThresh(0, -20)
    e.setMBCBandRatio(0, 2); e.setCompMakeup(3); e.setLimCeiling(-2); e.setLimRelease(0.2)
    e.setModuleBypassed('hplp', true)
  }).not.toThrow()
})

it('monitor gain never enters serialized master state', () => {
  const e = new AudioEngine(), before = e.serialize()
  e.setMonitorGain(0.1)
  expect(e.serialize()).toEqual(before)
})

it('migrates legacy compressor presets into canonical arrays', () => {
  const e = new AudioEngine()
  e.restore({ version: 1, params: { compThreshold: -18, compRatio: 3, masterVol: 0.5 } })
  const state = e.serialize()
  expect(state.params.mbcThresh).toEqual([-18, -18, -18])
  expect(state.params.mbcRatio).toEqual([3, 3, 3])
  expect(state.params.compThreshold).toBeUndefined()
  expect(state.params.compRatio).toBeUndefined()
  expect(state.params.masterVol).toBeUndefined()
  expect(state.params.masterOutputGainDb).toBeCloseTo(-6.0206)
})

it('export graph has no analyser, bypass or monitor nodes', () => {
  const e = new AudioEngine(); e.ctx = new OfflineAudioContext(2, 128, 48000)
  buildProcessingGraph(e, { metering: false })
  expect(e.nodes.bypassGain).toBeNull()
  expect(e.nodes.monitorGain).toBeNull()
  expect(e.analyser).toBeNull()
  expect(e._corrL).toBeNull()
})

it('limiter re-enable restores edits made while bypassed', async () => {
  const e = new AudioEngine(); await e.init()
  e.setModuleBypassed('limiter', true)
  e.setLimInput(6); e.setLimCeiling(-3); e.setLimRelease(0.3)
  e.setModuleBypassed('limiter', false)
  expect(e.nodes.lim.threshold.setTargetAtTime.mock.calls.at(-1)[0]).toBe(-3)
  expect(e.nodes.lim.release.setTargetAtTime.mock.calls.at(-1)[0]).toBe(0.3)
  expect(e.nodes.limInput.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(10 ** (6 / 20))
})

it('original comparison bypasses master gain and uses a compensated monitor bus', async () => {
  const e = new AudioEngine(); await e.init()
  expect(e.nodes.bypassGain.connect).not.toHaveBeenCalledWith(e.nodes.outputGain)
  expect(e.nodes.abDelay.delayTime.value).toBeCloseTo(0.012)
  e.setModuleBypassed('comp', true)
  expect(e.nodes.abDelay.delayTime.setValueAtTime.mock.calls.at(-1)[0]).toBeCloseTo(0.006)
})

it('replacement commit stops any old playback restarted during decode', async () => {
  const e = new AudioEngine(); await e.init()
  e.buffer = e.ctx.createBuffer(2, 48000, 48000); e.duration = 1
  let enter, finish
  const entered = new Promise(resolve => { enter = resolve })
  const decoded = new Promise(resolve => { finish = resolve })
  e.ctx.decodeAudioData = () => { enter(); return decoded }
  const loading = e.loadFile(new ArrayBuffer(8))
  await entered
  await e.play()
  const oldSource = e.source
  finish(e.ctx.createBuffer(2, 24000, 48000))
  await loading
  expect(oldSource.stop).toHaveBeenCalled()
  expect(e.isPlaying).toBe(false)
  expect(e.duration).toBe(0.5)
})
