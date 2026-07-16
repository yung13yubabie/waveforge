/**
 * Per-stem DSP and mixdown.
 *
 * Pure audio work: no DOM, no network. Each stem runs through a 3-band EQ and
 * a compressor, then all stems sum into one peak-normalized buffer.
 */

const LOW_SHELF_HZ = 200
const MID_PEAK_HZ = 1000
const MID_Q = 0.7
const HIGH_SHELF_HZ = 8000
const COMP_KNEE_DB = 6
const COMP_ATTACK_SEC = 0.003
const COMP_RELEASE_SEC = 0.25

// Leave the mix alone until it is close enough to full scale to clip.
const NORMALIZE_ABOVE_PEAK = 0.99

/**
 * Process one stem buffer through EQ + dynamics compression.
 * @param {AudioBuffer|null} buffer
 * @param {{lowGain:number, midGain:number, highGain:number, thresh:number, ratio:number}} params
 * @param {number} volume
 * @returns {Promise<AudioBuffer|null>}
 */
export async function processStem(buffer, params, volume) {
  if (!buffer) return null
  const { lowGain, midGain, highGain, thresh, ratio } = params
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  )

  const src = ctx.createBufferSource()
  src.buffer = buffer

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

  src.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(comp)
  comp.connect(gain)
  gain.connect(ctx.destination)
  src.start()

  return ctx.startRendering()
}

/**
 * Sum all processed stem buffers and peak-normalize.
 * @param {(AudioBuffer|null)[]} buffers
 * @returns {AudioBuffer|null} null when there is nothing to mix
 */
export function mixBuffers(buffers) {
  const valid = buffers.filter(Boolean)
  if (!valid.length) return null

  const ch = valid[0].numberOfChannels
  const len = Math.max(...valid.map(b => b.length))
  const sr = valid[0].sampleRate

  const mixed = Array.from({ length: ch }, () => new Float32Array(len))

  for (const buf of valid) {
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c)
      const dest = mixed[c]
      for (let i = 0; i < data.length; i++) dest[i] += data[i]
    }
  }

  let peak = 0
  for (const chan of mixed) for (const s of chan) if (Math.abs(s) > peak) peak = Math.abs(s)
  if (peak > NORMALIZE_ABOVE_PEAK) for (const chan of mixed) for (let i = 0; i < chan.length; i++) chan[i] /= peak

  // Build output AudioBuffer using OfflineAudioContext (broadest compat)
  const tmpCtx = new OfflineAudioContext(ch, len, sr)
  const out = tmpCtx.createBuffer(ch, len, sr)
  for (let c = 0; c < ch; c++) out.copyToChannel(mixed[c], c)
  return out
}
