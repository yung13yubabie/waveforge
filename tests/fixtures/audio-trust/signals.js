// Original deterministic synthetic signals; no user or third-party recordings.
export const TEST_RATES = [44100, 48000, 96000]

export function bufferLike(samples, sampleRate) {
  return { sampleRate, length: samples.length, duration: samples.length / sampleRate,
    numberOfChannels: 1, getChannelData: () => samples }
}

export function lateMajorChord(sampleRate, { duration = 30, silence = 3 } = {}) {
  const samples = new Float32Array(Math.round(sampleRate * duration))
  for (let i = Math.round(sampleRate * silence); i < samples.length; i++) {
    samples[i] = [261.625565, 329.627557, 391.995436].reduce(
      (sum, hz) => sum + Math.sin(2 * Math.PI * hz * i / sampleRate), 0) / 6
  }
  return bufferLike(samples, sampleRate)
}

export function terminalImpulse(length = 4096, amplitude = 0.999, fromEnd = 0) {
  const samples = new Float32Array(length)
  samples[length - 1 - fromEnd] = amplitude
  return samples
}

export function interSampleSine(length = 8000, amplitude = 1.4) {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin(Math.PI * i / 2 + Math.PI / 4))
}

export function tonalBalance(sampleRate, duration = 0.5) {
  const components = [[500, 0.05], [1000, 0.25], [2000, 0.10], [4000, 0.20]]
  return bufferLike(Float32Array.from({ length: Math.round(sampleRate * duration) }, (_, i) =>
    components.reduce((sum, [hz, amplitude]) => sum + amplitude * Math.sin(2 * Math.PI * hz * i / sampleRate), 0)), sampleRate)
}
