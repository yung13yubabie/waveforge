// Run: node scripts/test-note-centering.mjs [--cc0]
// Local Node diagnostics using the actual YIN planner and vendored Signalsmith.
// No browser/audio-listening validation, network, model, or dependency install.
import { fileURLToPath } from 'node:url'
import { analyzePitch, midiToFrequency } from '../src/js/pitch/analysis.js'
import { renderSignalsmithPitch } from '../src/js/pitch/signalsmith-render.js'
import { noise, periodicFrequency, peak, rms, centsError } from '../tests/audio/pitch-shift-fixtures.js'

export function quantile(values, fraction) {
  if (!values.length) return null
  const sorted = values.slice().sort((a, b) => a - b)
  const at = fraction * (sorted.length - 1), low = Math.floor(at)
  return sorted[low] + (sorted[Math.ceil(at)] - sorted[low]) * (at - low)
}

function statistics(values) {
  return {
    count: values.length, median: quantile(values, 0.5),
    p95Abs: quantile(values.map(Math.abs), 0.95),
    maxAbs: values.length ? Math.max(...values.map(Math.abs)) : null,
  }
}

// Deterministic integrated-phase oscillator. AM and vibrato are independent.
// Same-F0 stereo changes harmonic weights, phase, level, and AM per channel.
export function generateNote({
  sampleRate = 48000, seconds = 1.2, targetMidi = 57, detuneCents = 37,
  vibratoCents = 0, vibratoHz = 5, modulationDepth = 0, modulationHz = 7,
  phase = 0, amplitude = 0.32, harmonics = [1, 0.4, 0.2, 0.1],
  glideCents = 0, stepCents = 0, gap = null,
} = {}) {
  const samples = new Float32Array(Math.round(sampleRate * seconds))
  const baseHz = midiToFrequency(targetMidi)
  const divisor = harmonics.reduce((sum, value) => sum + Math.abs(value), 0)
  let angle = phase
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate
    const cents = detuneCents + vibratoCents * Math.sin(2 * Math.PI * vibratoHz * t)
      + glideCents * (t / seconds - 0.5) + (t >= seconds / 2 ? stepCents : 0)
    angle += 2 * Math.PI * baseHz * 2 ** (cents / 1200) / sampleRate
    const envelope = (1 - modulationDepth / 2 + modulationDepth / 2 * Math.sin(2 * Math.PI * modulationHz * t))
      * Math.min(1, t / 0.015, (seconds - t) / 0.015)
    let value = 0
    for (let h = 0; h < harmonics.length; h++) value += harmonics[h] * Math.sin((h + 1) * angle)
    samples[i] = gap && t >= gap[0] && t < gap[1] ? 0 : amplitude * envelope * value / divisor
  }
  return samples
}

export function createPlannerContext(channels, sampleRate) {
  const sourceBuffer = {
    sampleRate, length: channels[0].length, duration: channels[0].length / sampleRate,
    numberOfChannels: channels.length, getChannelData: channel => channels[channel],
  }
  const snapshot = {}
  const owner = { snapshot, trackId: 'quality-track', clipId: 'quality-clip', sourceId: 'quality-source', selectionVersion: 1, sourceBuffer }
  const clip = { id: owner.clipId, assetId: owner.sourceId, offsetSeconds: 0, durationSeconds: sourceBuffer.duration }
  return { clip, owner, currentOwner: { ...owner } }
}

function contourMetrics(before, after, correctionCents, targetMidi) {
  const margin = Math.min(0.12, before.duration / 4)
  const paired = before.frames.flatMap((frame, i) => {
    const other = after.frames[i]
    if (frame.state !== 'voiced' || other?.state !== 'voiced') return []
    return [{ time: frame.time - before.start, sourceCents: 100 * (frame.midi - targetMidi),
      outputCents: 100 * (other.midi - targetMidi), shiftError: 100 * (other.midi - frame.midi) - correctionCents }]
  })
  const inside = paired.filter(frame => frame.time >= margin && frame.time <= before.duration - margin)
  const width = (frames, key) => quantile(frames.map(frame => frame[key]), 0.9) - quantile(frames.map(frame => frame[key]), 0.1)
  const meanSquared = values => values.reduce((sum, value) => sum + value ** 2, 0) / Math.max(1, values.length)
  const interiorMedianShiftError = quantile(inside.map(frame => frame.shiftError), 0.5)
  return {
    pairedFrames: paired.length, inputVoicedFraction: before.summary.voicedFraction,
    outputVoicedFraction: after.summary.voicedFraction,
    inputMedianErrorCents: before.summary.medianMidi === null ? null : 100 * (before.summary.medianMidi - targetMidi),
    outputMedianErrorCents: after.summary.medianMidi === null ? null : 100 * (after.summary.medianMidi - targetMidi),
    allFrameShiftErrorCents: statistics(paired.map(frame => frame.shiftError)),
    interiorShiftErrorCents: statistics(inside.map(frame => frame.shiftError)),
    interiorShapeRmsErrorCents: Math.sqrt(meanSquared(inside.map(frame => frame.shiftError - interiorMedianShiftError))),
    interiorInputP90P10Cents: width(inside, 'sourceCents'),
    interiorOutputP90P10Cents: width(inside, 'outputCents'),
  }
}

// Independent normalized correlation, not YIN. Its wide +/-20% search interval
// uses source YIN only to choose the octave neighborhood, never a result filter.
// Each input/output pair is reported regardless of residual error/correlation.
function independentPitchMetrics(input, output, sampleRate, before, targetMidi, correctionCents) {
  const targetHz = midiToFrequency(targetMidi), ratio = 2 ** (correctionCents / 1200)
  const measurements = []
  // 73ms spacing avoids sampling only two phases of the 5Hz vibrato fixture.
  for (let time = 0.2; time <= before.duration - 0.2 + 1e-9; time += 0.073) {
    const frame = before.frames.reduce((best, value) => Math.abs(value.time - before.start - time) < Math.abs(best.time - before.start - time) ? value : best)
    if (frame.state !== 'voiced') continue
    const source = periodicFrequency(input, sampleRate, time, frame.frequencyHz)
    const result = periodicFrequency(output, sampleRate, time, frame.frequencyHz * ratio)
    measurements.push({ time, beforeCents: centsError(source.frequency, targetHz),
      afterCents: centsError(result.frequency, targetHz), shiftErrorCents: centsError(result.frequency, source.frequency * ratio),
      inputCorrelation: source.correlation, outputCorrelation: result.correlation })
  }
  return {
    inputErrorCents: statistics(measurements.map(value => value.beforeCents)),
    outputErrorCents: statistics(measurements.map(value => value.afterCents)),
    pairedShiftErrorCents: statistics(measurements.map(value => value.shiftErrorCents)),
    minimumOutputCorrelation: measurements.length ? Math.min(...measurements.map(value => value.outputCorrelation)) : null,
  }
}

export async function assessNoteCentering({ name, channels, sampleRate = 48000, targetMidi = 57 }, planNoteCentering, combineNoteCenteringPlans) {
  const started = performance.now()
  const originalCopies = channels.map(channel => channel.slice())
  const context = createPlannerContext(channels, sampleRate)
  const analyses = [], channelPlans = []
  for (let c = 0; c < channels.length; c++) {
    const analysis = { ...await analyzePitch(channels[c], sampleRate), channel: c, analyzedChannel: c }
    analyses.push(analysis)
    channelPlans.push(planNoteCentering(analysis, { ...context, targetMidi,
      owner: { ...context.owner, channel: c }, currentOwner: { ...context.currentOwner, channel: c } }))
  }
  if (channels.length === 2 && typeof combineNoteCenteringPlans !== 'function') throw new Error('Stereo diagnostics require actual per-channel consensus planner')
  const plan = channels.length === 1 ? channelPlans[0] : combineNoteCenteringPlans(channelPlans)
  const common = { name, sampleRate, seconds: channels[0].length / sampleRate, channels: channels.length,
    planAccepted: plan.ok, reason: plan.reason, correctionCents: plan.correctionCents,
    nearTarget: plan.nearTarget, canRecommendRender: plan.canRecommendRender, diagnostics: plan.diagnostics }
  if (!plan.ok) return common
  // Diagnostic-only probes deliberately measure even advisory-sized changes.
  // The product should honor canRecommendRender; this is not its UI workflow.
  const rendered = await renderSignalsmithPitch(channels, sampleRate, { ...plan.settings, yieldControl: async () => {} })
  const measurements = []
  for (let c = 0; c < channels.length; c++) {
    const before = analyses[c]
    const after = await analyzePitch(rendered.channels[c], sampleRate)
    measurements.push({
      channel: c,
      yin: contourMetrics(before, after, plan.correctionCents, targetMidi),
      independentCorrelation: independentPitchMetrics(channels[c], rendered.channels[c], sampleRate, before, targetMidi, plan.correctionCents),
      inputPeak: peak(channels[c]), outputPeak: peak(rendered.channels[c]),
      rmsChangeDb: 20 * Math.log10(rms(rendered.channels[c]) / rms(channels[c])),
    })
  }
  return { ...common, measurements,
    diagnosticOnlyRender: plan.canRecommendRender === false,
    exactSampleCounts: rendered.channels.every((channel, c) => channel.length === channels[c].length),
    unchangedSampleRate: rendered.sampleRate === sampleRate,
    inputUnchanged: channels.every((channel, c) => Buffer.from(channel.buffer, channel.byteOffset, channel.byteLength).equals(Buffer.from(originalCopies[c].buffer))),
    finiteOutput: rendered.channels.every(channel => channel.every(Number.isFinite)),
    outputChannelsDifferent: channels.length < 2 ? null : rendered.channels[0].some((value, i) => value !== rendered.channels[1][i]),
    wasmMemoryBytes: rendered.metadata.wasmMemoryBytes, wallMilliseconds: performance.now() - started }
}

export function acceptedFixtures() {
  const result = []
  for (const sampleRate of [44100, 48000, 96000]) {
    for (const [targetMidi, detuneCents] of [[45, -43], [57, 37], [69, -179], [81, 179]]) {
      result.push({ name: `harmonic-midi${targetMidi}-${detuneCents}c-${sampleRate}`, sampleRate, targetMidi,
        channels: [generateNote({ sampleRate, targetMidi, detuneCents, seconds: 0.8 })] })
    }
    result.push({ name: `am-depth65-${sampleRate}`, sampleRate, targetMidi: 57,
      channels: [generateNote({ sampleRate, detuneCents: -37, modulationDepth: 0.65 })] })
    result.push({ name: `vibrato-25c-5hz-${sampleRate}`, sampleRate, targetMidi: 57,
      channels: [generateNote({ sampleRate, seconds: 2, detuneCents: 31, vibratoCents: 25 })] })
    result.push({ name: `stereo-same-f0-different-spectrum-${sampleRate}`, sampleRate, targetMidi: 57,
      channels: [generateNote({ sampleRate }), generateNote({ sampleRate, phase: 0.8, amplitude: 0.2,
        modulationDepth: 0.25, modulationHz: 3, harmonics: [0.6, 1, 0.25, 0.1] })] })
  }
  return result
}

export function refusalFixtures() {
  const sampleRate = 48000
  const mix = frequencies => {
    const channels = frequencies.map(frequency => generateNote({ sampleRate, targetMidi: 69 + 12 * Math.log2(frequency / 440), detuneCents: 0, harmonics: [1] }))
    return channels[0].map((_, i) => channels.reduce((sum, channel) => sum + channel[i] / channels.length, 0))
  }
  return [
    { name: 'silence', channels: [new Float32Array(sampleRate)] },
    { name: 'deterministic-noise', channels: [noise(sampleRate, 1.2)] },
    { name: 'two-sequential-notes-200c', channels: [generateNote({ stepCents: 200 })] },
    { name: 'continuous-glide-120c', channels: [generateNote({ glideCents: 120 })] },
    { name: 'narrow-continuous-glide-60c', channels: [generateNote({ glideCents: 60 })] },
    { name: 'wide-vibrato-80c', channels: [generateNote({ seconds: 2, vibratoCents: 80 })] },
    { name: 'interior-silence-250ms', channels: [generateNote({ gap: [0.45, 0.7] })] },
    { name: 'uncertain-polyphony', channels: [mix([220, 307, 463])] },
    { name: 'quiet-below-floor', channels: [generateNote({ amplitude: 0.0001 })] },
    { name: 'too-short-200ms', channels: [generateNote({ seconds: 0.2 })] },
  ].map(value => ({ ...value, sampleRate, targetMidi: 57 }))
}

async function cc0Diagnostics(planNoteCentering) {
  const { readFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  const { spawnSync } = await import('node:child_process')
  const base = new URL('../tests/fixtures/lyrics-alignment/cc0-twinkle/', import.meta.url)
  const fixture = new URL('first-20s-mono-16k.wav', base)
  const provenance = JSON.parse(readFileSync(new URL('provenance.json', base), 'utf8'))
  const hash = createHash('sha256').update(readFileSync(fixture)).digest('hex')
  if (hash !== provenance.sha256 || provenance.source.licenseId !== 'CC0-1.0' || provenance.rightsConfirmed !== true) throw new Error('Retained CC0 fixture provenance mismatch')
  const converted = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fileURLToPath(fixture), '-map_metadata', '-1', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { maxBuffer: 5 * 1024 * 1024, timeout: 5000 })
  if (converted.status !== 0) throw new Error(`Installed ffmpeg conversion failed: ${converted.stderr?.toString() || converted.error}`)
  const input = Float32Array.from({ length: converted.stdout.length / 4 }, (_, i) => converted.stdout.readFloatLE(i * 4))
  if (input.length !== 20 * 48000) throw new Error('Retained recording duration changed')
  const results = []
  // Fixed grid, selected before rendering: report every crop, including refusal.
  // No cherry-picking windows by output accuracy. Targets are nearest notes and
  // are descriptive references, not human-annotated musical intent.
  for (let at = 0; at + 0.6 <= 20; at += 0.5) {
    const samples = input.slice(Math.round(at * 48000), Math.round((at + 0.6) * 48000))
    const before = await analyzePitch(samples, 48000)
    const targetMidi = Math.round(before.summary.medianMidi ?? 57)
    results.push(await assessNoteCentering({ name: `cc0-crop-${at.toFixed(1)}s`, channels: [samples], sampleRate: 48000, targetMidi }, planNoteCentering))
  }
  return { fixtureSha256: hash, source: provenance.source.originalDeclarationRevisionUrl,
    caveats: ['One unannotated singer/recording, no listening or musical-correctness gold', '16k source is upsampled, with no restored bandwidth', 'Every 0.6s crop at 0.5s spacing is included', 'Below-10c changes are diagnostic probes, not recommended product renders'], results }
}

export async function runDiagnostics({ includeCc0 = false } = {}) {
  const { planNoteCentering, combineNoteCenteringPlans } = await import('../src/js/daw/note-centering.js')
  const started = performance.now(), before = process.memoryUsage()
  const report = { generatedAt: new Date().toISOString(), runtime: process.version,
    method: 'Actual YIN analysis -> actual note-centering planner -> actual vendored Signalsmith 1.3.2; independent normalized-correlation F0 cross-check',
    caveats: ['Synthetic results do not establish singing accuracy or listening quality', 'Constant transposition centers pitch but does not straighten drift/vibrato', 'YIN periodicity cannot prove monophony; both stereo channels must pass and agree', 'No browser, speaker, or human listening check was performed'],
    acceptedCandidates: [], refusals: [], limitations: [] }
  for (const fixture of acceptedFixtures()) report.acceptedCandidates.push(await assessNoteCentering(fixture, planNoteCentering, combineNoteCenteringPlans))
  for (const fixture of refusalFixtures()) report.refusals.push(await assessNoteCentering(fixture, planNoteCentering, combineNoteCenteringPlans))
  // Inherently ambiguous input: a 110+220+330 Hz chord shares the same periods
  // as one harmonic note. A monophonic F0 estimator is not a polyphony detector.
  const periodicMixture = generateNote({ targetMidi: 45, detuneCents: 37, harmonics: [1, 1, 1] })
  report.limitations.push(await assessNoteCentering({ name: 'periodic-mixture-indistinguishable-from-harmonics', channels: [periodicMixture], targetMidi: 45 }, planNoteCentering))
  // Shared stereo correction can only center the mean of two slightly different
  // F0s. Both may improve while retaining a >10c individual target residual.
  report.limitations.push(await assessNoteCentering({ name: 'stereo-19c-center-difference-within-gate',
    channels: [generateNote(), generateNote({ detuneCents: 56, phase: 0.8, modulationDepth: 0.25,
      modulationHz: 3, harmonics: [0.6, 1, 0.25, 0.1] })], targetMidi: 57 }, planNoteCentering, combineNoteCenteringPlans))
  report.refusals.push(await assessNoteCentering({ name: 'stereo-different-notes',
    channels: [generateNote(), generateNote({ targetMidi: 58 })], targetMidi: 57 }, planNoteCentering, combineNoteCenteringPlans))
  report.refusals.push(await assessNoteCentering({ name: 'stereo-silent-right-channel',
    channels: [generateNote(), new Float32Array(57600)], targetMidi: 57 }, planNoteCentering, combineNoteCenteringPlans))
  report.refusals.push(await assessNoteCentering({ name: 'stereo-21c-center-difference-outside-gate',
    channels: [generateNote(), generateNote({ detuneCents: 58 })], targetMidi: 57 }, planNoteCentering, combineNoteCenteringPlans))
  if (includeCc0) report.retainedCc0 = await cc0Diagnostics(planNoteCentering)
  report.resources = { wallMilliseconds: performance.now() - started, maxRssKiB: process.resourceUsage().maxRSS,
    arrayBufferBytesBefore: before.arrayBuffers, arrayBufferBytesAfter: process.memoryUsage().arrayBuffers }
  return report
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runDiagnostics({ includeCc0: process.argv.includes('--cc0') }), null, 2))
