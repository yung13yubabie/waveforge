import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPitchPanel } from '../../src/js/pitch/panel.js'
import { pitchPanelMarkup } from '../../src/js/pitch/markup.js'
import { describePitch } from '../../src/js/pitch/analysis.js'

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function buffer(duration = 3, channels = 1) {
  const sampleRate = 8000, length = Math.round(duration * sampleRate)
  const data = Array.from({ length: channels }, (_, ch) => Float32Array.from({ length }, (_, i) => .1 * Math.sin(2 * Math.PI * (ch ? 220 : 440) * i / sampleRate)))
  return { sampleRate, length, duration: length / sampleRate, numberOfChannels: channels, getChannelData: ch => data[ch] }
}
const frame = (time, frequencyHz = 440) => ({ time, state: 'voiced', ...describePitch(frequencyHz), confidence: .99, reason: null })
const unknown = (time, state = 'uncertain', reason = 'low-periodicity') => ({ time, state, frequencyHz: null, midi: null, note: null, cents: null, confidence: .3, reason })
function result(frames = [frame(.032), frame(.052), unknown(.072), frame(.092), frame(.112)], start = 0, duration = 3) {
  return { frames, start, duration, sampleRate: 8000, analysisSampleRate: 8000, frameDuration: .064, hopDuration: .02, channel: 0, summary: {}, limitations: [] }
}
function makeContext({ resumePromise } = {}) {
  const instances = []
  class Context {
    constructor() { this.state = 'suspended'; this.currentTime = 4; this.destination = {}; this.oscillators = []; this.gains = []; instances.push(this) }
    resume = vi.fn(async () => { if (resumePromise) await resumePromise; this.state = 'running' })
    suspend = vi.fn(async () => { this.state = 'suspended' })
    close = vi.fn(async () => { this.state = 'closed' })
    createOscillator() {
      const value = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), frequency: { setValueAtTime: vi.fn() }, onended: null }
      this.oscillators.push(value); return value
    }
    createGain() {
      const value = { connect: vi.fn(), disconnect: vi.fn(), gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() } }
      this.gains.push(value); return value
    }
  }
  return { Context, instances }
}
let panel, client, source, playRange, stop, notifySource, unsubscribe, contexts
const el = id => document.getElementById(`pitch-${id}`)
const click = async id => { el(id).click(); await tick() }
const input = async (id, value) => { el(id).value = String(value); el(id).dispatchEvent(new Event('input', { bubbles: true })); await tick() }
const change = async (id, value) => { el(id).value = String(value); el(id).dispatchEvent(new Event('change', { bubbles: true })); await tick() }
function setup(options = {}) {
  document.body.innerHTML = pitchPanelMarkup
  source = options.source === undefined ? { buffer: buffer(), id: 'one', name: 'synthetic.wav' } : options.source
  client = { analyze: vi.fn().mockResolvedValue(result()), cancel: vi.fn(), dispose: vi.fn() }
  playRange = vi.fn().mockResolvedValue({}); stop = vi.fn(); unsubscribe = vi.fn()
  contexts = makeContext(options)
  panel = initPitchPanel({ getSource: () => source, playRange, stop, analysisClient: client, AudioContextClass: contexts.Context,
    onSourceChanged: listener => { notifySource = listener; return unsubscribe }, ...options.panelOptions })
  return panel
}
beforeEach(() => { panel = null })
afterEach(() => { panel?.dispose(); document.body.innerHTML = ''; vi.restoreAllMocks() })

describe('pitch assistant source and selection', () => {
  it('keeps the chart primary, contextual reading beside reference controls, and deeper help closed', () => {
    setup()
    const workspace = document.querySelector('.pitch-workspace')
    expect(workspace.firstElementChild.classList.contains('pitch-results')).toBe(true)
    expect(el('point-readout').closest('.pitch-reference')).not.toBeNull()
    expect(el('data').open).toBe(false)
    expect(document.querySelector('.pitch-limits').open).toBe(false)
    expect(document.querySelectorAll('details')).toHaveLength(2)
    expect(el('range-help').textContent).toContain('不會修正音訊')
    expect(document.querySelector('.pitch-scope').textContent).toContain('空白不等於唱錯')
  })
  it('never analyzes, plays or creates an AudioContext automatically', async () => {
    setup(); await tick()
    expect(client.analyze).not.toHaveBeenCalled(); expect(playRange).not.toHaveBeenCalled(); expect(contexts.instances).toHaveLength(0)
    expect(el('source').textContent).toContain('synthetic.wav')
    expect(el('waveform').querySelector('.pitch-wave-shape')).not.toBeNull()
    expect(el('contour').querySelector('.pitch-estimate')).toBeNull()
    expect(el('analyze').disabled).toBe(false)
  })
  it('disables source actions but permits explicit reference listening without a file', async () => {
    setup({ source: null })
    expect(el('analyze').disabled).toBe(true); expect(el('play-original').disabled).toBe(true)
    expect(el('waveform').querySelector('path')).toBeNull()
    await click('play-tone'); expect(contexts.instances[0].oscillators).toHaveLength(1)
  })
  it('selects only the first 60 seconds and supports another arbitrary bounded interval', async () => {
    setup({ source: { buffer: buffer(125), name: 'long.wav' } })
    expect(el('end').value).toBe('60'); expect(el('status').textContent).toContain('前 60 秒')
    await input('start', 65); await input('end', 125); await click('analyze')
    expect(client.analyze).toHaveBeenCalledWith(source.buffer, expect.objectContaining({ start: 65, duration: 60, channel: 0 }))
  })
  it.each([
    ['start', -1, '範圍需在'], ['end', 10, '範圍需在'], ['start', 3, '終點必須'], ['end', .02, '片段太短'], ['start', '', '有效'],
  ])('blocks invalid %s = %s', async (id, value, expected) => {
    setup(); await input(id, value); await click('analyze')
    expect(el('range-error').textContent).toContain(expected); expect(el('analyze').disabled).toBe(true); expect(client.analyze).not.toHaveBeenCalled()
    expect(el(id).getAttribute('aria-invalid')).toBe('true')
  })
  it('does not silently analyze more than 60 seconds', async () => {
    setup({ source: { buffer: buffer(90) } }); await input('end', 90); await click('analyze')
    expect(el('range-error').textContent).toContain('最多 60 秒'); expect(client.analyze).not.toHaveBeenCalled()
  })
  it('renders the selected channel waveform and explicitly passes its channel to analysis', async () => {
    setup({ source: { buffer: buffer(3, 2) } })
    const initial = el('waveform').querySelector('path').getAttribute('d')
    expect(el('channel').disabled).toBe(false)
    await change('channel', 1); await click('analyze')
    expect(client.analyze.mock.calls[0][1].channel).toBe(1)
    expect(el('waveform').querySelector('path').getAttribute('d')).not.toBe(initial)
    expect(el('waveform').textContent).toContain('第 2 聲道')
  })
  it('moves the selected window with the actual overview position, while keeping it bounded', async () => {
    setup({ source: { buffer: buffer(100) } })
    vi.spyOn(el('waveform'), 'getBoundingClientRect').mockReturnValue({ left: 10, width: 800 })
    el('waveform').dispatchEvent(new MouseEvent('click', { clientX: 810, bubbles: true })); await tick()
    expect(el('start').value).toBe('40'); expect(el('end').value).toBe('100')
    expect(el('waveform').querySelector('.pitch-wave-selection').getAttribute('x')).toBe('320')
  })
  it('keeps wide waveform drawing coordinates aligned with pointer selection', async () => {
    setup({ source: { buffer: buffer(100) } })
    await input('end', 10)
    expect(el('waveform').getAttribute('preserveAspectRatio')).toBe('none')
    vi.spyOn(el('waveform'), 'getBoundingClientRect').mockReturnValue({ left: 20, width: 1200 })
    el('waveform').dispatchEvent(new MouseEvent('click', { clientX: 320, bubbles: true })); await tick()
    // A quarter of the drawn overview is exactly source time 25s. A 10s window
    // centered there must be 20..30s, independent of the 800px SVG viewBox.
    expect(el('start').value).toBe('20'); expect(el('end').value).toBe('30')
  })
  it('uses source names as text, never executable markup', () => {
    setup({ source: { buffer: buffer(), name: '<img src=x onerror=alert(1)>' } })
    expect(el('source').textContent).toContain('<img'); expect(document.querySelector('img')).toBeNull()
  })
})

describe('pitch assistant truthful analysis and lifecycle', () => {
  it('shows real note/cents explanations and breaks the contour at an unknown frame', async () => {
    setup(); await click('analyze')
    expect(el('point-readout').textContent).toContain('A4'); expect(el('point-readout').textContent).toContain('相差 0 音分')
    expect(el('contour').querySelector('path').getAttribute('d').match(/M/g)).toHaveLength(2)
    expect(el('contour').querySelectorAll('.pitch-unknown')).toHaveLength(1)
    await input('point', 2)
    expect(el('point-readout').textContent).toContain('不確定'); expect(el('point-readout').textContent).not.toContain('Hz')
    expect(el('rows').children[2].textContent).toContain('—'); expect(el('summary').textContent).toContain('不是正確率')
    expect(el('summary').textContent).not.toMatch(/99%|98%/)
    await input('point', 0); await change('target', 70)
    expect(el('point-readout').textContent).toContain('低 100 音分')
    await change('target', 68); expect(el('point-readout').textContent).toContain('高 100 音分')
    await change('target', 36); expect(el('point-readout').textContent).toContain('可能本來就在唱別的音')
    expect(el('contour').textContent).toContain('在圖外下方')
  })
  it('uses measured chart pixels for mobile axes and preserves data coordinates on resize', async () => {
    setup()
    vi.spyOn(el('contour'), 'getBoundingClientRect').mockReturnValue({ width: 338 })
    await click('analyze')
    expect(el('contour').getAttribute('viewBox')).toBe('0 0 338 220')
    expect(el('contour').style.height).toBe('220px')
    expect(el('contour').querySelector('.pitch-selected-line').getAttribute('y2')).toBe('182')
    const before = el('point-readout').textContent
    el('contour').getBoundingClientRect.mockReturnValue({ width: 720 })
    window.dispatchEvent(new Event('resize'))
    expect(el('contour').getAttribute('viewBox')).toBe('0 0 720 300')
    expect(el('point-readout').textContent).toBe(before)
    expect(el('contour').querySelector('.pitch-selected-line').getAttribute('y2')).toBe('262')
  })
  it('exposes every frame via keyboard slider and paginated accessible table', async () => {
    setup(); client.analyze.mockResolvedValue(result(Array.from({ length: 30 }, (_, i) => frame(.032 + i * .02))))
    await click('analyze'); expect(el('rows').children).toHaveLength(12); expect(el('point').max).toBe('29')
    await click('next-page'); expect(el('page').textContent).toBe('13–24 / 30 點')
    el('rows').querySelector('button').click(); await tick(); expect(el('point').value).toBe('12')
    await input('point', 29); expect(el('page').textContent).toBe('25–30 / 30 點'); expect(el('point').getAttribute('aria-valuetext')).toContain('0.612 秒')
    await click('prev-page'); expect(el('page').textContent).toBe('13–24 / 30 點')
  })
  it('does not invent notes for silence or a too-short analysis result', async () => {
    setup(); client.analyze.mockResolvedValueOnce(result([unknown(.032, 'unvoiced', 'below-level')]))
    await click('analyze'); expect(el('contour').querySelector('.pitch-estimate')).toBeNull(); expect(el('status').textContent).toContain('未找到可靠音高')
    expect(el('point-readout').textContent).toContain('聲音太小')
    client.analyze.mockResolvedValueOnce(result([])); await click('analyze'); expect(el('point').disabled).toBe(true)
    expect(el('rows').children).toHaveLength(0); expect(el('contour').textContent).toContain('片段太短')
  })
  it.each(['range', 'channel', 'cancel', 'source', 'clear', 'leave', 'dispose'])('ignores late results and progress after %s', async interruption => {
    setup({ source: { buffer: buffer(3, 2), id: 'one' } })
    const pending = deferred(); client.analyze.mockReturnValue(pending.promise)
    await click('analyze'); const options = client.analyze.mock.calls[0][1]
    options.onProgress({ progress: .4 }); expect(el('progress').value).toBe(.4)
    if (interruption === 'range') await input('end', 2)
    else if (interruption === 'channel') await change('channel', 1)
    else if (interruption === 'cancel') await click('cancel')
    else if (interruption === 'source') { source = { buffer: buffer(), id: 'two', name: 'new.wav' }; notifySource() }
    else if (interruption === 'clear') { source = null; notifySource() }
    else if (interruption === 'leave') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
    else panel.dispose()
    expect(options.signal.aborted).toBe(true)
    options.onProgress({ progress: .9 }); pending.resolve(result()); await tick()
    expect(el('progress').value).not.toBe(.9); expect(el('contour').querySelector('.pitch-estimate')).toBeNull()
    expect(el('status').textContent).not.toContain('分析完成')
  })
  it('detects a source change even when its subscription notification was missed', async () => {
    setup(); const pending = deferred(); client.analyze.mockReturnValue(pending.promise)
    await click('analyze'); source = { buffer: buffer(), name: 'different.wav' }
    pending.resolve(result()); await tick()
    expect(el('source').textContent).toContain('different.wav'); expect(el('contour').querySelector('.pitch-estimate')).toBeNull()
  })
  it('retains a completed analysis on ordinary mode changes but clears it when the source is removed', async () => {
    setup(); await click('analyze')
    document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } })); expect(el('contour').querySelector('.pitch-estimate')).not.toBeNull()
    source = null; notifySource(); expect(el('contour').querySelector('.pitch-estimate')).toBeNull(); expect(el('waveform').querySelector('path')).toBeNull()
    expect(el('rows').children).toHaveLength(0); expect(el('analyze').disabled).toBe(true)
  })
  it('reports timeout, permits retry, and releases client and subscription on disposal', async () => {
    setup(); client.analyze.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
    await click('analyze'); expect(el('status').textContent).toContain('分析時間過長'); expect(el('analyze').disabled).toBe(false)
    await click('analyze'); expect(el('status').textContent).toContain('分析完成')
    panel.dispose(); panel.dispose(); expect(client.dispose).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce()
    await click('analyze'); expect(client.analyze).toHaveBeenCalledTimes(2)
  })
})

describe('pitch assistant reference sound and exclusive transport', () => {
  it('plays the requested real sine at conservative gain, then releases it', async () => {
    setup(); await click('play-tone')
    const context = contexts.instances[0], oscillator = context.oscillators[0], gain = context.gains[0]
    expect(oscillator.type).toBe('sine'); expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(440, 4)
    expect(oscillator.start).toHaveBeenCalledWith(4); expect(oscillator.stop).toHaveBeenCalledWith(6)
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(.03, 4.025)
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0, 6)
    expect(stop).toHaveBeenCalled(); expect(el('preview-status').textContent).toContain('B · A4')
    oscillator.onended(); await tick(); expect(context.close).toHaveBeenCalled(); expect(oscillator.disconnect).toHaveBeenCalled()
    panel.dispose(); expect(context.close).toHaveBeenCalledOnce()
  })
  it('stops reference before A, passes the exact selected source range, and stops A before B', async () => {
    setup(); await input('start', .5); await input('end', 2); await click('play-tone')
    const oscillator = contexts.instances[0].oscillators[0]
    await click('play-original')
    expect(oscillator.disconnect).toHaveBeenCalled(); expect(playRange).toHaveBeenCalledWith(.5, 2, expect.objectContaining({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) }))
    const options = playRange.mock.calls[0][2]; expect(options.isCurrent()).toBe(true)
    await click('play-tone'); expect(options.signal.aborted).toBe(true); expect(options.isCurrent()).toBe(false); expect(stop).toHaveBeenCalled()
  })
  it.each(['stop', 'source', 'leave', 'dispose', 'original', 'target'])('never starts hidden tone when resume completes after %s', async interruption => {
    const pending = deferred(); setup({ resumePromise: pending.promise }); await click('play-tone')
    const context = contexts.instances[0]; expect(context.resume).toHaveBeenCalled()
    if (interruption === 'stop') await click('stop')
    else if (interruption === 'source') { source = null; notifySource() }
    else if (interruption === 'leave') document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode: 'master' } }))
    else if (interruption === 'dispose') panel.dispose()
    else if (interruption === 'original') await click('play-original')
    else await change('target', 60)
    pending.resolve(); await tick(); expect(context.oscillators).toHaveLength(0)
    expect(el('preview-status').textContent).not.toContain('B ·')
  })
  it('handles repeated B clicks without overlapping oscillators or sharing stalled contexts', async () => {
    const pending = deferred(); setup({ resumePromise: pending.promise }); await click('play-tone'); await click('play-tone')
    pending.resolve(); await tick(); expect(contexts.instances).toHaveLength(2); expect(contexts.instances[0].oscillators).toHaveLength(0); expect(contexts.instances[1].oscillators).toHaveLength(1)
    await click('play-tone'); expect(contexts.instances).toHaveLength(3); expect(contexts.instances[2].oscillators).toHaveLength(1)
    expect(contexts.instances[1].oscillators[0].disconnect).toHaveBeenCalled()
  })
  it('Stop lets a new B click recover even if the previous resume never settles', async () => {
    setup({ resumePromise: new Promise(() => {}) })
    await click('play-tone'); const first = contexts.instances[0]
    await click('stop'); expect(first.close).toHaveBeenCalledOnce()
    contexts.Context.prototype.resume = vi.fn(async function () { this.state = 'running' })
    // Class-field mock remains per instance; change only the second instance's
    // pending operation before the beforePlayback microtask calls resume.
    el('play-tone').click(); contexts.instances[1].resume = vi.fn().mockResolvedValue(undefined); await tick()
    expect(contexts.instances[1].oscillators).toHaveLength(1)
    expect(first.oscillators).toHaveLength(0)
    expect(el('preview-status').textContent).toContain('B · A4')
  })
  it('bounds a stuck resume and permits a new preview after timeout', async () => {
    vi.useFakeTimers()
    try {
      setup({ resumePromise: new Promise(() => {}), panelOptions: { resumeTimeoutMs: 50 } })
      await click('play-tone'); await vi.advanceTimersByTimeAsync(51)
      expect(el('preview-status').textContent).toContain('啟動逾時'); expect(contexts.instances[0].close).toHaveBeenCalledOnce()
      el('play-tone').click(); contexts.instances[1].resume = vi.fn().mockResolvedValue(undefined); await tick()
      expect(contexts.instances[1].oscillators).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })
  it.each(['play-tone', 'play-original'])('does not start %s after cancellation while beforePlayback is pending', async id => {
    const pending = deferred(), beforePlayback = vi.fn(() => pending.promise)
    setup({ panelOptions: { beforePlayback } }); await click(id); expect(beforePlayback).toHaveBeenCalledOnce()
    await click('stop'); pending.resolve(); await tick()
    expect(playRange).not.toHaveBeenCalled(); expect(contexts.instances.flatMap(context => context.oscillators)).toHaveLength(0)
  })
  it('aborts pending original playback and ignores late success', async () => {
    setup(); const pending = deferred(); playRange.mockReturnValue(pending.promise)
    await click('play-original'); const options = playRange.mock.calls[0][2]
    await click('stop'); expect(options.signal.aborted).toBe(true); expect(stop).toHaveBeenCalled()
    pending.resolve(); await tick(); expect(el('preview-status').textContent).toBe('已停止試聽')
  })
  it('marks original playback ended and does not let a late play promise revive it', async () => {
    setup(); const pending = deferred(); playRange.mockReturnValue(pending.promise)
    await click('play-original'); const options = playRange.mock.calls[0][2]
    options.onEnded(); pending.resolve(); await tick()
    expect(el('preview-status').textContent).toBe('原音片段已播完')
    expect(options.isCurrent()).toBe(false)
  })
  it('stops tone when volume changes, without automatically restarting it', async () => {
    setup(); await click('play-tone'); const oscillator = contexts.instances[0].oscillators[0]
    await input('tone-volume', .06); expect(oscillator.disconnect).toHaveBeenCalled(); expect(contexts.instances[0].oscillators).toHaveLength(1)
    await click('play-tone'); expect(contexts.instances[1].gains[0].gain.linearRampToValueAtTime).toHaveBeenCalledWith(.06, 4.025)
  })
})
