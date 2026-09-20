import { buildProcessingGraph } from './processing-graph.js'
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

  if (!engine.dynamicsAvailable && (!byp.dyneq || !byp.deesser)) {
    throw new Error('Dynamic EQ / De-esser 無法使用，請明確旁路後再輸出')
  }
  const needDynWorklet = !byp.dyneq || !byp.deesser
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
    if (sourceBuffer.sampleRate !== sampleRate) {
      const resample = new OfflineAudioContext(sourceBuffer.numberOfChannels, Math.ceil(dur * sampleRate), sampleRate)
      const input = resample.createBufferSource()
      input.buffer = sourceBuffer; input.connect(resample.destination); input.start()
      sourceBuffer = await resample.startRendering()
    }
    const inCh = []
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) inCh.push(sourceBuffer.getChannelData(ch))
    const eqd = applyLinearPhaseEQ(inCh, linPhaseMag, FFT_N)
    const lpBuf = off.createBuffer(eqd.length, eqd[0].length, sourceBuffer.sampleRate)
    eqd.forEach((d, ch) => lpBuf.copyToChannel(d, ch))
    src.buffer = lpBuf
  } else {
    src.buffer = sourceBuffer
  }

  const graph = {
    ctx: off, params: { ...p, eqGains: [...p.eqGains] },
    bypassed: { ...byp, eq: byp.eq || linPhase },
    dynamicsAvailable: needDynWorklet,
    _makeSatCurve: engine._makeSatCurve,
  }
  buildProcessingGraph(graph, { metering: false })
  src.connect(graph.nodes.inputGain)
  src.start(0)

  return off.startRendering()
}

// Frequency grid for sampling a filter's response, 0..Nyquist over n+1 points.
// Clamped above 0Hz since a biquad's response is undefined there. Shared by
// every linear-phase EQ call site so single-track export and album per-track
// rendering sample the response the same way.
export function buildFreqGrid(nyquist, n) {
  const grid = new Float32Array(n + 1)
  for (let k = 0; k <= n; k++) grid[k] = Math.max(1, (k / n) * nyquist)
  return grid
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
