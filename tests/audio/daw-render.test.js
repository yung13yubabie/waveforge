import { describe, it, expect } from 'vitest'
import { createProject, applyCommand } from '../../src/js/daw/project.js'
import { buildRenderPlan, renderProject, getPendingNativeRenderBytes } from '../../src/js/daw/render.js'

function pcm(sampleRate = 44100, length = 4410, channels = 1) {
  const samples = Array.from({ length: channels }, () => new Float32Array(length))
  return { sampleRate, length, numberOfChannels: channels, duration: length / sampleRate, getChannelData: channel => samples[channel] }
}
function fixture() {
  const buffer = pcm()
  let project = createProject({ masterGainDb: -6 })
  project = applyCommand(project, { type: 'asset.add', asset: { id: 'asset', name: 'Native 44k.wav', duration: buffer.duration, sampleRate: buffer.sampleRate, channels: 1, length: buffer.length } })
  project = applyCommand(project, { type: 'track.add', track: { id: 'track', gainDb: -3, pan: -0.5 } })
  project = applyCommand(project, { type: 'clip.add', trackId: 'track', clip: { id: 'clip', assetId: 'asset', atSeconds: 0.02, offsetSeconds: 0.01, durationSeconds: 0.08, fadeInSeconds: 0.01, fadeOutSeconds: 0.02, gainDb: -2 } })
  return { project, buffers: new Map([['asset', buffer]]) }
}
function contextMock() {
  const made = []
  const parameter = () => ({ events: [], setValueAtTime(value, at) { this.events.push(['set', value, at]) }, linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]) } })
  class Context {
    constructor(channels, frames, rate) {
      this.channels = channels; this.frames = frames; this.rate = rate; this.nodes = []
      this.destination = { type: 'destination' }; made.push(this)
    }
    node(type, fields = {}) {
      const node = { type, ...fields, connections: [], disconnected: false,
        connect(other) { this.connections.push(other) }, disconnect() { this.disconnected = true } }
      this.nodes.push(node); return node
    }
    createGain() { return this.node('gain', { gain: parameter() }) }
    createStereoPanner() { return this.node('pan', { pan: parameter() }) }
    createBufferSource() { return this.node('source', { start(...args) { this.started = args } }) }
    async startRendering() { this.output = pcm(this.rate, this.frames, this.channels); return this.output }
  }
  return { Context, made }
}

describe('DAW render recipe', () => {
  it('uses seconds and exact fade schedules, not tempo-dependent stretching', () => {
    const { project } = fixture(), original = JSON.stringify(project)
    const plan = buildRenderPlan(project)
    expect(plan).toMatchObject({ frames: 4800, sampleRate: 48000, channels: 2, durationSeconds: 0.1 })
    expect(plan.masterGain).toBeCloseTo(10 ** (-6 / 20))
    expect(plan.tracks[0]).toMatchObject({ id: 'track', pan: -0.5 })
    expect(plan.tracks[0].clips[0]).toMatchObject({ atSeconds: 0.02, offsetSeconds: 0.01, durationSeconds: 0.08 })
    const slower = applyCommand(project, { type: 'project.update', patch: { tempo: 60 } })
    expect(buildRenderPlan(slower).tracks).toEqual(plan.tracks)
    expect(JSON.stringify(project)).toBe(original)
  })
  it('honors solo and mute without shortening timeline tails', () => {
    let { project } = fixture()
    project = applyCommand(project, { type: 'track.duplicate', trackId: 'track', newId: 'other' })
    project = applyCommand(project, { type: 'track.update', trackId: 'other', patch: { solo: true } })
    expect(buildRenderPlan(project).tracks.map(track => track.id)).toEqual(['other'])
    project = applyCommand(project, { type: 'track.update', trackId: 'other', patch: { mute: true } })
    expect(buildRenderPlan(project).tracks).toEqual([])
    expect(buildRenderPlan(project).durationSeconds).toBe(0.1)
  })
  it('refuses empty work and oversized output before allocating a context', () => {
    expect(() => buildRenderPlan(createProject())).toThrow(/add an audio clip/)
    const { project } = fixture()
    const long = applyCommand(project, { type: 'clip.move', trackId: 'track', clipId: 'clip', atSeconds: 599 })
    const highRate = applyCommand(long, { type: 'project.update', patch: { sampleRate: 96000 } })
    expect(() => buildRenderPlan(highRate)).toThrow(/memory limit/)
  })
})

describe('Web Audio mix wiring contract (mock, not browser DSP validation)', () => {
  it('connects native-rate sources, clip gain envelopes, pan and master gain to stereo output', async () => {
    const { project, buffers } = fixture(), { Context, made } = contextMock()
    const result = await renderProject(project, buffers, { OfflineAudioContextClass: Context })
    const context = made[0], source = context.nodes.find(node => node.type === 'source')
    expect(source.buffer).toBe(buffers.get('asset'))
    expect(source.buffer.sampleRate).toBe(44100)
    expect(context.rate).toBe(48000)
    expect(source.started).toEqual([0.02, 0.01, 0.08])
    const clipGain = source.connections[0], automationGain = clipGain.connections[0], trackGain = automationGain.connections[0], pan = trackGain.connections[0], master = pan.connections[0]
    expect(master.connections[0]).toBe(context.destination)
    expect(master.gain.events[0][1]).toBeCloseTo(10 ** (-6 / 20))
    expect(trackGain.gain.events[0][1]).toBeCloseTo(10 ** (-3 / 20))
    expect(pan.pan.events[0]).toEqual(['set', -0.5, 0])
    expect(clipGain.gain.events[0]).toEqual(['set', 0, 0.02])
    expect(clipGain.gain.events.at(-1)).toEqual(['ramp', 0, 0.1])
    expect(result.buffer).toBe(context.output)
    expect(result.revision).toBe(project.revision)
    expect(result.peaks.samplePeakDb).toBe(-Infinity)
    expect(context.nodes.every(node => node.disconnected)).toBe(true)
  })
  it('commands separate exact automation and fade gains so simultaneous ramps multiply', async () => {
    let { project, buffers } = fixture()
    project = applyCommand(project, { type: 'clip.automation.add', trackId: 'track', clipId: 'clip', point: { timeSeconds: .005, value: .25 } })
    project = applyCommand(project, { type: 'clip.automation.update', trackId: 'track', clipId: 'clip', index: 2, patch: { value: 2 } })
    const { Context, made } = contextMock()
    const result = await renderProject(project, buffers, { OfflineAudioContextClass: Context })
    const source = made[0].nodes.find(node => node.type === 'source')
    const fade = source.connections[0], automation = fade.connections[0]
    expect(automation.gain.events).toEqual([['set', 1, .02], ['ramp', .25, .025], ['ramp', 2, .1]])
    expect(fade.gain.events[0]).toEqual(['set', 0, .02])
    expect(fade.gain.events[1][1]).toBeCloseTo(10 ** (-2 / 20))
    expect(fade.gain.events[1][2]).toBe(.03)
    expect(result.plan.tracks[0].clips[0].automation).toEqual(project.tracks[0].clips[0].volumeAutomation)
  })
  it('does not hide overload and reports sample and estimated true peaks', async () => {
    const { project, buffers } = fixture(), { Context } = contextMock()
    class Loud extends Context {
      async startRendering() { const out = await super.startRendering(); out.getChannelData(0)[0] = 1.5; return out }
    }
    const result = await renderProject(project, buffers, { OfflineAudioContextClass: Loud })
    expect(result.buffer.getChannelData(0)[0]).toBe(1.5)
    expect(result.clippedSamples).toBe(1)
    expect(result.peaks.samplePeakDb).toBeCloseTo(20 * Math.log10(1.5))
    expect(result.peaks.truePeakDb).toBeGreaterThanOrEqual(result.peaks.samplePeakDb)
  })
  it('rejects missing and mismatched sources even if their track is muted', async () => {
    const { project, buffers } = fixture(), { Context, made } = contextMock()
    const muted = applyCommand(project, { type: 'track.update', trackId: 'track', patch: { mute: true } })
    await expect(renderProject(muted, new Map(), { OfflineAudioContextClass: Context })).rejects.toThrow(/missing audio source/)
    buffers.set('asset', pcm(48000))
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context })).rejects.toThrow(/metadata mismatch/)
    expect(made).toHaveLength(0)
  })
  it('rejects stale results and pre-aborted work', async () => {
    const { project, buffers } = fixture(), { Context } = contextMock()
    const controller = new AbortController(); controller.abort()
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    let current = true
    class Stale extends Context { async startRendering() { const result = await super.startRendering(); current = false; return result } }
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Stale, isCurrent: () => current })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('cancels immediately and retains the native-job lock until completion', async () => {
    const { project, buffers } = fixture(), { Context } = contextMock()
    let settle
    class Slow extends Context { startRendering() { return new Promise(resolve => { settle = () => resolve(pcm(this.rate, this.frames, this.channels)) }) } }
    const controller = new AbortController()
    const pending = renderProject(project, buffers, { OfflineAudioContextClass: Slow, signal: controller.signal })
    const retained = buildRenderPlan(project).renderBytes + buildRenderPlan(project).decodedBytes
    expect(getPendingNativeRenderBytes()).toBe(retained)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(getPendingNativeRenderBytes()).toBe(retained)
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context })).rejects.toThrow(/previous native render/)
    settle(); await Promise.resolve(); await Promise.resolve()
    expect(getPendingNativeRenderBytes()).toBe(0)
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context })).resolves.toHaveProperty('buffer')
  })
  it('times out without accepting a late result', async () => {
    const { project, buffers } = fixture(), { Context } = contextMock()
    let settle
    class Slow extends Context { startRendering() { return new Promise(resolve => { settle = () => resolve(pcm(this.rate, this.frames, this.channels)) }) } }
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Slow, timeoutMs: 5 })).rejects.toThrow(/timed out/)
    expect(getPendingNativeRenderBytes()).toBeGreaterThan(0)
    settle(); await Promise.resolve(); await Promise.resolve()
  })
  it('rejects invalid PCM and recovers the render lock after failures', async () => {
    const { project, buffers } = fixture(), { Context } = contextMock()
    class Broken extends Context { async startRendering() { const result = await super.startRendering(); result.getChannelData(0)[1] = NaN; return result } }
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Broken })).rejects.toThrow(/non-finite/)
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context })).resolves.toHaveProperty('buffer')
    class Throws extends Context { createStereoPanner() { throw new Error('unsupported panner') } }
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Throws })).rejects.toThrow(/unsupported panner/)
    await expect(renderProject(project, buffers, { OfflineAudioContextClass: Context })).resolves.toHaveProperty('buffer')
  })
})
