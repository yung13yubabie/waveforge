import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AudioEngine } from '../../src/js/audio/engine.js'

// AudioWorklet.addModule is mocked via global MockAudioContext in setup.js
vi.mock('../../src/js/audio/lufs-worklet.js?url', () => ({ default: 'mock-worklet-url' }))

describe('AudioEngine', () => {
  let engine

  beforeEach(() => {
    engine = new AudioEngine()
  })

  describe('init()', () => {
    it('creates AudioContext on first call', async () => {
      await engine.init()
      expect(engine.ctx).toBeTruthy()
    })

    it('does not recreate context on second call', async () => {
      await engine.init()
      const ctx1 = engine.ctx
      await engine.init()
      expect(engine.ctx).toBe(ctx1)
    })
  })

  describe('loadFile()', () => {
    it('decodes ArrayBuffer and sets duration', async () => {
      const buf = new ArrayBuffer(1024)
      await engine.loadFile(buf)
      expect(engine.buffer).toBeTruthy()
      expect(engine.duration).toBeGreaterThanOrEqual(0)
    })

    it('resets pauseOffset to 0 on new file load', async () => {
      engine.pauseOffset = 5.0
      await engine.loadFile(new ArrayBuffer(1024))
      expect(engine.pauseOffset).toBe(0)
    })

    it('stops existing playback before loading new file', async () => {
      await engine.init()
      engine.isPlaying = true
      const stopSpy = vi.spyOn(engine, 'stop')
      await engine.loadFile(new ArrayBuffer(1024))
      expect(stopSpy).toHaveBeenCalled()
    })
  })

  describe('play() / pause()', () => {
    beforeEach(async () => {
      await engine.loadFile(new ArrayBuffer(1024))
    })

    it('sets isPlaying to true on play()', () => {
      engine.play()
      expect(engine.isPlaying).toBe(true)
    })

    it('sets isPlaying to false on pause()', () => {
      engine.play()
      engine.pause()
      expect(engine.isPlaying).toBe(false)
    })

    it('records pauseOffset correctly on pause', () => {
      engine.play()
      // Simulate some time passing by manipulating startTime
      engine.startTime = engine.ctx.currentTime - 3.5
      engine.pause()
      expect(engine.pauseOffset).toBeCloseTo(3.5, 0)
    })

    it('does not double-play if already playing', () => {
      engine.play()
      const source1 = engine.source
      engine.play()
      expect(engine.source).toBe(source1)
    })
  })

  describe('seekTo()', () => {
    beforeEach(async () => {
      await engine.loadFile(new ArrayBuffer(1024))
    })

    it('clamps seek fraction between 0 and 1', () => {
      engine.seekTo(0.5)
      // duration is 1s in mock, so offset = 0.5
      expect(engine.pauseOffset).toBeCloseTo(0.5, 1)
    })

    it('resumes play after seek if was playing', () => {
      engine.play()
      engine.seekTo(0.25)
      expect(engine.isPlaying).toBe(true)
    })
  })

  describe('A/B mode', () => {
    beforeEach(async () => {
      await engine.init()
    })

    it('setABMode A reduces processedGain', () => {
      engine.setABMode('A')
      expect(engine.abMode).toBe('A')
    })

    it('setABMode B reduces bypassGain', () => {
      engine.setABMode('B')
      expect(engine.abMode).toBe('B')
    })

    it('does not throw when ctx is null', () => {
      const e2 = new AudioEngine()
      expect(() => e2.setABMode('A')).not.toThrow()
    })

    // Regression: A mode used to set bypassGain to masterVol, but outputGain
    // downstream applies masterVol again → dry path was double-attenuated,
    // biasing every A/B comparison quieter on the dry side.
    it('A mode sets bypassGain to 1, not masterVol (no double volume)', () => {
      engine.setMasterVolume(0.5)
      engine.setABMode('A')
      const call = engine.nodes.bypassGain.gain.setTargetAtTime.mock.calls.at(-1)
      expect(call[0]).toBe(1)
    })

    // Regression: 原曲與處理後一併播放 — exactly ONE path may be audible.
    // (The other half of that bug was WaveSurfer playing unmuted in main.js.)
    it('A/B is exclusive: the other path is always driven to 0', () => {
      const lastTarget = node => node.gain.setTargetAtTime.mock.calls.at(-1)[0]

      engine.setABMode('A')
      expect(lastTarget(engine.nodes.processedGain)).toBe(0)
      expect(lastTarget(engine.nodes.bypassGain)).toBe(1)

      engine.setABMode('B')
      expect(lastTarget(engine.nodes.bypassGain)).toBe(0)
      expect(lastTarget(engine.nodes.processedGain)).toBe(1)
    })

    it('graph starts with only the processed path audible (matches B default)', () => {
      expect(engine.nodes.bypassGain.gain.value).toBe(0)
      expect(engine.nodes.processedGain.gain.value).toBe(1)
    })
  })

  describe('play() race conditions (regression)', () => {
    beforeEach(async () => {
      await engine.init()
      engine.buffer = { duration: 10 }
      engine.duration = 10
    })

    it('two concurrent play() calls during suspended resume create only one source', async () => {
      // Simulate a slow ctx.resume(): each call gets its own pending promise
      const resumeResolvers = []
      engine.ctx.state = 'suspended'
      engine.ctx.resume = vi.fn(() => new Promise(r => resumeResolvers.push(r)))

      const created = []
      const origCreate = engine.ctx.createBufferSource.bind(engine.ctx)
      engine.ctx.createBufferSource = () => { const s = origCreate(); created.push(s); return s }

      const p1 = engine.play()
      const p2 = engine.play()
      engine.ctx.state = 'running'
      resumeResolvers.forEach(r => r())
      await Promise.all([p1, p2])

      expect(created.length).toBe(1)
      expect(engine.isPlaying).toBe(true)
    })

    // Regression: 拖拉進度條後進度歸零凍結 + 再按播放出現雙重音源。
    // A source replaced by seek fires its onended LATE (async event dispatch),
    // after the new source is already playing — it must not reset engine state.
    it('stale onended from a source replaced by seek must not reset state', async () => {
      await engine.play()
      const oldSource = engine.source
      engine.seekTo(0.5)                  // stop() + play() → new source
      expect(engine.isPlaying).toBe(true)

      oldSource.onended?.()               // late dispatch from the REPLACED source

      expect(engine.isPlaying).toBe(true)       // was knocked to false pre-fix
      expect(engine.pauseOffset).not.toBe(0)    // was wiped to 0 pre-fix
    })

    it('stale onended must not fire the onEnded callback (play button reset)', async () => {
      const onEnded = vi.fn()
      engine.onEnded(onEnded)
      await engine.play()
      const oldSource = engine.source
      engine.seekTo(0.5)
      oldSource.onended?.()
      expect(onEnded).not.toHaveBeenCalled()
    })

    it('NATURAL end of the current source still resets state and notifies', async () => {
      const onEnded = vi.fn()
      engine.onEnded(onEnded)
      await engine.play()
      engine.source.onended?.()           // current source ends naturally
      expect(engine.isPlaying).toBe(false)
      expect(onEnded).toHaveBeenCalledTimes(1)
    })

    it('onended after pause() must not clobber the saved pauseOffset', async () => {
      await engine.play()
      const src = engine.source
      engine.pauseOffset = 3.5            // pretend we paused mid-track
      engine.isPlaying = false            // pause() ordering: flag first, then stop
      src.onended?.()
      expect(engine.pauseOffset).toBe(3.5)
    })

    it('stop() during the resume gap aborts the pending play()', async () => {
      let resolveResume
      engine.ctx.state = 'suspended'
      engine.ctx.resume = vi.fn(() => new Promise(r => { resolveResume = r }))

      const p = engine.play()
      engine.stop()                 // user stops while resume is in flight
      engine.ctx.state = 'running'
      resolveResume()
      await p

      expect(engine.isPlaying).toBe(false)
      expect(engine.source).toBe(null)
    })
  })

  describe('applyPreset limiter/saturator params (regression)', () => {
    beforeEach(async () => { await engine.init() })

    it('applies limInput, satDrive and satMix from preset', () => {
      engine.applyPreset({ limInput: 3, satDrive: 0.7, satMix: 0.4 })
      expect(engine.params.limInput).toBe(3)
      expect(engine.params.satDrive).toBe(0.7)
      expect(engine.params.satMix).toBe(0.4)
    })
  })

  // ── Phase 6: chain snapshot / restore (album per-track state, preset save) ──
  describe('serialize / restore', () => {
    beforeEach(async () => { await engine.init() })

    it('serialize returns a JSON-safe snapshot with version, params, bypassed, abMode', () => {
      const snap = engine.serialize()
      expect(snap.version).toBeGreaterThanOrEqual(1)
      expect(snap.params).toBeDefined()
      expect(snap.bypassed).toBeDefined()
      expect(snap.abMode).toBeDefined()
      // must survive JSON round-trip (it's persisted / per-track stored)
      expect(() => JSON.parse(JSON.stringify(snap))).not.toThrow()
    })

    it('snapshot is a deep copy — later engine changes do not mutate it', () => {
      const snap = engine.serialize()
      engine.setEQBand(0, 9)
      engine.params.eqGains[1] = 5
      expect(snap.params.eqGains[0]).toBe(0)
      expect(snap.params.eqGains[1]).toBe(0)
    })

    it('round-trips a complex state: change → snapshot → scramble → restore', () => {
      engine.setEQBand(3, 4.5)
      engine.setHPFreq(80)
      engine.setMBCBandThresh(2, -30)
      engine.setMBCBandRatio(0, 6)
      engine.setMBCXover(0, 180)
      engine.setSatDrive(0.6)
      engine.setMSWidth(140)
      engine.setMasterVolume(0.5)
      engine.setModuleBypassed('sat', false)
      engine.setABMode('A')
      const snap = engine.serialize()

      // scramble everything
      engine.setEQBand(3, -6)
      engine.setHPFreq(20)
      engine.setMBCBandThresh(2, -10)
      engine.setMBCBandRatio(0, 2)
      engine.setMBCXover(0, 400)
      engine.setSatDrive(0.1)
      engine.setMSWidth(100)
      engine.setMasterVolume(1)
      engine.setModuleBypassed('sat', true)
      engine.setABMode('B')

      engine.restore(snap)
      expect(engine.params.eqGains[3]).toBe(4.5)
      expect(engine.params.hpFreq).toBe(80)
      expect(engine.params.mbcThresh[2]).toBe(-30)
      expect(engine.params.mbcRatio[0]).toBe(6)
      expect(engine.params.mbcXover1).toBe(180)
      expect(engine.params.satDrive).toBe(0.6)
      expect(engine.params.msWidth).toBe(140)
      expect(engine.params.masterVol).toBe(0.5)
      expect(engine.bypassed.sat).toBe(false)
      expect(engine.abMode).toBe('A')
    })

    it('restore pushes EQ gains to the actual band nodes', () => {
      const snap = engine.serialize()
      snap.params.eqGains[5] = 7
      engine.restore(snap)
      // band 5 gain node received the restored value (not bypassed)
      const call = engine.eqBands[5].gain.setTargetAtTime.mock.calls.at(-1)
      expect(call[0]).toBe(7)
    })

    it('restore re-applies module bypass states', () => {
      const snap = engine.serialize()
      snap.bypassed.eq = true
      engine.restore(snap)
      expect(engine.bypassed.eq).toBe(true)
    })

    it('restore tolerates a partial snapshot without throwing', () => {
      expect(() => engine.restore({ version: 1, params: { masterVol: 0.7 } })).not.toThrow()
      expect(engine.params.masterVol).toBe(0.7)
    })

    it('restore(null) is a safe no-op', () => {
      expect(() => engine.restore(null)).not.toThrow()
    })
  })

  // ── Phase 5: True multiband compressor ─────────────────
  describe('Multiband compressor', () => {
    beforeEach(async () => { await engine.init() })

    it('builds 3 independent band compressors', () => {
      expect(engine.nodes.compBands).toHaveLength(3)
      expect(engine.nodes.mbcIn).toBeDefined()
      expect(engine.nodes.mbcSum).toBeDefined()
      expect(engine.nodes.lp1).toBeDefined()
      expect(engine.nodes.lp2).toBeDefined()
    })

    it('crossover filters default to the param frequencies', () => {
      expect(engine.nodes.lp1.frequency.value).toBe(250)
      expect(engine.nodes.lp2.frequency.value).toBe(2500)
    })

    it('per-band threshold/ratio setters update only that band', () => {
      engine.setMBCBandThresh(0, -30)
      engine.setMBCBandRatio(2, 8)
      expect(engine.params.mbcThresh[0]).toBe(-30)
      expect(engine.params.mbcRatio[2]).toBe(8)
      expect(engine.params.mbcThresh[1]).toBe(-24) // mid untouched
    })

    it('crossover setters update params and nodes', () => {
      engine.setMBCXover(0, 180)
      engine.setMBCXover(1, 3200)
      expect(engine.params.mbcXover1).toBe(180)
      expect(engine.params.mbcXover2).toBe(3200)
    })

    it('global setCompThreshold/Ratio seed ALL bands (preset back-compat)', () => {
      engine.setCompThreshold(-18)
      engine.setCompRatio(6)
      expect(engine.params.mbcThresh).toEqual([-18, -18, -18])
      expect(engine.params.mbcRatio).toEqual([6, 6, 6])
    })

    it('bypass sets every band ratio to 1 (pass-through reconstruction)', () => {
      engine.setMBCBandRatio(0, 5); engine.setMBCBandRatio(1, 5); engine.setMBCBandRatio(2, 5)
      engine.setModuleBypassed('comp', true)
      engine.nodes.compBands.forEach(c => {
        expect(c.ratio.setTargetAtTime.mock.calls.at(-1)[0]).toBe(1)
      })
    })

    it('compReduction() returns the worst (most negative) band reduction', () => {
      engine.nodes.compBands[0].reduction = -2
      engine.nodes.compBands[1].reduction = -7
      engine.nodes.compBands[2].reduction = -1
      expect(engine.compReduction()).toBe(-7)
    })

    it('applyPreset with global comp params drives all bands', () => {
      engine.applyPreset({ compThreshold: -20, compRatio: 3 })
      expect(engine.params.mbcThresh).toEqual([-20, -20, -20])
      expect(engine.params.mbcRatio).toEqual([3, 3, 3])
    })

    it('setMBCMix clamps to [0,100] and sets wet/dry gains', () => {
      engine.setMBCMix(50)
      expect(engine.params.mbcMix).toBe(50)
      expect(engine.nodes.mbcWetGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(0.5)
      expect(engine.nodes.mbcDryGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(0.5)
    })

    it('setMBCMix(100) = fully wet (default), setMBCMix(0) = fully dry', () => {
      engine.setMBCMix(100)
      expect(engine.nodes.mbcWetGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(1)
      expect(engine.nodes.mbcDryGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(0)
      engine.setMBCMix(0)
      expect(engine.nodes.mbcWetGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(0)
      expect(engine.nodes.mbcDryGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBeCloseTo(1)
    })

    it('parallel mix nodes exist in this.nodes', () => {
      expect(engine.nodes.mbcDryTap).toBeDefined()
      expect(engine.nodes.mbcWetGain).toBeDefined()
      expect(engine.nodes.mbcDryGain).toBeDefined()
      expect(engine.nodes.mbcParallelOut).toBeDefined()
    })
  })

  // ── Phase 2: Dynamic EQ / M/S EQ / De-esser ─────────────
  describe('Phase-2 modules', () => {
    beforeEach(async () => { await engine.init() })

    it('all three start bypassed (off by default)', () => {
      expect(engine.bypassed.dyneq).toBe(true)
      expect(engine.bypassed.ms).toBe(true)
      expect(engine.bypassed.deesser).toBe(true)
    })

    it('builds M/S matrix nodes', () => {
      expect(engine.nodes.msWet).toBeDefined()
      expect(engine.nodes.msDry).toBeDefined()
      expect(engine.nodes.msMid).toBeDefined()
      expect(engine.nodes.msSide).toBeDefined()
      // M/S starts bypassed: dry full, wet muted
      expect(engine.nodes.msDry.gain.value).toBe(1)
      expect(engine.nodes.msWet.gain.value).toBe(0)
    })

    it('builds worklet nodes when the dynamics worklet loads', () => {
      expect(engine.dynamicsAvailable).toBe(true)
      expect(engine.nodes.deesser).toBeDefined()
      expect(engine.nodes.dyneq).toBeDefined()
    })

    // At neutral settings the M/S wet path must equal unity, so toggling the
    // module bypass causes NO level jump (the only "jump" with non-neutral
    // gains is the intended effect, not a defect).
    it('M/S wet path is unity at neutral settings (width 100, mid 0dB, side 0dB)', () => {
      // defaults are width 100, msMidGain 0, msSideGain 0
      expect(engine.nodes.msMid.gain.value).toBeCloseTo(1, 6)   // 10^(0/20)
      expect(engine.nodes.msSide.gain.value).toBeCloseTo(1, 6)  // (100/100)·10^(0/20)
      // encode/decode split gains form an exact M/S identity (see _buildGraph)
      expect(engine.nodes.msSideInv.gain.value).toBe(-1)
    })

    it('forwards worklet GR telemetry to the onGR callback', () => {
      const seen = []
      engine.onGR((mod, db) => seen.push([mod, db]))
      // simulate the worklets posting gain-reduction messages
      engine.nodes.dyneq.port.onmessage({ data: { type: 'gr', value: -3.2 } })
      engine.nodes.deesser.port.onmessage({ data: { type: 'gr', value: -1.1 } })
      // a non-gr message must be ignored
      engine.nodes.dyneq.port.onmessage({ data: { type: 'other', value: 99 } })
      expect(seen).toEqual([['dyneq', -3.2], ['deesser', -1.1]])
    })

    it('setMSWidth / setMSMidGain / setMSSideGain update params and live gains', () => {
      engine.setMSWidth(150)
      engine.setMSMidGain(3)
      engine.setMSSideGain(-2)
      expect(engine.params.msWidth).toBe(150)
      expect(engine.params.msMidGain).toBe(3)
      expect(engine.params.msSideGain).toBe(-2)
    })

    it('setDynEQ setters update params and worklet AudioParams', () => {
      engine.setDynEQFreq(3000)
      engine.setDynEQThresh(-18)
      engine.setDynEQRatio(5)
      expect(engine.params.dyneqFreq).toBe(3000)
      expect(engine.params.dyneqThresh).toBe(-18)
      expect(engine.params.dyneqRatio).toBe(5)
    })

    it('setDeessFreq / setDeessThresh update params', () => {
      engine.setDeessFreq(7000)
      engine.setDeessThresh(-25)
      expect(engine.params.deessFreq).toBe(7000)
      expect(engine.params.deessThresh).toBe(-25)
    })

    it('setModuleBypassed("ms") crossfades wet/dry', () => {
      engine.setModuleBypassed('ms', false)
      const wetCall = engine.nodes.msWet.gain.setTargetAtTime.mock.calls.at(-1)
      const dryCall = engine.nodes.msDry.gain.setTargetAtTime.mock.calls.at(-1)
      expect(wetCall[0]).toBe(1)
      expect(dryCall[0]).toBe(0)
    })

    it('setModuleBypassed("deesser"/"dyneq") drives the worklet bypass param', () => {
      engine.setModuleBypassed('deesser', false)
      expect(engine.nodes.deesser.parameters.get('bypass').setValueAtTime.mock.calls.at(-1)[0]).toBe(0)
      engine.setModuleBypassed('dyneq', false)
      expect(engine.nodes.dyneq.parameters.get('bypass').setValueAtTime.mock.calls.at(-1)[0]).toBe(0)
    })

    it('phase-2 setters never throw before init() (no ctx yet)', () => {
      const e2 = new AudioEngine()
      expect(() => {
        e2.setMSWidth(120); e2.setMSMidGain(1); e2.setMSSideGain(1)
        e2.setDynEQFreq(1000); e2.setDynEQThresh(-20); e2.setDynEQRatio(2)
        e2.setDeessFreq(5000); e2.setDeessThresh(-20)
      }).not.toThrow()
    })

    it('applyPreset applies phase-2 fields', () => {
      engine.applyPreset({ msWidth: 130, dyneqThresh: -20, deessThresh: -28 })
      expect(engine.params.msWidth).toBe(130)
      expect(engine.params.dyneqThresh).toBe(-20)
      expect(engine.params.deessThresh).toBe(-28)
    })

    it('degrades gracefully when the dynamics worklet fails to load', async () => {
      const e2 = new AudioEngine()
      let call = 0
      global.AudioContext = class extends (Object.getPrototypeOf(engine.ctx).constructor) {
        constructor() {
          super()
          this.audioWorklet = {
            addModule: vi.fn(url =>
              // first module (lufs) loads, second (dynamics) fails
              ++call === 1 ? Promise.resolve() : Promise.reject(new Error('CSP blocked'))),
          }
        }
      }
      try {
        await e2.init()
        expect(e2.dynamicsAvailable).toBe(false)
        expect(e2.ctx).not.toBe(null)            // engine still usable
        expect(e2.nodes.deesser).toBeUndefined() // chain built without worklet nodes
        expect(() => e2.setDeessFreq(5000)).not.toThrow()
      } finally {
        global.AudioContext = Object.getPrototypeOf(engine.ctx).constructor
      }
    })
  })

  describe('parameter setters', () => {
    beforeEach(async () => { await engine.init() })

    it('setHPFreq updates params.hpFreq', () => {
      engine.setHPFreq(80)
      expect(engine.params.hpFreq).toBe(80)
    })

    it('setLPFreq updates params.lpFreq', () => {
      engine.setLPFreq(18000)
      expect(engine.params.lpFreq).toBe(18000)
    })

    it('setEQBand updates params.eqGains at correct index', () => {
      engine.setEQBand(3, -6)
      expect(engine.params.eqGains[3]).toBe(-6)
    })

    it('setCompThreshold updates params', () => {
      engine.setCompThreshold(-18)
      expect(engine.params.compThreshold).toBe(-18)
    })

    it('setMasterVolume updates params', () => {
      engine.setMasterVolume(0.5)
      expect(engine.params.masterVol).toBe(0.5)
    })

    it('setLimCeiling updates params', () => {
      engine.setLimCeiling(-2.0)
      expect(engine.params.limCeiling).toBe(-2.0)
    })
  })

  describe('applyPreset()', () => {
    beforeEach(async () => { await engine.init() })

    it('applies all eq gains from preset', () => {
      const gains = [-2,-1,0,1,2,3,2,1,0,-1]
      engine.applyPreset({ eqGains: gains })
      expect(engine.params.eqGains).toEqual(gains)
    })

    it('applies limCeiling from preset', () => {
      engine.applyPreset({ limCeiling: -3.0 })
      expect(engine.params.limCeiling).toBe(-3.0)
    })

    it('does not crash on null preset', () => {
      expect(() => engine.applyPreset(null)).not.toThrow()
    })

    it('does not crash on empty preset', () => {
      expect(() => engine.applyPreset({})).not.toThrow()
    })
  })

  describe('setModuleBypassed()', () => {
    beforeEach(async () => { await engine.init() })

    it('records bypass state', () => {
      engine.setModuleBypassed('eq', true)
      expect(engine.bypassed.eq).toBe(true)
    })

    it('can re-enable a bypassed module', () => {
      engine.setModuleBypassed('comp', true)
      engine.setModuleBypassed('comp', false)
      expect(engine.bypassed.comp).toBe(false)
    })
  })

  describe('getEQResponse()', () => {
    beforeEach(async () => { await engine.init() })

    it('returns Float32Array of same length as input freqs', () => {
      const freqs = new Float32Array([100, 1000, 10000])
      const result = engine.getEQResponse(freqs)
      expect(result).toHaveLength(3)
    })

    it('returns null if eqBands not initialised', () => {
      const e2 = new AudioEngine()
      e2.eqBands = []
      expect(e2.getEQResponse(new Float32Array([1000]))).toBeNull()
    })
  })

  describe('saturator (regression: knobs were dead ends before)', () => {
    beforeEach(async () => { await engine.init() })

    it('setSatDrive updates params and rebuilds shaper curve', () => {
      engine.setSatDrive(0.8)
      expect(engine.params.satDrive).toBe(0.8)
      expect(engine.nodes.shaper.curve).toBeInstanceOf(Float32Array)
    })

    it('setSatMix updates params', () => {
      engine.setSatMix(0.7)
      expect(engine.params.satMix).toBe(0.7)
    })

    it('setSatType regenerates curve for each type', () => {
      engine.setSatType('tube')
      const tubeCurve = engine.nodes.shaper.curve
      engine.setSatType('clip')
      expect(engine.nodes.shaper.curve).not.toBe(tubeCurve)
    })

    it('sat curve is monotect: tanh curve maps -1→~-1 and 1→~1', () => {
      const curve = engine._makeSatCurve(0.5, 'tape')
      expect(curve[0]).toBeLessThan(0)
      expect(curve[curve.length - 1]).toBeGreaterThan(0)
      expect(Math.abs(curve[0])).toBeLessThanOrEqual(1)
      expect(Math.abs(curve[curve.length - 1])).toBeLessThanOrEqual(1)
    })

    it('sat bypass sets wet to 0 via setModuleBypassed', () => {
      engine.setModuleBypassed('sat', false)
      engine.setModuleBypassed('sat', true)
      expect(engine.bypassed.sat).toBe(true)
    })
  })

  describe('setLimInput (regression: knob was dead end before)', () => {
    beforeEach(async () => { await engine.init() })

    it('updates params.limInput', () => {
      engine.setLimInput(6)
      expect(engine.params.limInput).toBe(6)
    })

    it('converts dB to linear gain on the node', () => {
      engine.setLimInput(0)
      const call = engine.nodes.limInput.gain.setTargetAtTime.mock.calls.at(-1)
      expect(call[0]).toBeCloseTo(1.0, 5)  // 0 dB = unity
    })
  })

  describe('seekTo guards (regression: NaN/Infinity seek crashed source.start)', () => {
    beforeEach(async () => { await engine.loadFile(new ArrayBuffer(1024)) })

    it('clamps Infinity fraction to valid range', () => {
      engine.seekTo(Infinity)
      expect(Number.isFinite(engine.pauseOffset)).toBe(true)
    })

    it('clamps NaN fraction to 0', () => {
      engine.seekTo(NaN)
      expect(engine.pauseOffset).toBe(0)
    })

    it('clamps negative fraction to 0', () => {
      engine.seekTo(-5)
      expect(engine.pauseOffset).toBe(0)
    })

    it('clamps fraction above 1 to duration', () => {
      engine.seekTo(99)
      expect(engine.pauseOffset).toBeCloseTo(engine.duration, 5)
    })
  })

  describe('init() failure recovery (regression: failed worklet load poisoned ctx)', () => {
    it('leaves ctx null after addModule failure so retry is possible', async () => {
      const e2 = new AudioEngine()
      // Force addModule to reject once
      const OriginalCtx = global.AudioContext
      global.AudioContext = class extends OriginalCtx {
        constructor(...a) {
          super(...a)
          this.audioWorklet = { addModule: vi.fn().mockRejectedValue(new Error('CSP blocked')) }
        }
      }
      await expect(e2.init()).rejects.toThrow(/AudioWorklet/)
      expect(e2.ctx).toBeNull()
      global.AudioContext = OriginalCtx
      // Retry with working context must now succeed
      await e2.init()
      expect(e2.ctx).toBeTruthy()
    })
  })

  describe('restore() limRelease regression', () => {
    beforeEach(async () => { await engine.init() })

    it('restore() re-applies limRelease to the audio node', () => {
      const snap = engine.serialize()
      snap.params.limRelease = 0.5
      engine.restore(snap)
      expect(engine.params.limRelease).toBe(0.5)
      const call = engine.nodes.lim.release.setTargetAtTime.mock.calls.at(-1)
      expect(call[0]).toBeCloseTo(0.5)
    })
  })

  describe('stop()', () => {
    it('does not throw if called before loadFile', () => {
      expect(() => engine.stop()).not.toThrow()
    })

    it('resets isPlaying and pauseOffset', async () => {
      await engine.loadFile(new ArrayBuffer(1024))
      engine.play()
      engine.stop()
      expect(engine.isPlaying).toBe(false)
      expect(engine.pauseOffset).toBe(0)
    })
  })
})
