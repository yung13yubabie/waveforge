/** Deterministic synthetic fixtures only. No real-singer accuracy claim. */
export function tone({ sampleRate = 48000, duration = 0.4, frequency = 440, amplitude = 0.3, harmonics = [1], phase = 0, dc = 0 } = {}) {
  return Float32Array.from({ length: Math.round(sampleRate * duration) }, (_, i) => {
    const position = 2 * Math.PI * frequency * i / sampleRate + phase
    return dc + harmonics.reduce((sum, gain, harmonic) => sum + amplitude * gain * Math.sin(position * (harmonic + 1)), 0)
  })
}
export function seededNoise({ sampleRate = 48000, duration = 0.4, amplitude = 0.3, seed = 71227 } = {}) {
  let state = seed >>> 0
  return Float32Array.from({ length: Math.round(sampleRate * duration) }, () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    return amplitude * (state / 2147483648 - 1)
  })
}
export function linearGlide({ sampleRate = 48000, duration = 0.8, from = 220, to = 330 } = {}) {
  return Float32Array.from({ length: Math.round(sampleRate * duration) }, (_, i) => {
    const time = i / sampleRate
    return 0.3 * Math.sin(2 * Math.PI * (from * time + (to - from) * time * time / (2 * duration)))
  })
}
export function fakeAudioBuffer(channels = [tone()], sampleRate = 48000) {
  return {
    sampleRate, length: channels[0].length, duration: channels[0].length / sampleRate,
    numberOfChannels: channels.length, getChannelData: index => channels[index],
  }
}
