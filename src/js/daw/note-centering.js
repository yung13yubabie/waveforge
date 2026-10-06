import { frequencyToMidi, midiToFrequency, midiToNote, PITCH_ANALYSIS_INFO } from '../pitch/analysis.js'
import { SIGNALSMITH_LIMITS } from '../pitch/signalsmith-render.js'
import { getClipOriginalSource } from './project.js'
import { sourceFrameBounds } from './sample-bounds.js'

/** Conservative engineering gates, not calibrated singing accuracy or a
 * probability of monophony. A periodic mixture or a consistent octave error
 * can still pass. The caller must offer A/B review before accepting any render. */
export const NOTE_CENTERING_LIMITS = Object.freeze({
  minDurationSeconds: .35, maxDurationSeconds: SIGNALSMITH_LIMITS.maxDurationSeconds,
  minReliableFrames: 15, minPeriodicity: .95, minReliableFraction: .8,
  maxUnknownGapSeconds: .12, maxSpreadCents: 70, maxMadCents: 30,
  maxDriftCents: 25, maxOutlierCents: 100, octaveJumpCents: 600,
  modeGapCents: 25, minModeFraction: .1, maxSemitones: SIGNALSMITH_LIMITS.maxSemitones,
  maxFrames: 1501, maxStereoCenterDifferenceCents: 20, minRecommendedCorrectionCents: 10,
})

const MESSAGES = Object.freeze({
  'stale-source': '片段或分析來源已變更，請重新分析目前片段',
  'invalid-source': '請選取有效的 44.1／48／96 kHz 單聲道或立體聲片段',
  'too-short': '穩定單音分析至少需要 0.35 秒，請保留較長的單音',
  'too-long': '穩定單音移調含邊界樣本最多 30 秒，請先裁短片段',
  'invalid-analysis': '音高分析資料不完整或不符合目前片段，請重新分析',
  'no-reliable-pitch': '沒有足夠可靠的週期音高；靜音、噪音與無聲段不會補成音符',
  'insufficient-coverage': '可靠音高覆蓋不足，請選取更連續的單音片段',
  'interrupted-pitch': '音高估測有較長中斷，請先裁出連續的單音',
  'octave-jump': '音高有大幅或八度跳動，無法安全估計單一中心',
  'multiple-pitch-centers': '片段可能含多個音高中心，請先裁出一個穩定單音',
  'unstable-pitch': '音高分布過寬或有明顯離群，請改選較穩定的單音',
  'pitch-drift': '片段有明顯滑音或中心漂移，不適合整段固定移調',
  'invalid-target': '請選擇有效的整數 MIDI 參考音（0–127）',
  'invalid-transpose': '目前移調的原音連結或設定不完整，請先回到原音',
  'transpose-out-of-range': '加上目前已接受的移調後超過正負 2 半音，請改選參考音或回到原音',
  'stereo-pitch-disagreement': '左右聲道的音高中心不一致，請先選取單一聲部',
  'stereo-target-disagreement': '左右聲道的最近參考音不同，請手動選擇共同參考音後重新規劃',
})

const fail = (reason, diagnostics = {}) => ({
  ok: false, reason, message: MESSAGES[reason], centerMidi: null, centerHz: null,
  targetMidi: null, targetNote: null, correctionCents: null, totalSemitones: null,
  settings: null, renderSourceAssetId: null, renderOffsetSeconds: null,
  nearTarget: null, canRecommendRender: false, advisory: null, diagnostics,
})
const finite = Number.isFinite
const near = (a, b, tolerance = 1e-8) => finite(a) && finite(b) && Math.abs(a - b) <= tolerance
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 128
const quantile = (sorted, fraction) => {
  const position = (sorted.length - 1) * fraction, first = Math.floor(position), part = position - first
  return sorted[first] + (sorted[Math.min(first + 1, sorted.length - 1)] - sorted[first]) * part
}
const median = values => quantile([...values].sort((a, b) => a - b), .5)

function sameOwner(owner, current) {
  const fields = ['snapshot', 'trackId', 'clipId', 'sourceId', 'selectionVersion', 'sourceBuffer']
  return owner && current && owner.snapshot && typeof owner.snapshot === 'object' &&
    ['trackId', 'clipId', 'sourceId'].every(key => id(owner[key])) &&
    Number.isSafeInteger(owner.selectionVersion) && owner.selectionVersion >= 0 &&
    owner.sourceBuffer && fields.every(key => owner[key] === current[key]) &&
    (owner.channel ?? 0) === (current.channel ?? 0)
}

function acceptedSettings(clip, sampleRate, bufferLength) {
  const t = clip.transpose
  if (t === undefined) return { amount: 0, formantSemitones: 0, formantCompensation: false }
  if (!t || t.version !== 1 || t.engine !== SIGNALSMITH_LIMITS.engine ||
      !id(t.sourceAssetId) || t.sourceAssetId === clip.assetId ||
      !finite(t.sourceOffsetSeconds) || t.sourceOffsetSeconds < 0 ||
      !finite(t.sourceDurationSeconds) || t.sourceDurationSeconds <= 0 ||
      ![t.semitones, t.cents, t.formantSemitones].every(finite) ||
      Math.abs(t.semitones) > 2 || Math.abs(t.cents) > 100 ||
      Math.abs(t.semitones + t.cents / 100) > 2 || Math.abs(t.formantSemitones) > 2 ||
      typeof t.formantCompensation !== 'boolean') return null
  const bounds = sourceFrameBounds(t.sourceOffsetSeconds, t.sourceDurationSeconds, sampleRate)
  if (bounds.first !== t.cropFirstFrame || bounds.last !== t.cropLastFrame ||
      bounds.last - bounds.first !== bufferLength || bufferLength > sampleRate * NOTE_CENTERING_LIMITS.maxDurationSeconds ||
      clip.offsetSeconds < bounds.offsetSeconds - 1e-9 ||
      clip.offsetSeconds + clip.durationSeconds > bounds.offsetSeconds + t.sourceDurationSeconds + 1e-9) return null
  return { amount: t.semitones + t.cents / 100, formantSemitones: t.formantSemitones, formantCompensation: t.formantCompensation }
}

function proposal(center, target, targetSource, accepted, original, diagnostics, ownership) {
  const correctionCents = (target - center) * 100, exactTotal = accepted.amount + correctionCents / 100
  // Do not clamp an out-of-range request or round it inward to evade the bound.
  if (Math.abs(exactTotal) > NOTE_CENTERING_LIMITS.maxSemitones + 1e-10) return fail('transpose-out-of-range', diagnostics)
  const totalSemitones = Math.round(exactTotal * 10000) / 10000 || 0
  const semitones = Math.round(totalSemitones) || 0, cents = Math.round((totalSemitones - semitones) * 10000) / 100 || 0
  // Measured synthetic residuals can be several cents; a tiny proposed change
  // need not improve the sound. This is a processing advisory, not a claim that
  // the note is musically correct. Allow only numerical roundoff at the boundary.
  const nearTarget = Math.abs(correctionCents) < NOTE_CENTERING_LIMITS.minRecommendedCorrectionCents - 1e-8
  return {
    ok: true, reason: null, message: null, centerMidi: center, centerHz: midiToFrequency(center),
    targetMidi: target, targetNote: midiToNote(target), targetSource,
    correctionCents, totalSemitones, acceptedSemitones: accepted.amount,
    settings: { semitones, cents, formantSemitones: accepted.formantSemitones, formantCompensation: accepted.formantCompensation },
    renderSourceAssetId: original.assetId, renderOffsetSeconds: original.offsetSeconds, diagnostics,
    nearTarget, canRecommendRender: !nearTarget,
    advisory: nearTarget ? '中心與參考音相差不到 10 音分，建議先保留目前聲音；小幅處理未必改善聽感，也不代表音樂上正確或錯誤' : null,
    ownership, analyzedChannels: [ownership.channel],
  }
}

/**
 * Plan one CONSTANT transpose from an actual YIN result for the current audible
 * clip. Never repairs individual frames, removes vibrato, or judges a score.
 * `targetMidi` is an explicit integer reference; null proposes the nearest note.
 *
 * `owner` is captured BEFORE analysis; `currentOwner` is freshly captured AFTER:
 * { snapshot: project, trackId, clipId, sourceId: clip.assetId, selectionVersion,
 *   sourceBuffer: buffers.get(clip.assetId), channel?: 0 }.
 * Compare these again at every async rendering/Accept boundary in the caller.
 * The project is immutable. This function does not bind or authenticate worker
 * results itself: the analysis client must associate its result with this owner.
 *
 * Analyze the audible buffer using clip.offsetSeconds and durationSeconds. The
 * analyzer's sample-rounded crop, full frame grid and unknown gaps are checked;
 * a summary-only result, filtered contour or another clip's window is refused.
 * Existing clip.transpose describes an ALREADY ACCEPTED shift. The output is a
 * new total setting for retained original PCM, never a second pass on that take.
 * All inputs, PCM and metadata are borrowed read-only. Work is O(n log n), n<=1501.
 */
export function planNoteCentering(analysis, { clip, owner, currentOwner, targetMidi = null } = {}) {
  if (!sameOwner(owner, currentOwner) || clip?.id !== owner.clipId || clip?.assetId !== owner.sourceId) return fail('stale-source')
  const buffer = owner.sourceBuffer, rate = buffer.sampleRate, channel = owner.channel ?? 0
  if (!SIGNALSMITH_LIMITS.sampleRates.includes(rate) || !Number.isSafeInteger(buffer.length) || buffer.length < 1 ||
      ![1, 2].includes(buffer.numberOfChannels) || typeof buffer.getChannelData !== 'function' ||
      !Number.isInteger(channel) || channel < 0 || channel >= buffer.numberOfChannels ||
      !finite(clip.offsetSeconds) || clip.offsetSeconds < 0 || !finite(clip.durationSeconds) || clip.durationSeconds <= 0) return fail('invalid-source')
  if (clip.durationSeconds < NOTE_CENTERING_LIMITS.minDurationSeconds) return fail('too-short')
  if (clip.durationSeconds > NOTE_CENTERING_LIMITS.maxDurationSeconds + 1e-9) return fail('too-long')
  let bounds, accepted
  try {
    bounds = sourceFrameBounds(clip.offsetSeconds, clip.durationSeconds, rate)
    accepted = acceptedSettings(clip, rate, buffer.length)
  } catch { return fail('invalid-source') }
  if (bounds.last > buffer.length || bounds.first < 0) return fail('invalid-source')
  if (bounds.last - bounds.first > rate * NOTE_CENTERING_LIMITS.maxDurationSeconds) return fail('too-long')
  if (!accepted) return fail('invalid-transpose')
  if (targetMidi !== null && (!Number.isInteger(targetMidi) || targetMidi < 0 || targetMidi > 127)) return fail('invalid-target')

  // Match analysis-client copyWindow(), which rounds the first frame and floors
  // the selected length, distinct from render's covering sample bounds above.
  const first = Math.round(clip.offsetSeconds * rate)
  const length = Math.min(buffer.length - first, Math.floor(clip.durationSeconds * rate))
  const start = first / rate, duration = length / rate
  const factor = Math.max(1, Math.round(rate / 12000)), analysisRate = rate / factor
  const frameLength = Math.round(PITCH_ANALYSIS_INFO.frameDuration * analysisRate)
  const hopLength = Math.round(PITCH_ANALYSIS_INFO.hopDuration * analysisRate)
  const frameDuration = frameLength / analysisRate, hop = hopLength / analysisRate
  const count = Math.max(0, Math.floor((Math.ceil(length / factor) - frameLength) / hopLength) + 1)
  if (!analysis || analysis.engine !== PITCH_ANALYSIS_INFO.engine || analysis.version !== PITCH_ANALYSIS_INFO.version ||
      analysis.timestampOrigin !== 'source-buffer' || analysis.sampleRate !== rate ||
      !near(analysis.analysisSampleRate, analysisRate) || !near(analysis.start, start) || !near(analysis.duration, duration) ||
      !near(analysis.frameDuration, frameDuration) || !near(analysis.hopDuration, hop) ||
      (analysis.channel ?? 0) !== channel || (analysis.analyzedChannel ?? analysis.channel ?? 0) !== channel ||
      !Array.isArray(analysis.frames) || analysis.frames.length !== count || count > NOTE_CENTERING_LIMITS.maxFrames) return fail('invalid-analysis')

  const reliable = [], periodicities = [], voicedMidi = []
  let gap = 0, longestGap = 0, voicedFrames = 0
  for (let i = 0; i < count; i++) {
    const frame = analysis.frames[i]
    if (!frame || !near(frame.time, start + (i * hopLength + frameLength / 2) / analysisRate) ||
        !['voiced', 'uncertain', 'unvoiced'].includes(frame.state) || !finite(frame.confidence) || frame.confidence < 0 || frame.confidence > 1 ||
        !finite(frame.rms) || frame.rms < 0) return fail('invalid-analysis')
    if (frame.state === 'voiced') {
      if (!finite(frame.frequencyHz) || frame.frequencyHz < PITCH_ANALYSIS_INFO.minFrequencyHz || frame.frequencyHz > PITCH_ANALYSIS_INFO.maxFrequencyHz ||
          !near(frame.midi, frequencyToMidi(frame.frequencyHz), 1e-6) || !near(frame.cents, (frame.midi - Math.round(frame.midi)) * 100, 1e-4) ||
          frame.note !== midiToNote(frame.midi)) return fail('invalid-analysis')
      voicedFrames++
      voicedMidi.push(frame.midi)
    } else if (frame.frequencyHz !== null || frame.midi !== null || frame.cents !== null || frame.note !== null) return fail('invalid-analysis')
    if (frame.state === 'voiced' && frame.confidence >= NOTE_CENTERING_LIMITS.minPeriodicity && frame.rms >= .001) {
      reliable.push({ midi: frame.midi, index: i }); periodicities.push(frame.confidence); gap = 0
    } else { gap++; longestGap = Math.max(longestGap, gap) }
  }
  const diagnostics = {
    frameCount: count, voicedFrames, reliableFrames: reliable.length,
    reliableFraction: count ? reliable.length / count : 0,
    medianPeriodicity: periodicities.length ? median(periodicities) : null,
    longestUnknownGapSeconds: longestGap * hop,
  }
  if (reliable.length < NOTE_CENTERING_LIMITS.minReliableFrames) return fail('no-reliable-pitch', diagnostics)
  if (diagnostics.reliableFraction < NOTE_CENTERING_LIMITS.minReliableFraction) return fail('insufficient-coverage', diagnostics)
  if (diagnostics.longestUnknownGapSeconds > NOTE_CENTERING_LIMITS.maxUnknownGapSeconds + 1e-8) return fail('interrupted-pitch', diagnostics)

  // A still-voiced estimate just below the stricter .95 center threshold must
  // not let an octave jump disappear as if it were an ordinary unknown gap.
  diagnostics.voicedRangeCents = (Math.max(...voicedMidi) - Math.min(...voicedMidi)) * 100
  if (diagnostics.voicedRangeCents >= NOTE_CENTERING_LIMITS.octaveJumpCents) return fail('octave-jump', diagnostics)

  const sorted = reliable.map(frame => frame.midi).sort((a, b) => a - b)
  const center = quantile(sorted, .5)
  const residuals = sorted.map(value => Math.abs(value - center) * 100).sort((a, b) => a - b)
  Object.assign(diagnostics, {
    spreadCents: (quantile(sorted, .9) - quantile(sorted, .1)) * 100,
    madCents: quantile(residuals, .5), maxDeviationCents: residuals.at(-1),
    rangeCents: (sorted.at(-1) - sorted[0]) * 100,
  })
  if (diagnostics.rangeCents >= NOTE_CENTERING_LIMITS.octaveJumpCents) return fail('octave-jump', diagnostics)
  // A median alone can land between two notes. Refuse separated clusters even
  // when their combined spread happens to fit the single-note spread limit.
  const minMode = Math.max(3, Math.ceil(reliable.length * NOTE_CENTERING_LIMITS.minModeFraction))
  for (let i = minMode; i <= sorted.length - minMode; i++) {
    if ((sorted[i] - sorted[i - 1]) * 100 >= NOTE_CENTERING_LIMITS.modeGapCents) return fail('multiple-pitch-centers', diagnostics)
  }
  if (diagnostics.spreadCents > NOTE_CENTERING_LIMITS.maxSpreadCents || diagnostics.madCents > NOTE_CENTERING_LIMITS.maxMadCents ||
      diagnostics.maxDeviationCents > NOTE_CENTERING_LIMITS.maxOutlierCents) return fail('unstable-pitch', diagnostics)
  // Temporal quarters catch an otherwise narrow monotonic glide. The coverage
  // and gap checks above ensure these quarters cannot hide large unknown tails.
  const firstQuarter = reliable.filter(frame => frame.index < count / 4).map(frame => frame.midi)
  const lastQuarter = reliable.filter(frame => frame.index >= count * .75).map(frame => frame.midi)
  if (!firstQuarter.length || !lastQuarter.length) return fail('insufficient-coverage', diagnostics)
  diagnostics.driftCents = (median(lastQuarter) - median(firstQuarter)) * 100
  if (Math.abs(diagnostics.driftCents) > NOTE_CENTERING_LIMITS.maxDriftCents) return fail('pitch-drift', diagnostics)

  const target = targetMidi ?? Math.round(center)
  const original = getClipOriginalSource(clip, rate)
  const ownership = { snapshot: owner.snapshot, trackId: owner.trackId, clipId: owner.clipId, sourceId: owner.sourceId,
    selectionVersion: owner.selectionVersion, sourceBuffer: buffer, channel, start, duration }
  return proposal(center, target, targetMidi === null ? 'nearest-reference' : 'user-reference', accepted, original, diagnostics, ownership)
}

/** Both channels are processed together by the renderer, so stereo requires two
 * independently acceptable, agreeing analyses. Silent/unreliable channels are
 * conservatively refused. This guard still cannot prove source isolation.
 * Mono callers can also pass their single plan here. */
export function combineNoteCenteringPlans(plans) {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 2) return fail('invalid-analysis')
  for (const plan of plans) {
    if (!plan?.ok) return plan?.reason && MESSAGES[plan.reason] ? plan : fail('invalid-analysis')
    if (plan.ok !== true || !sameOwner(plan.ownership, plan.ownership) || !finite(plan.centerMidi) ||
        !Number.isInteger(plan.targetMidi) || !finite(plan.acceptedSemitones) || !plan.settings ||
        ![1, 2].includes(plan.ownership.sourceBuffer.numberOfChannels)) return fail('invalid-analysis')
  }
  const left = plans.find(plan => plan.ownership?.channel === 0), right = plans.find(plan => plan.ownership?.channel === 1)
  if (!left || plans.length !== left.ownership.sourceBuffer.numberOfChannels) return fail('invalid-analysis')
  if (plans.length === 1) return left
  if (!right || !sameOwner({ ...left.ownership, channel: 0 }, { ...right.ownership, channel: 0 }) ||
      left.ownership.start !== right.ownership.start || left.ownership.duration !== right.ownership.duration ||
      left.renderSourceAssetId !== right.renderSourceAssetId || left.renderOffsetSeconds !== right.renderOffsetSeconds ||
      left.acceptedSemitones !== right.acceptedSemitones || left.settings.formantSemitones !== right.settings.formantSemitones ||
      left.settings.formantCompensation !== right.settings.formantCompensation) return fail('stale-source')
  const difference = Math.abs(left.centerMidi - right.centerMidi) * 100
  const diagnostics = { channelDiagnostics: [left.diagnostics, right.diagnostics], centerDifferenceCents: difference }
  if (!finite(difference) || difference > NOTE_CENTERING_LIMITS.maxStereoCenterDifferenceCents) return fail('stereo-pitch-disagreement', diagnostics)
  if (left.targetMidi !== right.targetMidi || left.targetSource !== right.targetSource) return fail('stereo-target-disagreement', diagnostics)
  const combined = proposal((left.centerMidi + right.centerMidi) / 2, left.targetMidi, left.targetSource,
    { amount: left.acceptedSemitones, formantSemitones: left.settings.formantSemitones, formantCompensation: left.settings.formantCompensation },
    { assetId: left.renderSourceAssetId, offsetSeconds: left.renderOffsetSeconds }, diagnostics, left.ownership)
  return combined.ok ? { ...combined, analyzedChannels: [0, 1] } : combined
}
