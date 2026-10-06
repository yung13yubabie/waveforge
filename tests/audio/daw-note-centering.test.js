// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { combineNoteCenteringPlans, NOTE_CENTERING_LIMITS, planNoteCentering } from '../../src/js/daw/note-centering.js'
import { analyzePitch, describePitch } from '../../src/js/pitch/analysis.js'
import { fakeAudioBuffer, seededNoise, tone } from './pitch-analysis-fixtures.js'

// Independent, explicit 48kHz contour fixtures exercise planner decisions. These
// are synthetic test inputs, never a production F0 fallback or accuracy claim.
function fixture({ duration = 1, start = 0, cents = () => 23, channels = 1 } = {}) {
  const buffer = { sampleRate: 48000, length: Math.round((start + duration) * 48000), numberOfChannels: channels,
    getChannelData() { throw new Error('The planner must not read or modify PCM') } }
  const clip = { id: 'clip', assetId: 'audio', offsetSeconds: start, durationSeconds: duration }
  const owner = { snapshot: {}, trackId: 'track', clipId: clip.id, sourceId: clip.assetId, selectionVersion: 2, sourceBuffer: buffer }
  const count = Math.max(0, Math.floor((duration - .064 + 1e-12) / .02) + 1)
  const analysis = {
    engine: 'waveforge-monophonic-yin', version: 1, sampleRate: 48000, analysisSampleRate: 12000,
    start, duration, frameDuration: .064, hopDuration: .02, timestampOrigin: 'source-buffer',
    frames: Array.from({ length: count }, (_, i) => ({
      time: start + .032 + i * .02, state: 'voiced', ...describePitch(440 * 2 ** (cents(i, count) / 1200)),
      confidence: .99, rms: .2, reason: null,
    })),
  }
  const options = { clip, owner, currentOwner: { ...owner } }
  return { analysis, options, clip, owner, buffer }
}
function unknown(frame, state = 'unvoiced') {
  Object.assign(frame, { state, frequencyHz: null, midi: null, note: null, cents: null, referenceCents: null,
    confidence: state === 'unvoiced' ? 0 : .93, reason: 'low-periodicity' })
}
const plan = fixture => planNoteCentering(fixture.analysis, fixture.options)
const rejected = (result, reason) => {
  expect(result).toMatchObject({ ok: false, reason, centerMidi: null, centerHz: null, targetMidi: null, correctionCents: null, settings: null })
  expect(result.message).toBeTruthy()
}

describe('bounded robust single-note center proposals', () => {
  it.each([-37, 23, 43])('finds a %+i-cent center without quantizing input frames', cents => {
    const input = fixture({ cents: i => cents + ((i % 3) - 1) * 2 })
    const result = plan(input)
    expect(result.ok).toBe(true)
    expect(result.centerMidi).toBeCloseTo(69 + cents / 100, 9)
    expect(result.centerHz).toBeCloseTo(440 * 2 ** (cents / 1200), 8)
    expect(result).toMatchObject({ targetMidi: 69, targetNote: 'A4', targetSource: 'nearest-reference',
      settings: { semitones: 0, cents: -cents, formantSemitones: 0, formantCompensation: false }, renderSourceAssetId: 'audio', renderOffsetSeconds: 0 })
    expect(result.correctionCents).toBeCloseTo(-cents, 9)
    expect(result.diagnostics.medianPeriodicity).toBe(.99)
  })
  it('uses an explicit target as a reference without claiming score correctness', () => {
    const input = fixture(); input.options.targetMidi = 70
    const result = plan(input)
    expect(result).toMatchObject({ ok: true, targetMidi: 70, targetSource: 'user-reference', totalSemitones: .77,
      settings: { semitones: 1, cents: -23 } })
    for (const field of ['correctness', 'key', 'probability', 'vibratoRemoved']) expect(result).not.toHaveProperty(field)
  })
  it.each([-10, -9.99, -3, 0, 3, 9.99, 10])('keeps the center readable and advises about a %+s-cent small correction', cents => {
    const result = plan(fixture({ cents: () => cents })), nearTarget = Math.abs(cents) < 10
    expect(result).toMatchObject({ ok: true, nearTarget, canRecommendRender: !nearTarget, targetMidi: 69 })
    expect(result.centerMidi).toBeCloseTo(69 + cents / 100, 9)
    expect(Boolean(result.advisory)).toBe(nearTarget)
  })
  it('uses the measured median even when summary metadata contains a misleading pitch', () => {
    const input = fixture(); input.analysis.summary = { medianMidi: 50, medianFrequencyHz: 146.832, voicedFraction: 0 }
    expect(plan(input).centerMidi).toBeCloseTo(69.23, 9)
  })
  it('is deterministic and never changes the input analysis, clip, ownership or original audio', async () => {
    const samples = tone({ duration: .8, frequency: 440 * 2 ** (23 / 1200) }), beforePcm = samples.slice()
    const input = fixture({ duration: .8 }); input.owner.sourceBuffer = fakeAudioBuffer([samples])
    input.options.currentOwner = { ...input.owner }
    input.analysis = await analyzePitch(samples, 48000)
    const before = JSON.stringify({ analysis: input.analysis, clip: input.clip, owner: input.owner })
    const first = plan(input), second = plan(input)
    expect(first.ok).toBe(true); expect(second).toEqual(first)
    expect(JSON.stringify({ analysis: input.analysis, clip: input.clip, owner: input.owner })).toBe(before)
    expect(samples).toEqual(beforePcm)
  })
  it('accepts narrow periodic modulation as one center without making a vibrato-preservation claim', () => {
    const input = fixture({ duration: 2, cents: i => 23 + 25 * Math.sin(2 * Math.PI * 5 * (.032 + i * .02)) })
    const result = plan(input)
    expect(result.ok).toBe(true); expect(Math.abs(result.centerMidi - 69.23)).toBeLessThan(.1)
    expect(result.diagnostics.spreadCents).toBeGreaterThan(40)
  })
  it('allows a few unknown frames without fabricating their pitch', () => {
    const input = fixture()
    for (const i of [2, 8, 19, 35]) unknown(input.analysis.frames[i])
    const result = plan(input)
    expect(result.ok).toBe(true); expect(result.diagnostics.reliableFrames).toBe(43)
    for (const i of [2, 8, 19, 35]) expect(input.analysis.frames[i].midi).toBeNull()
  })
  it('rejects silence, deterministic noise, and insufficient periodicity using actual YIN results', async () => {
    for (const samples of [new Float32Array(48000), seededNoise({ duration: 1 })]) {
      const input = fixture(); input.analysis = await analyzePitch(samples, 48000)
      rejected(plan(input), 'no-reliable-pitch')
    }
    const input = fixture(); input.analysis.frames.forEach(frame => { frame.confidence = .949 })
    rejected(plan(input), 'no-reliable-pitch')
  })
  it('accepts an actually analyzed harmonic-rich single tone', async () => {
    const input = fixture({ duration: .8 })
    input.analysis = await analyzePitch(tone({ duration: .8, frequency: 220 * 2 ** (-37 / 1200), harmonics: [.35, .8, .4, .15] }), 48000)
    const result = plan(input)
    expect(result.ok).toBe(true); expect(result.targetMidi).toBe(57)
    expect(result.correctionCents).toBeCloseTo(37, 0)
  })
  it('rejects too little duration, unreliable coverage, and a long central gap', () => {
    rejected(plan(fixture({ duration: .3 })), 'too-short')
    const sparse = fixture(); sparse.analysis.frames.forEach((frame, i) => { if (i % 3 === 0) unknown(frame) })
    rejected(plan(sparse), 'insufficient-coverage')
    const gap = fixture({ duration: 2 }); gap.analysis.frames.slice(35, 43).forEach(frame => unknown(frame))
    rejected(plan(gap), 'interrupted-pitch')
  })
  it.each([
    ['octave-jump', i => i < 25 ? 23 : 1223],
    ['multiple-pitch-centers', i => i < 25 ? -20 : 20],
    ['multiple-pitch-centers', i => i < 25 ? 23 : 223],
    ['pitch-drift', (i, n) => -20 + 40 * i / (n - 1)],
    ['unstable-pitch', i => 23 + 65 * Math.sin(i * .37)],
    ['unstable-pitch', i => i === 25 ? 150 : 23],
  ])('rejects %s instead of centering incompatible pitch motion', (reason, cents) => rejected(plan(fixture({ cents })), reason))
  it('does not discard still-voiced octave errors just below the center periodicity threshold', () => {
    const input = fixture({ cents: i => i >= 20 && i < 23 ? 1223 : 23 })
    input.analysis.frames.slice(20, 23).forEach(frame => { frame.confidence = .94 })
    rejected(plan(input), 'octave-jump')
  })
  it('refuses the 30-second boundary when a fractional crop adds a sample', () => {
    const input = fixture({ duration: 30, start: .5 / 48000 }); input.buffer.length++
    rejected(plan(input), 'too-long')
    rejected(plan(fixture({ duration: 30.01 })), 'too-long')
    expect(plan(fixture({ duration: 30 })).ok).toBe(true)
  })
})

describe('source binding and complete actual analysis validation', () => {
  it.each(['snapshot', 'trackId', 'clipId', 'sourceId', 'selectionVersion', 'sourceBuffer'])('rejects stale %s ownership', field => {
    const input = fixture(); input.options.currentOwner[field] = field === 'selectionVersion' ? 3 : {}
    rejected(plan(input), 'stale-source')
  })
  it('rejects missing ownership or a clip from a different source', () => {
    const input = fixture(); delete input.options.currentOwner
    rejected(plan(input), 'stale-source')
    const other = fixture(); other.clip.assetId = 'different'
    rejected(plan(other), 'stale-source')
  })
  it.each([
    a => { a.engine = 'invented' }, a => { a.version = 2 }, a => { a.sampleRate = 44100 },
    a => { a.start += .02 }, a => { a.duration -= .02 }, a => { a.timestampOrigin = 'timeline' },
    a => { a.hopDuration = .04 }, a => { a.analysisSampleRate = 8000 }, a => { a.channel = 1 },
    a => { a.frames.pop() }, a => { a.frames[2].time = a.frames[1].time },
    a => { a.frames[2].midi = 12 }, a => { a.frames[2].frequencyHz = NaN },
    a => { a.frames[2].confidence = 1.1 }, a => { a.frames[2].rms = Infinity },
    a => { unknown(a.frames[2]); a.frames[2].midi = 69 },
  ])('rejects malformed, filtered, stale or fabricated pitch fields', mutate => {
    const input = fixture(); mutate(input.analysis)
    rejected(plan(input), 'invalid-analysis')
  })
  it.each([NaN, Infinity, -1, 128, 69.5, '69'])('rejects invalid target %s without coercion', targetMidi => {
    const input = fixture(); input.options.targetMidi = targetMidi
    rejected(plan(input), 'invalid-target')
  })
  it.each([44100, 96000])('checks the native %i Hz analyzer frame grid', async rate => {
    const samples = tone({ sampleRate: rate, duration: .8, frequency: 440 * 2 ** (23 / 1200) })
    const input = fixture({ duration: .8 }); input.owner.sourceBuffer = fakeAudioBuffer([samples], rate)
    input.options.currentOwner = { ...input.owner }; input.analysis = await analyzePitch(samples, rate)
    expect(plan(input).ok).toBe(true)
  })
})

describe('total transpose from retained original audio', () => {
  function accepted(cents = 23, amount = 1) {
    const input = fixture({ cents: () => cents })
    input.clip.transpose = { version: 1, engine: 'signalsmith-stretch-1.3.2', sourceAssetId: 'original',
      sourceOffsetSeconds: 2.125, sourceDurationSeconds: 1, cropFirstFrame: 102000, cropLastFrame: 150000,
      semitones: amount, cents: 0, formantSemitones: -.5, formantCompensation: true }
    return input
  }
  it('adds the audible correction to the accepted setting and maps back to original PCM once', () => {
    const input = accepted(), result = plan(input)
    expect(result).toMatchObject({ ok: true, acceptedSemitones: 1, totalSemitones: .77,
      settings: { semitones: 1, cents: -23, formantSemitones: -.5, formantCompensation: true },
      renderSourceAssetId: 'original', renderOffsetSeconds: 2.125 })
    expect(result.correctionCents).toBeCloseTo(-23, 9)
  })
  it('maps a trimmed accepted take back to the corresponding original interval', () => {
    const input = accepted(), cropped = fixture({ start: .2, duration: .6 })
    input.clip.offsetSeconds = .2; input.clip.durationSeconds = .6; input.analysis = cropped.analysis
    const result = plan(input)
    expect(result.ok).toBe(true); expect(result.renderOffsetSeconds).toBeCloseTo(2.325, 10)
  })
  it('permits exactly ±2 semitones but refuses larger total shifts rather than clamping', () => {
    for (const amount of [-2, 2]) {
      const input = accepted(0, amount); expect(plan(input).totalSemitones).toBe(amount)
      const over = accepted(amount > 0 ? -1 : 1, amount); rejected(plan(over), 'transpose-out-of-range')
    }
    const input = fixture(); input.options.targetMidi = 72; rejected(plan(input), 'transpose-out-of-range')
    const nearBound = accepted(-.0001, 2); rejected(plan(nearBound), 'transpose-out-of-range')
  })
  it.each([
    t => { t.version = 2 }, t => { t.sourceAssetId = 'audio' }, t => { t.cropFirstFrame++ },
    t => { t.cents = 101 }, t => { t.semitones = 2.1 }, t => { t.formantCompensation = 'yes' },
  ])('rejects invalid accepted lineage/settings', mutate => {
    const input = accepted(); mutate(input.clip.transpose); rejected(plan(input), 'invalid-transpose')
  })
})

describe('stereo agreement is required before a shared transpose', () => {
  function stereo(leftCents, rightCents, targetMidi = null) {
    const left = fixture({ channels: 2, cents: () => leftCents }), right = fixture({ channels: 2, cents: () => rightCents })
    right.owner = { ...left.owner, channel: 1 }; right.options = { clip: left.clip, owner: right.owner, currentOwner: { ...right.owner }, targetMidi }
    right.analysis.channel = 1; right.analysis.analyzedChannel = 1; left.options.targetMidi = targetMidi
    return [left, right]
  }
  it('centers two agreeing channels with one constant setting', () => {
    const inputs = stereo(20, 30), plans = inputs.map(plan), result = combineNoteCenteringPlans(plans)
    expect(result).toMatchObject({ ok: true, totalSemitones: -.25, settings: { cents: -25 }, analyzedChannels: [0, 1] })
    expect(result.centerMidi).toBeCloseTo(69.25, 9)
    expect(combineNoteCenteringPlans([...plans].reverse())).toEqual(result)
  })
  it('computes the small-correction advisory again for the combined stereo center', () => {
    expect(combineNoteCenteringPlans(stereo(0, 12).map(plan))).toMatchObject({ ok: true, nearTarget: true, canRecommendRender: false })
    expect(combineNoteCenteringPlans(stereo(9, 11).map(plan))).toMatchObject({ ok: true, nearTarget: false, canRecommendRender: true })
  })
  it('rejects a different note in the other channel or a silent channel', () => {
    rejected(combineNoteCenteringPlans(stereo(23, 123).map(plan)), 'stereo-pitch-disagreement')
    const inputs = stereo(23, 23); inputs[1].analysis.frames.forEach(frame => unknown(frame))
    rejected(combineNoteCenteringPlans(inputs.map(plan)), 'no-reliable-pitch')
  })
  it('requires an explicit common reference when nearest notes straddle a rounding boundary', () => {
    rejected(combineNoteCenteringPlans(stereo(45, 55).map(plan)), 'stereo-target-disagreement')
    expect(combineNoteCenteringPlans(stereo(45, 55, 69).map(plan)).totalSemitones).toBe(-.5)
  })
  it('rejects missing, repeated or unrelated channel plans; permits mono', () => {
    const inputs = stereo(23, 23), plans = inputs.map(plan)
    rejected(combineNoteCenteringPlans([plans[0]]), 'invalid-analysis')
    rejected(combineNoteCenteringPlans([plans[0], plans[0]]), 'stale-source')
    inputs[1].owner.snapshot = {}; inputs[1].options.currentOwner = { ...inputs[1].owner }
    rejected(combineNoteCenteringPlans([plans[0], plan(inputs[1])]), 'stale-source')
    const mono = plan(fixture()); expect(combineNoteCenteringPlans([mono])).toBe(mono)
  })
  it.each([null, [], [null], [undefined], [{}], [{ ok: true }]])('returns a refusal for malformed plan sets without throwing', input => {
    rejected(combineNoteCenteringPlans(input), 'invalid-analysis')
  })
  it('documents bounded gates and no universal monophony or correctness guarantee', () => {
    expect(NOTE_CENTERING_LIMITS).toMatchObject({ minReliableFrames: 15, minPeriodicity: .95, maxSemitones: 2, maxFrames: 1501 })
    expect(Object.isFrozen(NOTE_CENTERING_LIMITS)).toBe(true)
  })
})
