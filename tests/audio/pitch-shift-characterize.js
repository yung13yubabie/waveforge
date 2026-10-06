// Run: node tests/audio/pitch-shift-characterize.js
// Objective characterization only; does not replace listening or browser QA.
import { shiftPitch } from '../../src/js/pitch/shift.js'
import { tone, chirp, vowel, noise, rms, peak, crossingFrequency, periodicFrequency, centsError } from './pitch-shift-fixtures.js'

const immediate = async () => {}
const shift = (channels, sr, semitones) => shiftPitch(channels, sr, { semitones, yieldControl: immediate })
const db = ratio => 20 * Math.log10(Math.max(1e-20, ratio))
const report = { generatedAt: new Date().toISOString(), runtime: process.version, tone: [], vowel: [], glide: [], transients: [], robustness: [], closeFrequencyStereo: [], boundaryPaddingProbe: [] }
for (const sr of [44100, 48000, 96000]) {
  for (const semitones of [-2, 2]) {
    const ratio = 2 ** (semitones / 12)
    const x = tone(sr, 1)
    const y = (await shift([x], sr, semitones)).channels[0]
    report.tone.push({ sr, semitones, inputHz: 220, outputHz: crossingFrequency(y, sr), centsError: centsError(crossingFrequency(y, sr), 220 * ratio), inputSamples: x.length, outputSamples: y.length, interiorRmsDb: db(rms(y, sr * 0.2, sr * 0.8) / rms(x, sr * 0.2, sr * 0.8)) })
    const v = vowel(sr, 1), vy = (await shift([v], sr, semitones)).channels[0]
    const measured = periodicFrequency(vy, sr, 0.5, 180 * ratio)
    report.vowel.push({ sr, semitones, centsError: centsError(measured.frequency, 180 * ratio), periodicCorrelation: measured.correlation, rmsDb: db(rms(vy) / rms(v)) })
    const cy = (await shift([chirp(sr, 1.5)], sr, semitones)).channels[0]
    for (const center of [0.3, 0.7, 1.1]) {
      report.glide.push({ sr, semitones, center, centsError: centsError(crossingFrequency(cy, sr, center - 0.03, center + 0.03), (180 + 60 * center) * ratio) })
    }
  }
}
for (const semitones of [-2, 2]) {
  const sr = 48000
  for (const index of [0, 100, sr / 2, sr - 100, sr - 1]) {
    const x = new Float32Array(sr); x[index] = 0.8
    const y = (await shift([x], sr, semitones)).channels[0]
    let maximum = 0, totalEnergy = 0, beforeEnergy = 0, outsideEnergy = 0
    for (let i = 0; i < y.length; i++) {
      if (Math.abs(y[i]) > Math.abs(y[maximum])) maximum = i
      const energy = y[i] ** 2
      totalEnergy += energy
      if (i < index) beforeEnergy += energy
      if (Math.abs(i - index) > sr * 0.01) outsideEnergy += energy
    }
    report.transients.push({ semitones, index, peakDelayMs: (maximum - index) / sr * 1000, peakDbVsInput: db(peak(y) / 0.8), energyDbVsInput: db(Math.sqrt(totalEnergy) / 0.8), preEventEnergyFraction: beforeEnergy / totalEnergy, energyBeyond10msFraction: outsideEnergy / totalEnergy })
  }
  for (const [name, x] of [['noise', noise(sr, 1)], ['dc', new Float32Array(sr).fill(0.2)], ['nearNyquist', tone(sr, 1, 23000)]]) {
    const y = (await shift([x], sr, semitones)).channels[0]
    report.robustness.push({ name, semitones, interiorRmsDb: db(rms(y, sr * 0.2, sr * 0.8) / rms(x, sr * 0.2, sr * 0.8)), peak: peak(y) })
  }
}
for (const sr of [44100, 48000, 96000]) {
  for (const frequencies of [[220, 230], [220, 240], [55, 60]]) {
    const result = await shift(frequencies.map(hz => tone(sr, 1, hz)), sr, 2)
    report.closeFrequencyStereo.push({ sr, semitones: 2, inputHz: frequencies,
      measuredHz: result.channels.map(channel => crossingFrequency(channel, sr)),
      centsError: result.channels.map((channel, index) => centsError(crossingFrequency(channel, sr), frequencies[index] * 2 ** (2 / 12))),
    })
  }
}
// Full-domain vs exact-crop energy isolates transient motion from a missing
// flush. Changing padding changes STFT frame alignment; record both, not just
// whichever grid happens to give a favorable edge result.
for (const semitones of [-2, 2]) {
  for (const index of [0, 24000, 47999]) {
    for (const padding of [0, 8192, 48000]) {
      const input = new Float32Array(48000 + 2 * padding)
      input[index + padding] = 0.8
      const output = (await shift([input], 48000, semitones)).channels[0]
      let total = 0, retained = 0, maximum = 0
      for (let i = 0; i < output.length; i++) {
        total += output[i] ** 2
        if (i >= padding && i < padding + 48000) retained += output[i] ** 2
        if (Math.abs(output[i]) > Math.abs(output[maximum])) maximum = i
      }
      report.boundaryPaddingProbe.push({ semitones, index, padding,
        peakDelayMs: 1000 * (maximum - padding - index) / 48000,
        fullEnergyDb: 10 * Math.log10(total / 0.64), croppedEnergyDb: 10 * Math.log10(retained / 0.64),
        energyOutsideCropFraction: 1 - retained / total,
      })
    }
  }
}
const sr = 96000, x = tone(sr, 30), channels = [x, x.map(value => -0.5 * value)]
const before = process.memoryUsage(), started = performance.now()
const stress = await shift(channels, sr, 2)
report.stress = { sr, inputSeconds: 30, channels: 2, outputSamplesPerChannel: stress.channels[0].length, wallMilliseconds: performance.now() - started, arrayBufferBytesBefore: before.arrayBuffers, arrayBufferBytesAfter: process.memoryUsage().arrayBuffers, maxRssKiB: process.resourceUsage().maxRSS, outputPeak: peak(stress.channels[0]) }
console.log(JSON.stringify(report, null, 2))
