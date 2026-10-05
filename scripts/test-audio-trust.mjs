// No-dependency reproduction/regression runner using real production DSP.
import assert from 'node:assert/strict'
import { detectKey } from '../src/js/audio/analyze.js'
import { measurePeaks } from '../src/js/audio/measure.js'
import { truePeakLimit } from '../src/js/audio/true-peak-limiter.js'
import { assertTruePeakCeiling } from '../src/js/audio/true-peak.js'
import { TEST_RATES, lateMajorChord, terminalImpulse, interSampleSine } from '../tests/fixtures/audio-trust/signals.js'
const results = []
for (const sampleRate of TEST_RATES) {
  const key = detectKey(lateMajorChord(sampleRate))
  assert.equal(key.key, 'C'); assert.equal(key.scale, '大調'); assert.equal(key.analysis.endSeconds, 30)
  for (const [name, signal] of [['terminal', terminalImpulse()], ['isp', interSampleSine()]]) {
    const before = measurePeaks([signal])
    const output = truePeakLimit([signal], sampleRate, -1)
    const after = measurePeaks(output)
    assert(after.truePeakDb <= -1 + 1e-6)
    assert.doesNotThrow(() => assertTruePeakCeiling(output, -1))
    results.push({ sampleRate, fixture: name, before, after })
  }
}
console.log(JSON.stringify({ status: 'PASS', scope: 'Synthetic PCM, 4x estimator; not codec or singing-model certification', results }, null, 2))
