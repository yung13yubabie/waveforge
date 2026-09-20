// Shared native Web Audio graph for realtime monitoring and export.
// EQ band centre frequencies (Hz) and types
const EQ_BANDS = [
  { freq: 32,    type: 'lowshelf',  label: '32Hz'  },
  { freq: 64,    type: 'peaking',   label: '64Hz'  },
  { freq: 125,   type: 'peaking',   label: '125Hz' },
  { freq: 250,   type: 'peaking',   label: '250Hz' },
  { freq: 500,   type: 'peaking',   label: '500Hz' },
  { freq: 1000,  type: 'peaking',   label: '1kHz'  },
  { freq: 2000,  type: 'peaking',   label: '2kHz'  },
  { freq: 4000,  type: 'peaking',   label: '4kHz'  },
  { freq: 8000,  type: 'peaking',   label: '8kHz'  },
  { freq: 16000, type: 'highshelf', label: '16kHz' },
]

export function buildProcessingGraph(engine, { metering = true } = {}) {
    const ctx = engine.ctx
    const byp = engine.bypassed
    const p = engine.params

    // ── Input gain ────────────────────────────────────────
    const inputGain = ctx.createGain()
    inputGain.gain.value = 1

    // ── HP / LP filters ──────────────────────────────────
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'; hp.frequency.value = byp.hplp ? 1 : p.hpFreq; hp.Q.value = 0.707

    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'; lp.frequency.value = byp.hplp ? ctx.sampleRate / 2 : Math.min(p.lpFreq, ctx.sampleRate / 2); lp.Q.value = 0.707

    // ── 10-band EQ ────────────────────────────────────────
    const eqBands = EQ_BANDS.map((b, i) => {
      const f = ctx.createBiquadFilter()
      f.type = b.type
      f.frequency.value = b.freq
      f.gain.value = byp.eq ? 0 : (p.eqGains[i] ?? 0)
      f.Q.value = 1
      return f
    })
    engine.eqBands = eqBands

    // ── Phase-2: Dynamic EQ + De-esser (worklet, optional) ──
    let dyneq = null, deesser = null
    if (engine.dynamicsAvailable) {
      dyneq = new AudioWorkletNode(ctx, 'dyneq-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        parameterData: { freq: p.dyneqFreq, threshold: p.dyneqThresh, ratio: p.dyneqRatio, bypass: byp.dyneq ? 1 : 0 },
      })
      deesser = new AudioWorkletNode(ctx, 'deesser-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        parameterData: { freq: p.deessFreq, threshold: p.deessThresh, bypass: byp.deesser ? 1 : 0 },
      })
      // Forward each module's gain-reduction telemetry to the UI meter callback
      dyneq.port.onmessage   = e => { if (e.data?.type === 'gr') engine._onGR?.('dyneq', e.data.value) }
      deesser.port.onmessage = e => { if (e.data?.type === 'gr') engine._onGR?.('deesser', e.data.value) }
    }

    // ── Phase-2: M/S matrix (native nodes, parallel dry/wet) ──
    // msIn forces stereo so mono sources don't lose a channel in the matrix
    const msIn = ctx.createGain()
    msIn.channelCount = 2
    msIn.channelCountMode = 'explicit'
    msIn.channelInterpretation = 'speakers'

    const msSplit = ctx.createChannelSplitter(2)
    const msToM_L = ctx.createGain(); msToM_L.gain.value = 0.5
    const msToM_R = ctx.createGain(); msToM_R.gain.value = 0.5
    const msToS_L = ctx.createGain(); msToS_L.gain.value = 0.5
    const msToS_R = ctx.createGain(); msToS_R.gain.value = -0.5
    const msMid  = ctx.createGain()   // mid gain (dB → linear, set below)
    const msSide = ctx.createGain()   // side gain × width
    msMid.gain.value  = Math.pow(10, engine.params.msMidGain / 20)
    msSide.gain.value = (engine.params.msWidth / 100) * Math.pow(10, engine.params.msSideGain / 20)
    const msSideInv = ctx.createGain(); msSideInv.gain.value = -1
    const msMerge = ctx.createChannelMerger(2)
    const msWet = ctx.createGain(); msWet.gain.value = byp.ms ? 0 : 1   // starts bypassed
    const msDry = ctx.createGain(); msDry.gain.value = byp.ms ? 1 : 0
    const msSum = ctx.createGain()

    // ── Multiband Compressor (true 3-band, subtractive crossover) ──
    // Subtractive split → perfect reconstruction at unity (low+mid+high = in),
    // no summing notches. Each band compressed independently. LP biquads at the
    // two crossovers; high parts derived by subtraction (same trick as de-esser).
    const mbcIn = ctx.createGain()
    const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = p.mbcXover1; lp1.Q.value = 0.707
    const lp1inv = ctx.createGain(); lp1inv.gain.value = -1
    const highpart = ctx.createGain()              // = mbcIn − lp1  (everything above xover1)
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = p.mbcXover2; lp2.Q.value = 0.707
    const lp2inv = ctx.createGain(); lp2inv.gain.value = -1
    const highband = ctx.createGain()              // = highpart − lp2  (above xover2)

    const mkComp = (thr, ratio) => {
      const c = ctx.createDynamicsCompressor()
      c.threshold.value = thr; c.knee.value = p.compKnee; c.ratio.value = byp.comp ? 1 : ratio
      c.attack.value = p.compAttack; c.release.value = p.compRelease
      return c
    }
    const compLow  = mkComp(p.mbcThresh[0], p.mbcRatio[0])
    const compMid  = mkComp(p.mbcThresh[1], p.mbcRatio[1])
    const compHigh = mkComp(p.mbcThresh[2], p.mbcRatio[2])
    const mbcSum = ctx.createGain()

    // low band = lp1(in)
    mbcIn.connect(lp1); lp1.connect(compLow); compLow.connect(mbcSum)
    // highpart = in − lp1
    mbcIn.connect(highpart); lp1.connect(lp1inv); lp1inv.connect(highpart)
    // mid band = lp2(highpart)
    highpart.connect(lp2); lp2.connect(compMid); compMid.connect(mbcSum)
    // high band = highpart − lp2
    highpart.connect(highband); lp2.connect(lp2inv); lp2inv.connect(highband)
    highband.connect(compHigh); compHigh.connect(mbcSum)

    // nodes.comp stays = mid-band comp so existing reduction reads keep working
    const comp = compMid
    const compBands = [compLow, compMid, compHigh]

    const makeupGain = ctx.createGain()
    makeupGain.gain.value = byp.comp ? 1 : Math.pow(10, p.compMakeup / 20)

    // ── MBC parallel mix (wet = compressed, dry = pre-MBC) ──
    // mbcMix 100 = fully compressed (default); 0 = fully dry (parallel comp off)
    const mbcDryTap  = ctx.createGain()   // unity-gain tap before mbcIn
    const mbcWetGain = ctx.createGain()   // weighted compressed+makeup
    const mbcDryGain = ctx.createGain()   // weighted uncompressed dry
    const mbcParallelOut = ctx.createGain()
    const mix = byp.comp ? 0 : Math.max(0, Math.min(1, (p.mbcMix ?? 100) / 100))
    mbcWetGain.gain.value = mix
    mbcDryGain.gain.value = 1 - mix

    // ── Saturator (WaveShaper, parallel dry/wet) ─────────
    const shaper = ctx.createWaveShaper()
    shaper.curve = engine._makeSatCurve(engine.params.satDrive, engine.params.satType ?? 'tape')
    shaper.oversample = '4x'
    const satWet = ctx.createGain()
    const satDry = ctx.createGain()
    const satSum = ctx.createGain()
    // sat starts bypassed: dry passes, wet muted
    satWet.gain.value = byp.sat ? 0 : p.satMix
    satDry.gain.value = byp.sat ? 1 : 1 - p.satMix
    satSum.gain.value = 1

    // ── Limiter input gain ────────────────────────────────
    const limInput = ctx.createGain()
    limInput.gain.value = Math.pow(10, (engine.params.limInput ?? 0) / 20)

    // ── Limiter (DynamicsCompressor with extreme ratio) ───
    const lim = ctx.createDynamicsCompressor()
    lim.threshold.value = p.limCeiling
    lim.knee.value = 0
    lim.ratio.value = byp.limiter ? 1 : 20
    lim.attack.value = 0.001
    lim.release.value = p.limRelease

    // ── Output gain ───────────────────────────────────────
    const outputGain = ctx.createGain()
    outputGain.gain.value = engine.params.masterVol

    // ── Analyser (for spectrum canvas) ────────────────────
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 4096
    analyser.smoothingTimeConstant = 0.8
    engine.analyser = analyser

    // ── Stereo correlation analysers (per-channel time domain) ──
    const corrSplit = ctx.createChannelSplitter(2)
    const corrL = ctx.createAnalyser(); corrL.fftSize = 2048
    const corrR = ctx.createAnalyser(); corrR.fftSize = 2048
    corrSplit.connect(corrL, 0)
    corrSplit.connect(corrR, 1)
    engine._corrL = corrL
    engine._corrR = corrR
    engine._corrBufL = new Float32Array(2048)
    engine._corrBufR = new Float32Array(2048)

    // ── LUFS WorkletNode ──────────────────────────────────
    const lufsNode = metering ? new AudioWorkletNode(ctx, 'lufs-processor', {
      numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [2],
    }) : null
    if (lufsNode) lufsNode.port.onmessage = e => {
      if (e.data.type === 'lufs' && engine._onLufs) {
        engine._onLufs(e.data.m, e.data.s, e.data.i, e.data.tp)
      }
    }
    engine.lufsNode = lufsNode

    // ── A/B bypass path ───────────────────────────────────
    const bypassGain = ctx.createGain()
    bypassGain.gain.value = 0  // starts on B (processed)

    const processedGain = ctx.createGain()
    processedGain.gain.value = 1

    // ── Wire the processed chain ──────────────────────────
    // source → inputGain → hp → lp → eq[0] → ... → eq[9]
    //        → comp → makeupGain → lim → processedGain → outputGain
    //        → analyser → lufsNode → destination
    inputGain.connect(hp)
    hp.connect(lp)
    let prev = lp
    for (const band of eqBands) { prev.connect(band); prev = band }

    // Phase-2 insert: eq → dyneq → M/S → deesser → comp
    if (dyneq) { prev.connect(dyneq); prev = dyneq }

    // M/S block: msIn fans out to dry path and encode matrix; msSum is the exit
    prev.connect(msIn)
    msIn.connect(msDry)
    msDry.connect(msSum)
    msIn.connect(msSplit)
    msSplit.connect(msToM_L, 0)
    msSplit.connect(msToM_R, 1)
    msSplit.connect(msToS_L, 0)
    msSplit.connect(msToS_R, 1)
    msToM_L.connect(msMid)
    msToM_R.connect(msMid)
    msToS_L.connect(msSide)
    msToS_R.connect(msSide)
    // Decode: L = M + S (merger ch0), R = M − S (merger ch1)
    msMid.connect(msMerge, 0, 0)
    msSide.connect(msMerge, 0, 0)
    msMid.connect(msMerge, 0, 1)
    msSide.connect(msSideInv)
    msSideInv.connect(msMerge, 0, 1)
    msMerge.connect(msWet)
    msWet.connect(msSum)
    prev = msSum

    if (deesser) { prev.connect(deesser); prev = deesser }

    prev.connect(mbcIn)
    prev.connect(mbcDryTap)   // dry tap before compression
    mbcSum.connect(makeupGain)
    // MBC parallel mix: wet (compressed+makeup) and dry blend at mbcParallelOut
    makeupGain.connect(mbcWetGain)
    mbcWetGain.connect(mbcParallelOut)
    mbcDryTap.connect(mbcDryGain)
    mbcDryGain.connect(mbcParallelOut)
    // Saturator: parallel dry/wet around the waveshaper
    mbcParallelOut.connect(satDry)
    mbcParallelOut.connect(shaper)
    shaper.connect(satWet)
    satDry.connect(satSum)
    satWet.connect(satSum)
    satSum.connect(limInput)
    limInput.connect(lim)
    lim.connect(processedGain)
    processedGain.connect(outputGain)
    outputGain.connect(analyser)
    outputGain.connect(corrSplit)   // stereo correlation tap (no effect on signal)
    if (lufsNode) { analyser.connect(lufsNode); lufsNode.connect(ctx.destination) }
    else analyser.connect(ctx.destination)

    // ── Wire bypass ───────────────────────────────────────
    // source → bypassGain → outputGain (merges into same output)
    bypassGain.connect(outputGain)

    engine.nodes = {
      inputGain, hp, lp, comp, compBands, makeupGain,
      mbcIn, mbcSum, lp1, lp2,
      mbcDryTap, mbcWetGain, mbcDryGain, mbcParallelOut,
      shaper, satWet, satDry, satSum, limInput,
      lim, outputGain, bypassGain, processedGain, analyser,
      msIn, msDry, msWet, msSum, msMid, msSide, msSideInv,
    }
    if (dyneq)   engine.nodes.dyneq = dyneq
    if (deesser) engine.nodes.deesser = deesser
    engine.EQ_BANDS_META = EQ_BANDS
  }

