/**
 * Per-stem DSP and mixdown.
 *
 * Pure audio work: no DOM, no network. Each stem runs through a 3-band EQ and
 * a compressor, then all stems sum without implicit gain changes.
 */

const LOW_SHELF_HZ = 200
const MID_PEAK_HZ = 1000
const MID_Q = 0.7
const HIGH_SHELF_HZ = 8000
const COMP_KNEE_DB = 6
const COMP_ATTACK_SEC = 0.003
const COMP_RELEASE_SEC = 0.25

/**
 * Process one stem buffer through EQ + dynamics compression.
 * @param {AudioBuffer|null} buffer
 * @param {{lowGain:number, midGain:number, highGain:number, thresh:number, ratio:number}} params
 * @param {number} volume
 * @returns {Promise<AudioBuffer|null>}
 */
export async function processStem(buffer, params, volume) {
  if (!buffer) return null
  const ctx = new OfflineAudioContext(2, buffer.length, buffer.sampleRate)
  const src = ctx.createBufferSource(); src.buffer = buffer
  const graph = createStemGraph(ctx, params, volume)
  src.connect(graph.input); graph.output.connect(ctx.destination); src.start()
  return ctx.startRendering()
}

export function createStemGraph(ctx, params, volume = 1) {
  const { lowGain, midGain, highGain, thresh, ratio } = params
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'; low.frequency.value = LOW_SHELF_HZ; low.gain.value = lowGain

  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'; mid.frequency.value = MID_PEAK_HZ; mid.Q.value = MID_Q; mid.gain.value = midGain

  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'; high.frequency.value = HIGH_SHELF_HZ; high.gain.value = highGain

  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = thresh
  comp.ratio.value = ratio
  comp.knee.value = COMP_KNEE_DB
  comp.attack.value = COMP_ATTACK_SEC
  comp.release.value = COMP_RELEASE_SEC

  const gain = ctx.createGain()
  gain.gain.value = volume
  const pan = ctx.createStereoPanner()
  pan.pan.value = params.pan ?? 0
  const input = ctx.createGain()
  let eqEnabled, compEnabled
  function route(p) {
    const eq = p.eqEnabled === true, dynamics = p.compEnabled === true
    if (eq === eqEnabled && dynamics === compEnabled) return
    eqEnabled = eq; compEnabled = dynamics
    input.disconnect(); high.disconnect(); comp.disconnect()
    let tail = input
    if (eq) { tail.connect(low); tail = high }
    if (dynamics) { tail.connect(comp); tail = comp }
    tail.connect(pan)
  }

  low.connect(mid)
  mid.connect(high)
  pan.connect(gain)
  route(params)
  return { input, output: gain, low, mid, high, comp, gain, pan,
    update(p, v) {
      route(p)
      const t = ctx.currentTime
      for (const [param, value] of [[low.gain, p.lowGain], [mid.gain, p.midGain], [high.gain, p.highGain],
        [comp.threshold, p.thresh], [comp.ratio, p.ratio], [pan.pan, p.pan ?? 0], [gain.gain, v]]) {
        if (!Number.isFinite(value)) throw new Error('分軌參數必須是有效數值')
        param.setTargetAtTime(value, t, 0.01)
      }
    },
    disconnect() { [input, low, mid, high, comp, pan, gain].forEach(n => n.disconnect()) },
  }
}

/**
 * Sum processed stems, preserving floating-point overload for explicit user correction.
 * @param {(AudioBuffer|null)[]} buffers
 * @returns {AudioBuffer|null} null when there is nothing to mix
 */
export function mixBuffers(buffers) {
  const valid = buffers.filter(Boolean)
  if (!valid.length) return null

  const ch = valid[0].numberOfChannels
  const len = Math.max(...valid.map(b => b.length))
  const sr = valid[0].sampleRate

  if (valid.some(b => b.sampleRate !== sr || b.numberOfChannels !== ch)) throw new Error('分軌採樣率與聲道數必須一致')

  const mixed = Array.from({ length: ch }, () => new Float32Array(len))

  for (const buf of valid) {
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c)
      const dest = mixed[c]
      for (let i = 0; i < data.length; i++) dest[i] += data[i]
    }
  }

  // Build output AudioBuffer using OfflineAudioContext (broadest compat)
  const tmpCtx = new OfflineAudioContext(ch, len, sr)
  const out = tmpCtx.createBuffer(ch, len, sr)
  for (let c = 0; c < ch; c++) out.copyToChannel(mixed[c], c)
  return out
}

export function bufferPeak(buffer) {
  let peak = 0
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) for (const x of buffer.getChannelData(ch)) peak = Math.max(peak, Math.abs(x))
  return peak
}

// Explicit opt-in command, never called automatically by mixBuffers.
export function normalizeBuffer(buffer, target = 0.99) {
  const peak = bufferPeak(buffer)
  const out = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
    .createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    out.copyToChannel(buffer.getChannelData(ch).map(x => peak > 0 ? x * target / peak : x), ch)
  }
  return out
}
