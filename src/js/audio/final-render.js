import { renderMasterChain, buildFreqGrid, eqMagnitudeFromParams } from './render-chain.js'
import { embedWatermark } from './watermark.js'
import { truePeakLimit } from './true-peak-limiter.js'
import { buildExportReport } from './measure.js'

// Snapshot-based final chain shared by download, final preview and album tracks.
export async function renderFinalMaster({ engine, sourceBuffer, snapshot, sampleRate,
  linearPhase = false, watermark = '', truePeak = false, targetLUFS = null, dynamicsWorkletUrl }) {
  const { params, bypassed } = structuredClone(snapshot)
  const linPhaseMag = linearPhase && !bypassed.eq
    ? eqMagnitudeFromParams(engine, params.eqGains, buildFreqGrid(sampleRate / 2, 2048), sampleRate)
    : null
  const buffer = await renderMasterChain({ engine, sourceBuffer, params, bypassed,
    sampleRate, linPhaseMag, dynamicsWorkletUrl })
  let channels = Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch))
  if (watermark) channels = embedWatermark(channels, sampleRate, watermark)
  const limited = truePeak && !bypassed.limiter
  if (limited) channels = truePeakLimit(channels, sampleRate, params.limCeiling)
  channels.forEach((data, ch) => buffer.copyToChannel(data, ch))
  const report = { ...buildExportReport(channels, sampleRate, {
    targetLUFS, ceilingDb: bypassed.limiter ? 0 : params.limCeiling,
  }), sampleRate, duration: buffer.duration, linearPhase: !!linPhaseMag,
  watermark: !!watermark, truePeakLimiter: limited,
  sourcePCMRate: sourceBuffer.sampleRate, rendererBackend: 'native-web-audio',
  sampleRateConverter: sourceBuffer.sampleRate === sampleRate ? 'none' : 'browser-native' }
  return { buffer, channels, report }
}
