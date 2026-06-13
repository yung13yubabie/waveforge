// Mock Web Audio API (jsdom does not include it)
import { vi } from 'vitest'

function makeAudioParam(initial = 0) {
  return {
    value: initial,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  }
}

function makeNode(extra = {}) {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    ...extra,
  }
}

class MockAudioContext {
  constructor() {
    this.sampleRate = 48000
    this.currentTime = 0
    this.state = 'suspended'
    this.destination = makeNode()
    this.audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
  }

  createGain() {
    return makeNode({ gain: makeAudioParam(1) })
  }

  createBiquadFilter() {
    const freqResponse = vi.fn((freqs, magOut, phaseOut) => {
      // Fill with 1.0 (flat response) so multiplied curves stay sane
      for (let i = 0; i < freqs.length; i++) {
        magOut[i] = 1.0
        phaseOut[i] = 0.0
      }
    })
    return makeNode({
      type: 'peaking',
      frequency: makeAudioParam(1000),
      gain: makeAudioParam(0),
      Q: makeAudioParam(1),
      getFrequencyResponse: freqResponse,
    })
  }

  createDynamicsCompressor() {
    return makeNode({
      threshold: makeAudioParam(-24),
      knee: makeAudioParam(30),
      ratio: makeAudioParam(4),
      attack: makeAudioParam(0.003),
      release: makeAudioParam(0.25),
      reduction: 0,
    })
  }

  createWaveShaper() {
    return makeNode({ curve: null, oversample: 'none' })
  }

  createChannelSplitter(channels = 6) {
    return makeNode({ numberOfOutputs: channels })
  }

  createChannelMerger(channels = 6) {
    return makeNode({ numberOfInputs: channels })
  }

  createAnalyser() {
    return makeNode({
      fftSize: 2048,
      frequencyBinCount: 1024,
      smoothingTimeConstant: 0.8,
      getFloatFrequencyData: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
    })
  }

  createBufferSource() {
    return makeNode({
      buffer: null,
      loop: false,
      playbackRate: makeAudioParam(1),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    })
  }

  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length))
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: ch => data[ch],
      copyToChannel: (src, ch) => { data[ch]?.set(src.subarray(0, length)) },
    }
  }

  async decodeAudioData(_buffer) {
    return this.createBuffer(2, 48000, 48000)
  }

  async resume() { this.state = 'running' }
  async suspend() { this.state = 'suspended' }
  async close() { this.state = 'closed' }
}

class MockAudioWorkletNode {
  constructor(_ctx, _name, options) {
    this.port = {
      onmessage: null,
      postMessage: vi.fn(),
    }
    // parameters map auto-creates an AudioParam for any name, seeded from
    // parameterData like the real constructor
    const seed = options?.parameterData ?? {}
    const store = new Map()
    this.parameters = {
      get: name => {
        if (!store.has(name)) store.set(name, makeAudioParam(seed[name] ?? 0))
        return store.get(name)
      },
    }
  }
  connect = vi.fn()
  disconnect = vi.fn()
}

global.AudioContext = MockAudioContext
global.AudioWorkletNode = MockAudioWorkletNode
global.OfflineAudioContext = class extends MockAudioContext {
  constructor(channels, length, sampleRate) {
    super()
    this.length = length
    this.sampleRate = sampleRate
  }
  async startRendering() { return this.createBuffer(2, this.length, this.sampleRate) }
}
