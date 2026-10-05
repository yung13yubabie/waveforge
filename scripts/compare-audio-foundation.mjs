// Usage: node scripts/compare-audio-foundation.mjs BASELINE_CHECKOUT CANDIDATE_CHECKOUT
// No network/dependencies. Only deterministic synthetic signals are generated.
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEST_RATES, lateMajorChord, terminalImpulse, interSampleSine, tonalBalance } from '../tests/fixtures/audio-trust/signals.js'
if (!process.argv[2] || !process.argv[3]) throw new Error('Supply baseline and candidate checkout paths')
const rows = []
for (const [label, directory] of [['baseline', process.argv[2]], ['candidate', process.argv[3]]]) {
  const root = resolve(directory)
  const module = path => import(pathToFileURL(join(root, 'src/js/audio', path)))
  const { detectKey } = await module('analyze.js')
  const { truePeakLimit } = await module('true-peak-limiter.js')
  const { measurePeaks } = await module('measure.js')
  const { averageSpectrum, computeMatchCurve } = await module('match-eq.js')
  const keys = TEST_RATES.map(sampleRate => ({ sampleRate, result: detectKey(lateMajorChord(sampleRate)) }))
  const terminal = terminalImpulse()
  const isp = interSampleSine()
  const source = tonalBalance(96000), reference = tonalBalance(48000)
  const bands = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  // Baseline source trace used the monitor's rate for both arrays. Candidate
  // source trace uses each buffer's rate. This recreates those calls, not a UI run.
  const rateArgument = label === 'baseline' ? 48000 : source.sampleRate
  const curve = computeMatchCurve(averageSpectrum([source.getChannelData(0)], rateArgument, bands),
    averageSpectrum([reference.getChannelData(0)], reference.sampleRate, bands))
  rows.push({ label, keyFixture: '3s silence + 27s C-major', keys,
    terminalBefore: measurePeaks([terminal]), terminalAfter: measurePeaks(truePeakLimit([terminal], 48000, -1)),
    ispAfter: measurePeaks(truePeakLimit([isp], 48000, -1)),
    referenceCallReproduction: { sourceRate: source.sampleRate, analyzedAsRate: rateArgument,
      bands, curveDb: Array.from(curve), scope: 'Recreated source-traced DSP calls, not browser integration' } })
}
console.log(JSON.stringify({ generatedFrom: 'Original synthetic fixture generators; no user audio', rows }, null, 2))
