// Offline mastering render — the single source of truth for the processing
// chain, shared by single-track export AND album per-track rendering. Keeping
// ONE copy avoids the export-vs-realtime drift the pre-launch audit warned of.
//
// Takes a params snapshot (NOT live engine state) so each album track renders
// through its own frozen chain, at any sample rate (48k export / 44.1k DDP).
import { applyLinearPhaseEQ } from './lin-phase-eq.js'

const FFT_N = 4096

/**
 * @param {object}  o
 * @param {AudioEngine} o.engine            for static EQ band meta, _makeSatCurve, dynamicsAvailable
 * @param {AudioBuffer} o.sourceBuffer      audio to process
 * @param {object}  o.params                snapshot params (engine.serialize().params)
 * @param {object}  o.bypassed              snapshot bypass map
 * @param {number}  o.sampleRate            output rate (48000 export, 44100 DDP)
 * @param {Float32Array|null} o.linPhaseMag EQ magnitude for linear-phase FIR (export only); null = biquad EQ
 * @param {string}  o.dynamicsWorkletUrl    ?url for the dynamics worklet
 * @returns {Promise<AudioBuffer>} rendered stereo output
 */
export async function renderMasterChain({
  engine, sourceBuffer, params: p, bypassed: byp,
  sampleRate, linPhaseMag = null, dynamicsWorkletUrl,
}) {
  const dur = sourceBuffer.duration
  const off = new OfflineAudioContext(2, Math.ceil(dur * sampleRate), sampleRate)

  const needDynWorklet = engine.dynamicsAvailable && (!byp.dyneq || !byp.deesser)
  if (needDynWorklet) {
    try {
      await off.audioWorklet.addModule(dynamicsWorkletUrl)
    } catch (err) {
      throw new Error(`離線渲染無法載入 Dynamic EQ / De-esser（${err.message}）— 請先旁路這兩個模組再輸出`)
    }
  }

  const src = off.createBufferSource()
  // Linear-phase EQ: pre-convolve source with the FIR, then render biquad EQ flat
  const linPhase = !byp.eq && !!linPhaseMag
  if (linPhase) {
    const inCh = []
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) inCh.push(sourceBuffer.getChannelData(ch))
    const eqd = applyLinearPhaseEQ(inCh, linPhaseMag, FFT_N)
    const lpBuf = off.createBuffer(eqd.length, eqd[0].length, sourceBuffer.sampleRate)
    eqd.forEach((d, ch) => lpBuf.copyToChannel(d, ch))
    src.buffer = lpBuf
  } else {
    src.buffer = sourceBuffer
  }

  const inputGain = off.createGain()
  inputGain.gain.value = 1

  const hp = off.createBiquadFilter()
  hp.type = 'highpass'; hp.Q.value = 0.707
  hp.frequency.value = byp.hplp ? 1 : p.hpFreq

  const lp = off.createBiquadFilter()
  lp.type = 'lowpass'; lp.Q.value = 0.707
  lp.frequency.value = byp.hplp ? 24000 : p.lpFreq

  const eqNodes = engine.eqBands.map((band, i) => {
    const n = off.createBiquadFilter()
    n.type = band.type
    n.frequency.value = band.frequency.value
    n.gain.value = (byp.eq || linPhase) ? 0 : (p.eqGains[i] ?? 0)
    n.Q.value = band.Q.value
    return n
  })

  const dyneqNode = (needDynWorklet && !byp.dyneq)
    ? new AudioWorkletNode(off, 'dyneq-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        parameterData: { freq: p.dyneqFreq, threshold: p.dyneqThresh, ratio: p.dyneqRatio, bypass: 0 },
      })
    : null
  const deesserNode = (needDynWorklet && !byp.deesser)
    ? new AudioWorkletNode(off, 'deesser-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        parameterData: { freq: p.deessFreq, threshold: p.deessThresh, bypass: 0 },
      })
    : null

  let msEntry = null, msExit = null
  if (!byp.ms) {
    const msIn = off.createGain()
    msIn.channelCount = 2; msIn.channelCountMode = 'explicit'
    const split = off.createChannelSplitter(2)
    const toML = off.createGain(); toML.gain.value = 0.5
    const toMR = off.createGain(); toMR.gain.value = 0.5
    const toSL = off.createGain(); toSL.gain.value = 0.5
    const toSR = off.createGain(); toSR.gain.value = -0.5
    const mid  = off.createGain(); mid.gain.value  = Math.pow(10, p.msMidGain / 20)
    const side = off.createGain(); side.gain.value = (p.msWidth / 100) * Math.pow(10, p.msSideGain / 20)
    const sInv = off.createGain(); sInv.gain.value = -1
    const merge = off.createChannelMerger(2)
    msIn.connect(split)
    split.connect(toML, 0); split.connect(toMR, 1)
    split.connect(toSL, 0); split.connect(toSR, 1)
    toML.connect(mid); toMR.connect(mid)
    toSL.connect(side); toSR.connect(side)
    mid.connect(merge, 0, 0); side.connect(merge, 0, 0)
    mid.connect(merge, 0, 1); side.connect(sInv); sInv.connect(merge, 0, 1)
    msEntry = msIn; msExit = merge
  }

  // True multiband compressor (subtractive 3-band, matches engine._buildGraph)
  const mbcIn = off.createGain()
  const xlp1 = off.createBiquadFilter(); xlp1.type = 'lowpass'; xlp1.frequency.value = p.mbcXover1; xlp1.Q.value = 0.707
  const xlp1inv = off.createGain(); xlp1inv.gain.value = -1
  const xhighpart = off.createGain()
  const xlp2 = off.createBiquadFilter(); xlp2.type = 'lowpass'; xlp2.frequency.value = p.mbcXover2; xlp2.Q.value = 0.707
  const xlp2inv = off.createGain(); xlp2inv.gain.value = -1
  const xhighband = off.createGain()
  const mkC = (thr, ratio) => {
    const c = off.createDynamicsCompressor()
    c.threshold.value = thr; c.knee.value = p.compKnee
    c.ratio.value = byp.comp ? 1 : ratio
    c.attack.value = p.compAttack; c.release.value = p.compRelease
    return c
  }
  const cLow = mkC(p.mbcThresh[0], p.mbcRatio[0])
  const cMid = mkC(p.mbcThresh[1], p.mbcRatio[1])
  const cHigh = mkC(p.mbcThresh[2], p.mbcRatio[2])
  const mbcSum = off.createGain()
  mbcIn.connect(xlp1); xlp1.connect(cLow); cLow.connect(mbcSum)
  mbcIn.connect(xhighpart); xlp1.connect(xlp1inv); xlp1inv.connect(xhighpart)
  xhighpart.connect(xlp2); xlp2.connect(cMid); cMid.connect(mbcSum)
  xhighpart.connect(xhighband); xlp2.connect(xlp2inv); xlp2inv.connect(xhighband)
  xhighband.connect(cHigh); cHigh.connect(mbcSum)

  const makeup = off.createGain()
  makeup.gain.value = byp.comp ? 1 : Math.pow(10, p.compMakeup / 20)

  const shaper = off.createWaveShaper()
  shaper.curve = engine._makeSatCurve(p.satDrive, p.satType)
  shaper.oversample = '4x'
  const satWet = off.createGain()
  const satDry = off.createGain()
  const satSum = off.createGain()
  satWet.gain.value = byp.sat ? 0 : p.satMix
  satDry.gain.value = byp.sat ? 1 : 1 - p.satMix

  const limInput = off.createGain()
  limInput.gain.value = Math.pow(10, (p.limInput ?? 0) / 20)

  const lim = off.createDynamicsCompressor()
  lim.threshold.value = p.limCeiling
  lim.knee.value      = 0
  lim.ratio.value     = byp.limiter ? 1 : 20
  lim.attack.value    = 0.001
  lim.release.value   = p.limRelease

  const master = off.createGain()
  master.gain.value = p.masterVol

  src.connect(inputGain)
  inputGain.connect(hp)
  hp.connect(lp)
  let prev = lp
  for (const n of eqNodes) { prev.connect(n); prev = n }
  if (dyneqNode) { prev.connect(dyneqNode); prev = dyneqNode }
  if (msEntry)   { prev.connect(msEntry); prev = msExit }
  if (deesserNode) { prev.connect(deesserNode); prev = deesserNode }
  prev.connect(mbcIn)
  mbcSum.connect(makeup)
  makeup.connect(satDry)
  makeup.connect(shaper)
  shaper.connect(satWet)
  satDry.connect(satSum)
  satWet.connect(satSum)
  satSum.connect(limInput)
  limInput.connect(lim)
  lim.connect(master)
  master.connect(off.destination)
  src.start(0)

  return off.startRendering()
}

// EQ magnitude (10-band biquad product) at the given freqs, computed from a
// params snapshot — for designing the linear-phase FIR without touching live
// nodes. Builds throwaway biquads in a 1-frame OfflineAudioContext.
export function eqMagnitudeFromParams(engine, eqGains, freqs, sampleRate) {
  const off = new OfflineAudioContext(1, 1, sampleRate)
  const mag = new Float32Array(freqs.length).fill(1)
  const tmpMag = new Float32Array(freqs.length)
  const phase = new Float32Array(freqs.length)
  engine.eqBands.forEach((band, i) => {
    const n = off.createBiquadFilter()
    n.type = band.type
    n.frequency.value = band.frequency.value
    n.Q.value = band.Q.value
    n.gain.value = eqGains[i] ?? 0
    n.getFrequencyResponse(freqs, tmpMag, phase)
    for (let k = 0; k < mag.length; k++) mag[k] *= tmpMag[k]
  })
  return mag
}
