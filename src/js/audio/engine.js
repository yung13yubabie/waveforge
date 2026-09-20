import { buildProcessingGraph } from './processing-graph.js'
import lufsWorkletUrl from './lufs-worklet.js?url'
import dynamicsWorkletUrl from './dynamics-worklet.js?url'

export class AudioEngine {
  constructor() {
    this.ctx = null
    this.buffer = null       // decoded AudioBuffer
    this.source = null       // current AudioBufferSourceNode
    this.isPlaying = false
    this.startTime = 0       // ctx.currentTime when play started
    this.pauseOffset = 0     // how far into the track we paused
    this.duration = 0

    // Graph nodes (null until init())
    this.nodes = {}
    this.lufsNode = null     // AudioWorkletNode
    this.analyser = null
    this.eqBands = []        // array of BiquadFilterNode

    // State mirrors (what the UI knobs are set to)
    this.params = {
      hpFreq: 20, lpFreq: 22000,
      eqGains: new Array(10).fill(0),
      compThreshold: -24, compKnee: 30, compRatio: 4,
      compAttack: 0.003, compRelease: 0.25, compMakeup: 0,
      // True multiband compressor: 2 crossovers + per-band [low, mid, high].
      // Global comp params above seed all bands (back-compat with 39 presets).
      mbcXover1: 250, mbcXover2: 2500,
      mbcThresh: [-24, -24, -24], mbcRatio: [4, 4, 4],
      limCeiling: -1, limInput: 0, limRelease: 0.1,
      msWidth: 100, msMidGain: 0, msSideGain: 0,
      deessFreq: 6000, deessThresh: -30,
      dyneqFreq: 2000, dyneqThresh: -24, dyneqRatio: 3,
      satDrive: 0.2, satMix: 0.5, satType: 'tape',
      mbcMix: 100,
      masterVol: 0.8,
    }

    // Module bypass states
    this.bypassed = {
      hplp: false, eq: false, comp: false,
      limiter: false, deesser: true, sat: true, ms: true, dyneq: true,
    }

    // false when the dynamics worklet (deesser/dyneq) failed to load —
    // the chain is then built without those nodes and the UI must stay disabled
    this.dynamicsAvailable = false

    // A/B state: 'A' = dry bypass, 'B' = processed chain
    this.abMode = 'B'

    this._onLufs = null  // callback(m, s, i, tp)
    this._lufsWorkletReady = false
    this._playGen = 0    // invalidates stale play() calls after stop/seek
  }

  async init() {
    if (this.ctx) return
    // 48kHz fixed: decodeAudioData resamples 44.1k sources; export inherits this rate.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    try {
      await ctx.audioWorklet.addModule(lufsWorkletUrl)
    } catch (err) {
      // Don't poison this.ctx — a failed worklet load must allow a clean retry
      await ctx.close().catch(() => {})
      throw new Error(`AudioWorklet 載入失敗（瀏覽器不支援或 CSP 阻擋）：${err.message}`)
    }
    // Dynamics worklet is OPTIONAL: LUFS metering is core, deesser/dyneq are
    // not — on failure the engine still works, those modules stay disabled.
    try {
      await ctx.audioWorklet.addModule(dynamicsWorkletUrl)
      this.dynamicsAvailable = true
    } catch (err) {
      this.dynamicsAvailable = false
      console.warn('[WaveForge] dynamics worklet 載入失敗，De-esser / Dynamic EQ 停用：', err.message)
    }
    this.ctx = ctx
    this._buildGraph()
    this._lufsWorkletReady = true
  }

  _buildGraph() { buildProcessingGraph(this) }

  // Saturation transfer curves. drive ∈ [0,1]; each type shapes harmonics differently.
  _makeSatCurve(drive, type) {
    const N = 2048
    const curve = new Float32Array(N)
    const k = 1 + drive * 24   // drive scaling
    for (let i = 0; i < N; i++) {
      const x = (i * 2) / (N - 1) - 1
      switch (type) {
        case 'tube':   // asymmetric — even harmonics
          curve[i] = x >= 0 ? Math.tanh(k * x) : Math.tanh(k * 0.7 * x)
          break
        case 'transformer': { // cubic soft-knee — low-order odd harmonics, rounder than tape
          const xx = Math.min(1, Math.max(-1, k * x / 3))
          curve[i] = xx - (xx * xx * xx) / 3
          break
        }
        case 'clip':   // hard clip — harsh odd harmonics
          curve[i] = Math.min(1, Math.max(-1, k * x * 0.5))
          break
        case 'tape':   // smooth tanh — gentle odd harmonics
        default:
          curve[i] = Math.tanh(k * x)
      }
    }
    return curve
  }

  async loadFile(arrayBuffer) {
    await this.init()
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    this.stop()
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer)
    this.duration = this.buffer.duration
    this.pauseOffset = 0
    this.lufsNode?.port.postMessage('reset')
    return this.buffer
  }

  async play() {
    if (!this.buffer || this.isPlaying) return
    // Generation token: a second play()/seekTo()/stop() during the await gap
    // below invalidates this call — otherwise two sources end up playing.
    const gen = ++this._playGen
    if (this.ctx.state === 'suspended') {
      // Must await: on mobile browsers resume() can reject (needs fresh user
      // gesture) — fire-and-forget would show "playing" UI with no sound.
      await this.ctx.resume()
      if (this.ctx.state !== 'running') {
        throw new Error('AudioContext 無法啟動，請再點一次播放')
      }
      if (gen !== this._playGen || this.isPlaying) return  // superseded while resuming
    }
    const src = this.ctx.createBufferSource()
    src.buffer = this.buffer
    src.loop = this._loop
    src.onended = () => {
      // Identity check, not just the isPlaying flag: a source replaced by
      // seek/stop fires onended LATE (async dispatch) — after a new source is
      // already playing. Acting on it froze the progress bar at 0:00 and let
      // a second source stack on top (perceived as A+B playing together).
      if (this.source === src && this.isPlaying && !this._loop) {
        this.isPlaying = false
        this.pauseOffset = 0
        this._onEnded?.()
      }
    }
    this.source = src
    // Connect source to both paths
    src.connect(this.nodes.inputGain)
    src.connect(this.nodes.bypassGain)
    src.start(0, this.pauseOffset)
    this.startTime = this.ctx.currentTime - this.pauseOffset
    this.isPlaying = true
  }

  pause() {
    if (!this.isPlaying) return
    this.pauseOffset = this.ctx.currentTime - this.startTime
    // Clear isPlaying BEFORE stop(): onended fires on manual stop too, and
    // must not be mistaken for natural end-of-track.
    this.isPlaying = false
    this.source?.stop()
  }

  stop() {
    this._playGen = (this._playGen ?? 0) + 1  // invalidate any play() mid-resume
    if (this.source) {
      this.isPlaying = false
      try {
        this.source.stop()
      } catch (e) {
        // Only InvalidStateError (already stopped) is expected here
        if (!(e instanceof DOMException && e.name === 'InvalidStateError')) throw e
      }
      this.source.disconnect()
      this.source = null
    }
    this.isPlaying = false
    this.pauseOffset = 0
  }

  seekTo(fraction) {
    if (!this.buffer) return
    const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
    const wasPlaying = this.isPlaying
    this.stop()
    this.pauseOffset = f * this.duration
    // ctx is already running when seeking mid-playback; resume failure can't occur
    if (wasPlaying) this.play().catch(err => this._onError?.(err))
  }

  get currentTime() {
    if (!this.ctx) return 0
    if (this.isPlaying) return this.ctx.currentTime - this.startTime
    return this.pauseOffset
  }

  // Live stereo phase correlation of the OUTPUT (+1 mono, 0 wide, −1 anti-phase).
  // Returns null when no analysers (pre-init) or on silence.
  getCorrelation() {
    if (!this._corrL || !this._corrR) return null
    this._corrL.getFloatTimeDomainData(this._corrBufL)
    this._corrR.getFloatTimeDomainData(this._corrBufR)
    const L = this._corrBufL, R = this._corrBufR
    let lr = 0, l2 = 0, r2 = 0
    for (let i = 0; i < L.length; i++) {
      lr += L[i] * R[i]; l2 += L[i] * L[i]; r2 += R[i] * R[i]
    }
    const denom = Math.sqrt(l2 * r2)
    if (denom < 1e-9) return null
    return Math.max(-1, Math.min(1, lr / denom))
  }

  // Raw stereo time-domain frame of the OUTPUT for the goniometer (vectorscope).
  // Reuses the correlation analysers/buffers (same 2048-point tap). The returned
  // arrays are reused across calls — read them immediately, don't retain.
  getStereoScope() {
    if (!this._corrL || !this._corrR) return null
    this._corrL.getFloatTimeDomainData(this._corrBufL)
    this._corrR.getFloatTimeDomainData(this._corrBufR)
    return { left: this._corrBufL, right: this._corrBufR }
  }

  // ── Module enable/disable ─────────────────────────────
  setModuleBypassed(mod, bypassed) {
    this.bypassed[mod] = bypassed
    // For EQ: gain all bands to 0 vs restore
    if (mod === 'eq') {
      this.eqBands.forEach((b, i) => {
        b.gain.setTargetAtTime(bypassed ? 0 : this.params.eqGains[i], this.ctx.currentTime, 0.01)
      })
    }
    // True bypass uses the direct dry route: compressors have lookahead latency.
    if (mod === 'comp') {
      const t = this.ctx.currentTime
      this.nodes.makeupGain.gain.setTargetAtTime(bypassed ? 1 : Math.pow(10, this.params.compMakeup / 20), t, 0.01)
      this.setMBCMix(this.params.mbcMix)
      this.nodes.compBands.forEach((c, i) =>
        c.ratio.setTargetAtTime(bypassed ? 1 : this.params.mbcRatio[i], t, 0.01))
      if (!bypassed) this.nodes.compBands.forEach((c, i) =>
        c.threshold.setTargetAtTime(this.params.mbcThresh[i], t, 0.01))
    }
    if (mod === 'limiter') {
      const n = this.nodes.lim
      n.ratio.setTargetAtTime(bypassed ? 1 : 20, this.ctx.currentTime, 0.01)
    }
    if (mod === 'hplp') {
      this.nodes.hp.frequency.setTargetAtTime(bypassed ? 1 : this.params.hpFreq, this.ctx.currentTime, 0.01)
      this.nodes.lp.frequency.setTargetAtTime(bypassed ? this.ctx.sampleRate / 2 : Math.min(this.params.lpFreq, this.ctx.sampleRate / 2), this.ctx.currentTime, 0.01)
    }
    if (mod === 'sat') {
      const t = this.ctx.currentTime
      const mix = this.params.satMix
      this.nodes.satWet.gain.setTargetAtTime(bypassed ? 0 : mix, t, 0.01)
      this.nodes.satDry.gain.setTargetAtTime(bypassed ? 1 : 1 - mix, t, 0.01)
    }
    if (mod === 'ms' && this.nodes.msWet) {
      const t = this.ctx.currentTime
      this.nodes.msWet.gain.setTargetAtTime(bypassed ? 0 : 1, t, 0.01)
      this.nodes.msDry.gain.setTargetAtTime(bypassed ? 1 : 0, t, 0.01)
    }
    // Worklet modules: sample-accurate bypass param inside the processor.
    // Nodes are absent when the dynamics worklet failed to load — no-op then.
    if ((mod === 'deesser' || mod === 'dyneq') && this.nodes[mod]) {
      this.nodes[mod].parameters.get('bypass').setValueAtTime(bypassed ? 1 : 0, this.ctx.currentTime)
    }
  }

  // ── Parameter setters (all use setTargetAtTime for zero-click) ─
  setHPFreq(hz) {
    this.params.hpFreq = hz
    if (!this.bypassed.hplp) this.nodes.hp.frequency.setTargetAtTime(hz, this.ctx?.currentTime ?? 0, 0.005)
  }

  setLPFreq(hz) {
    this.params.lpFreq = hz
    if (!this.bypassed.hplp) this.nodes.lp.frequency.setTargetAtTime(hz, this.ctx?.currentTime ?? 0, 0.005)
  }

  setEQBand(index, gainDb) {
    this.params.eqGains[index] = gainDb
    if (!this.bypassed.eq) this.eqBands[index]?.gain.setTargetAtTime(gainDb, this.ctx?.currentTime ?? 0, 0.005)
  }

  _eachBand(fn) { this.nodes.compBands?.forEach(fn) }

  // Global comp threshold/ratio seed ALL bands (back-compat with 39 presets).
  setCompThreshold(db) {
    this.params.compThreshold = db
    this.params.mbcThresh = [db, db, db]
    if (!this.bypassed.comp) this._eachBand(c => c.threshold.setTargetAtTime(db, this.ctx?.currentTime ?? 0, 0.01))
  }

  setCompKnee(db) {
    this.params.compKnee = db
    this._eachBand(c => c.knee.setTargetAtTime(db, this.ctx?.currentTime ?? 0, 0.01))
  }

  setCompRatio(r) {
    this.params.compRatio = r
    this.params.mbcRatio = [r, r, r]
    if (!this.bypassed.comp) this._eachBand(c => c.ratio.setTargetAtTime(r, this.ctx?.currentTime ?? 0, 0.01))
  }

  setCompAttack(s) {
    this.params.compAttack = s
    this._eachBand(c => c.attack.setTargetAtTime(s, this.ctx?.currentTime ?? 0, 0.01))
  }

  setCompRelease(s) {
    this.params.compRelease = s
    this._eachBand(c => c.release.setTargetAtTime(s, this.ctx?.currentTime ?? 0, 0.01))
  }

  // ── True MBC per-band + crossover setters ─────────────────
  setMBCBandThresh(i, db) {
    this.params.mbcThresh[i] = db
    if (!this.bypassed.comp) this.nodes.compBands[i]?.threshold.setTargetAtTime(db, this.ctx?.currentTime ?? 0, 0.01)
  }

  setMBCBandRatio(i, r) {
    this.params.mbcRatio[i] = r
    if (!this.bypassed.comp) this.nodes.compBands[i]?.ratio.setTargetAtTime(r, this.ctx?.currentTime ?? 0, 0.01)
  }

  setMBCXover(i, hz) {
    if (i === 0) { this.params.mbcXover1 = hz; this.nodes.lp1?.frequency.setTargetAtTime(hz, this.ctx?.currentTime ?? 0, 0.01) }
    else         { this.params.mbcXover2 = hz; this.nodes.lp2?.frequency.setTargetAtTime(hz, this.ctx?.currentTime ?? 0, 0.01) }
  }

  // Worst (most negative) gain reduction across the 3 bands, for the GR meter.
  compReduction() {
    const b = this.nodes.compBands
    if (!b) return 0
    return Math.min(b[0].reduction ?? 0, b[1].reduction ?? 0, b[2].reduction ?? 0)
  }

  setCompMakeup(db) {
    this.params.compMakeup = db
    const gain = Math.pow(10, db / 20)
    if (!this.bypassed.comp) this.nodes.makeupGain.gain.setTargetAtTime(gain, this.ctx?.currentTime ?? 0, 0.01)
  }

  setLimCeiling(dbtp) {
    this.params.limCeiling = dbtp
    // Threshold = ceiling (we can't truly do True Peak in DynamicsCompressor, honest limitation)
    if (!this.bypassed.limiter) this.nodes.lim.threshold.setTargetAtTime(dbtp, this.ctx?.currentTime ?? 0, 0.005)
  }

  setLimRelease(s) {
    this.params.limRelease = s
    if (!this.bypassed.limiter) this.nodes.lim.release.setTargetAtTime(s, this.ctx?.currentTime ?? 0, 0.01)
  }

  setLimInput(db) {
    this.params.limInput = db
    this.nodes.limInput?.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx?.currentTime ?? 0, 0.01)
  }

  setSatDrive(drive) {
    this.params.satDrive = drive
    // WaveShaper curve swap is instantaneous (no AudioParam) — acceptable:
    // curve change at same drive ballpark produces no click in practice
    if (this.nodes.shaper) this.nodes.shaper.curve = this._makeSatCurve(drive, this.params.satType ?? 'tape')
  }

  setSatMix(mix) {
    this.params.satMix = mix
    if (!this.bypassed.sat && this.nodes.satWet) {
      const t = this.ctx.currentTime
      this.nodes.satWet.gain.setTargetAtTime(mix, t, 0.01)
      this.nodes.satDry.gain.setTargetAtTime(1 - mix, t, 0.01)
    }
  }

  setSatType(type) {
    this.params.satType = type
    if (this.nodes.shaper) this.nodes.shaper.curve = this._makeSatCurve(this.params.satDrive, type)
  }

  setMasterVolume(v) {
    this.params.masterVol = v
    this.nodes.outputGain?.gain.setTargetAtTime(v, this.ctx?.currentTime ?? 0, 0.01)
  }

  // MBC parallel mix: 100 = fully compressed, 0 = fully dry, 50 = equal blend
  setMBCMix(pct) {
    this.params.mbcMix = pct
    const wet = this.bypassed.comp ? 0 : Math.max(0, Math.min(1, pct / 100))
    const t = this.ctx?.currentTime ?? 0
    this.nodes.mbcWetGain?.gain.setTargetAtTime(wet, t, 0.01)
    this.nodes.mbcDryGain?.gain.setTargetAtTime(1 - wet, t, 0.01)
  }

  // ── Phase-2 setters ───────────────────────────────────────
  // Side level = width × side gain combined on one node
  _applyMSSide() {
    const lin = (this.params.msWidth / 100) * Math.pow(10, this.params.msSideGain / 20)
    this.nodes.msSide?.gain.setTargetAtTime(lin, this.ctx?.currentTime ?? 0, 0.01)
  }

  setMSWidth(pct) {
    this.params.msWidth = pct
    this._applyMSSide()
  }

  setMSMidGain(db) {
    this.params.msMidGain = db
    this.nodes.msMid?.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx?.currentTime ?? 0, 0.01)
  }

  setMSSideGain(db) {
    this.params.msSideGain = db
    this._applyMSSide()
  }

  _setWorkletParam(node, name, value) {
    node?.parameters.get(name).setValueAtTime(value, this.ctx?.currentTime ?? 0)
  }

  setDynEQFreq(hz)    { this.params.dyneqFreq = hz;    this._setWorkletParam(this.nodes.dyneq, 'freq', hz) }
  setDynEQThresh(db)  { this.params.dyneqThresh = db;  this._setWorkletParam(this.nodes.dyneq, 'threshold', db) }
  setDynEQRatio(r)    { this.params.dyneqRatio = r;    this._setWorkletParam(this.nodes.dyneq, 'ratio', r) }
  setDeessFreq(hz)    { this.params.deessFreq = hz;    this._setWorkletParam(this.nodes.deesser, 'freq', hz) }
  setDeessThresh(db)  { this.params.deessThresh = db;  this._setWorkletParam(this.nodes.deesser, 'threshold', db) }

  // A = dry, B = processed
  setABMode(mode) {
    if (!this.ctx) return
    this.abMode = mode
    const t = this.ctx.currentTime
    const fade = 0.02
    if (mode === 'A') {
      // Hear dry signal — gain 1, NOT masterVol: outputGain downstream already
      // applies master volume to both paths (masterVol here = applied twice)
      this.nodes.processedGain.gain.setTargetAtTime(0, t, fade)
      this.nodes.bypassGain.gain.setTargetAtTime(1, t, fade)
    } else {
      // Hear processed chain
      this.nodes.bypassGain.gain.setTargetAtTime(0, t, fade)
      this.nodes.processedGain.gain.setTargetAtTime(1, t, fade)
    }
  }

  // Apply a preset object {compThreshold, compRatio, eqGains, limCeiling, ...}
  applyPreset(preset) {
    if (!preset) return
    if (preset.hpFreq != null) this.setHPFreq(preset.hpFreq)
    if (preset.lpFreq != null) this.setLPFreq(preset.lpFreq)
    if (preset.eqGains) preset.eqGains.forEach((g, i) => this.setEQBand(i, g))
    if (preset.compThreshold != null) this.setCompThreshold(preset.compThreshold)
    if (preset.compRatio != null) this.setCompRatio(preset.compRatio)
    if (preset.compKnee != null) this.setCompKnee(preset.compKnee)
    if (preset.compAttack != null) this.setCompAttack(preset.compAttack)
    if (preset.compRelease != null) this.setCompRelease(preset.compRelease)
    if (preset.compMakeup != null) this.setCompMakeup(preset.compMakeup)
    if (preset.limCeiling != null) this.setLimCeiling(preset.limCeiling)
    if (preset.limInput != null) this.setLimInput(preset.limInput)
    if (preset.satDrive != null) this.setSatDrive(preset.satDrive)
    if (preset.satMix != null) this.setSatMix(preset.satMix)
    if (preset.msWidth != null) this.setMSWidth(preset.msWidth)
    if (preset.msMidGain != null) this.setMSMidGain(preset.msMidGain)
    if (preset.msSideGain != null) this.setMSSideGain(preset.msSideGain)
    if (preset.dyneqFreq != null) this.setDynEQFreq(preset.dyneqFreq)
    if (preset.dyneqThresh != null) this.setDynEQThresh(preset.dyneqThresh)
    if (preset.dyneqRatio != null) this.setDynEQRatio(preset.dyneqRatio)
    if (preset.deessFreq != null) this.setDeessFreq(preset.deessFreq)
    if (preset.deessThresh != null) this.setDeessThresh(preset.deessThresh)
    if (preset.mbcMix != null) this.setMBCMix(preset.mbcMix)
    if (preset.masterVol != null) this.setMasterVolume(preset.masterVol)
  }

  // Get EQ frequency response magnitudes for canvas drawing
  getEQResponse(freqs) {
    if (!this.eqBands.length || !freqs) return null
    const magOut = new Float32Array(freqs.length).fill(1)
    const phaseOut = new Float32Array(freqs.length)
    for (const band of this.eqBands) {
      const mag = new Float32Array(freqs.length)
      band.getFrequencyResponse(freqs, mag, phaseOut)
      for (let i = 0; i < magOut.length; i++) magOut[i] *= mag[i]
    }
    return magOut
  }

  set loop(v) { this._loop = v; if (this.source) this.source.loop = v }
  get loop() { return this._loop ?? false }

  onLufs(cb) { this._onLufs = cb }
  onEnded(cb) { this._onEnded = cb }
  onError(cb) { this._onError = cb }
  onGR(cb) { this._onGR = cb }   // (module, grDb) for dyneq/deesser meters

  // ── Chain snapshot / restore ──────────────────────────────
  // Captures the full DSP state as a JSON-safe object. Foundation for album
  // per-track snapshots and user-preset save. Does NOT capture UI-only settings
  // (linear-phase toggle, export bit depth) — those live in the album/UI layer.
  serialize() {
    return {
      version: 1,
      params: JSON.parse(JSON.stringify(this.params)),
      bypassed: { ...this.bypassed },
      abMode: this.abMode,
    }
  }

  // Apply a snapshot back to the engine via the public setters (so the audio
  // graph updates). Params are always restored (even pre-init, for persistence);
  // node-touching bypass/AB state only when the graph exists.
  restore(snap) {
    if (!snap) return
    const p = snap.params ?? {}
    if (p.hpFreq != null) this.setHPFreq(p.hpFreq)
    if (p.lpFreq != null) this.setLPFreq(p.lpFreq)
    if (Array.isArray(p.eqGains)) p.eqGains.forEach((g, i) => this.setEQBand(i, g))
    if (p.compKnee != null) this.setCompKnee(p.compKnee)
    if (p.compAttack != null) this.setCompAttack(p.compAttack)
    if (p.compRelease != null) this.setCompRelease(p.compRelease)
    if (p.compMakeup != null) this.setCompMakeup(p.compMakeup)
    if (p.mbcXover1 != null) this.setMBCXover(0, p.mbcXover1)
    if (p.mbcXover2 != null) this.setMBCXover(1, p.mbcXover2)
    if (Array.isArray(p.mbcThresh)) p.mbcThresh.forEach((v, i) => this.setMBCBandThresh(i, v))
    if (Array.isArray(p.mbcRatio)) p.mbcRatio.forEach((v, i) => this.setMBCBandRatio(i, v))
    if (p.limCeiling != null) this.setLimCeiling(p.limCeiling)
    if (p.limInput != null) this.setLimInput(p.limInput)
    if (p.limRelease != null) this.setLimRelease(p.limRelease)
    if (p.satType != null) this.setSatType(p.satType)
    if (p.satDrive != null) this.setSatDrive(p.satDrive)
    if (p.satMix != null) this.setSatMix(p.satMix)
    if (p.msWidth != null) this.setMSWidth(p.msWidth)
    if (p.msMidGain != null) this.setMSMidGain(p.msMidGain)
    if (p.msSideGain != null) this.setMSSideGain(p.msSideGain)
    if (p.dyneqFreq != null) this.setDynEQFreq(p.dyneqFreq)
    if (p.dyneqThresh != null) this.setDynEQThresh(p.dyneqThresh)
    if (p.dyneqRatio != null) this.setDynEQRatio(p.dyneqRatio)
    if (p.deessFreq != null) this.setDeessFreq(p.deessFreq)
    if (p.deessThresh != null) this.setDeessThresh(p.deessThresh)
    if (p.mbcMix != null) this.setMBCMix(p.mbcMix)
    if (p.masterVol != null) this.setMasterVolume(p.masterVol)
    // Bypass + A/B touch nodes directly (no ?. guard) — only when graph exists
    if (this.ctx) {
      if (snap.bypassed) {
        for (const [mod, b] of Object.entries(snap.bypassed)) this.setModuleBypassed(mod, b)
      }
      if (snap.abMode) this.setABMode(snap.abMode)
    } else {
      if (snap.bypassed) this.bypassed = { ...this.bypassed, ...snap.bypassed }
      if (snap.abMode) this.abMode = snap.abMode
    }
  }
}
