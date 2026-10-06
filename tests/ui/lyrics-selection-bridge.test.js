import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initLyricsPanel } from '../../src/js/lyrics/panel.js'
import { createSession } from '../../src/js/lyrics/session.js'

vi.mock('../../src/js/audio/sha256.js', () => ({
  sha256Hex: vi.fn(async bytes => new Uint8Array(bytes)[0].toString(16).repeat(64)),
}))

const html = readFileSync('index.html', 'utf8')
const el = id => document.getElementById(`lyrics-${id}`)
const command = name => document.querySelector(`[data-command="lyrics.${name}"]`).click()
const choose = id => document.querySelector(`[data-line="${id}"]`).click()
const change = (id, value) => {
  el(id).value = String(value)
  el(id).dispatchEvent(new Event('change', { bubbles: true }))
}
const draft = text => { el('raw').value = text; el('raw').dispatchEvent(new Event('input', { bubbles: true })) }
const settle = () => vi.advanceTimersByTimeAsync(0)
const file = (name = 'original.wav', byte = 1) => ({ name, arrayBuffer: async () => new Uint8Array([byte]).buffer })

async function setup({ timed = true } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(parsed.getElementById('mode-lyrics'))
  document.getElementById('mode-lyrics').hidden = false
  const buffer = { duration: 12, numberOfChannels: 1, getChannelData: () => new Float32Array(12) }
  const engine = { currentTime: 0, duration: 12, buffer, seekTo: vi.fn() }
  const service = { dispose: vi.fn(), run: vi.fn(async request => ({
    version: 1, status: 'complete', candidates: request.targetIds.map((id, index) => ({
      id, text: request.lines.find(line => line.id === id).text, status: 'matched', start: index + 1, end: index + 2,
      evidence: { coverage: 1, reasons: [] },
    })), run: { sourceHash: request.source.hash, sourceRevision: request.revision,
      engine: 'synthetic', model: 'synthetic', modelRevision: 'synthetic', language: request.language, backend: 'synthetic', pass: 1 },
  })) }
  let currentFile = file()
  const panel = initLyricsPanel({ engine, getCurrentFile: () => currentFile,
    playRange: vi.fn(), stopPlayback: vi.fn(), alignmentService: service })
  const load = async (next = file()) => { currentFile = next; await panel.sourceAccepted(next, buffer) }
  await load()
  el('raw').value = 'First sentence!\nSecond sentence?'; command('apply')
  if (timed) { change('start-value', 1.25); change('end-value', 3.5) }
  return { panel, engine, service, load }
}

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect() {} })
})
afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('read-only lyric sentence selection bridge', () => {
  it('exposes only detached accepted sentence timing and source identity, excluding subtitle offsets', async () => {
    const { panel } = await setup()
    const first = panel.getSelectionSnapshot()
    expect(first).toMatchObject({ version: 1, ready: true, blocker: '', precision: 'sentence',
      source: { name: 'original.wav', hash: '1'.repeat(64), duration: 12 },
      line: { id: 'line-1', text: 'First sentence!', sung: true, start: 1.25, end: 3.5, confirmed: false, timingOrigin: 'manual' },
    })
    expect(first).not.toHaveProperty('rawText')
    expect(first).not.toHaveProperty('displayOffsetMs')
    first.line.text = 'changed'; first.line.start = 9; first.source.hash = 'x'
    expect(panel.getSelectionSnapshot().line).toMatchObject({ text: 'First sentence!', start: 1.25 })
    expect(panel.getSelectionSnapshot().source.hash).toBe('1'.repeat(64))
    change('offset', 1000)
    expect(panel.getSelectionSnapshot().token).not.toBe(first.token)
    expect(panel.getSelectionSnapshot().line).toMatchObject({ start: 1.25, end: 3.5 })
  })

  it('keeps a stable token and sends no subscriber events for playback, repaint, or choosing the same row', async () => {
    const { panel, engine } = await setup(), listener = vi.fn()
    panel.subscribeSelection(listener)
    const token = panel.getSelectionSnapshot().token
    engine.currentTime = 2.75
    await vi.advanceTimersByTimeAsync(1000)
    choose('line-1')
    el('overlap').dispatchEvent(new Event('change', { bubbles: true }))
    expect(panel.getSelectionSnapshot().token).toBe(token)
    expect(listener).not.toHaveBeenCalled()
  })

  it('invalidates selection away and back, returns detached notifications and supports unsubscribe', async () => {
    const { panel } = await setup(), listener = vi.fn(snapshot => { snapshot.line.text = 'listener edit' })
    const unsubscribe = panel.subscribeSelection(listener), token = panel.getSelectionSnapshot().token
    choose('line-2')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: false, line: { id: 'line-2', start: null, end: null, text: 'Second sentence?' } })
    choose('line-1')
    expect(listener).toHaveBeenCalledTimes(2)
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: true, line: { text: 'First sentence!' } })
    expect(panel.getSelectionSnapshot().token).not.toBe(token)
    unsubscribe(); choose('line-2')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('invalidates unapplied draft changes even when the user returns to the original text', async () => {
    const { panel } = await setup(), listener = vi.fn()
    panel.subscribeSelection(listener)
    const original = panel.getSelectionSnapshot(), originalText = el('raw').value
    draft('Replacement words')
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: false, blocker: '原文有修改，請先按「套用歌詞」', line: original.line })
    draft(originalText)
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: true, line: original.line })
    expect(panel.getSelectionSnapshot().token).not.toBe(original.token)
    expect(listener).toHaveBeenCalledTimes(2)
    command('apply')
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: false, line: { start: null, end: null } })
  })

  it('isolates an observer failure from other listeners, source invalidation, history and recovery', async () => {
    const { panel } = await setup(), listener = vi.fn()
    const error = new Error('Synthetic observer failure')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    panel.subscribeSelection(() => { throw error })
    panel.subscribeSelection(listener)
    change('start-value', 2)
    await vi.advanceTimersByTimeAsync(400)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true, line: expect.objectContaining({ start: 2 }) }))
    expect(JSON.parse(localStorage.getItem('waveforge.lyrics.recovery.v1')).lines[0].start).toBe(2)
    command('undo')
    expect(panel.getSelectionSnapshot().line.start).toBe(1.25)
    panel.sourceLoading()
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }))
    expect(panel.getSelectionSnapshot().ready).toBe(false)
    expect(logged).toHaveBeenCalledWith('[wf:lyrics-selection]', error)
  })

  it('invalidates edits, undo, redo and restored sessions even when stored revisions repeat', async () => {
    const { panel } = await setup(), original = panel.getSelectionSnapshot()
    change('start-value', 2)
    const edited = panel.getSelectionSnapshot()
    command('undo')
    const undone = panel.getSelectionSnapshot()
    expect(undone.line.start).toBe(1.25)
    expect(undone.sessionRevision).toBe(original.sessionRevision)
    expect(undone.token).not.toBe(original.token)
    command('redo')
    const redone = panel.getSelectionSnapshot()
    expect(redone.line.start).toBe(2)
    expect(redone.token).not.toBe(edited.token)
    const restored = createSession('Restored sentence', original.source)
    restored.revision = redone.sessionRevision
    restored.lines[0].start = 5; restored.lines[0].end = 6
    Object.defineProperty(el('project-file'), 'files', { configurable: true, value: [{ size: 1000, text: async () => JSON.stringify(restored) }] })
    el('project-file').dispatchEvent(new Event('change', { bubbles: true })); await settle()
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: true, sessionRevision: redone.sessionRevision, line: { text: 'Restored sentence', start: 5, end: 6 } })
    expect(panel.getSelectionSnapshot().token).not.toBe(redone.token)
  })

  it('blocks partial or non-sung timing and invalidates source loading, reacceptance, failure and clear', async () => {
    const { panel, load } = await setup({ timed: false })
    expect(panel.getSelectionSnapshot().ready).toBe(false)
    change('start-value', 1)
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: false, line: { start: 1, end: null } })
    change('end-value', 2)
    expect(panel.getSelectionSnapshot().ready).toBe(true)
    el('sung').checked = false; el('sung').dispatchEvent(new Event('change', { bubbles: true }))
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: false, blocker: '請選取演唱歌詞行' })
    el('sung').checked = true; el('sung').dispatchEvent(new Event('change', { bubbles: true }))
    const accepted = panel.getSelectionSnapshot()
    panel.sourceLoading()
    expect(panel.getSelectionSnapshot().ready).toBe(false)
    const loading = panel.getSelectionSnapshot().token
    await load()
    expect(panel.getSelectionSnapshot().ready).toBe(true)
    expect(panel.getSelectionSnapshot().token).not.toBe(accepted.token)
    expect(panel.getSelectionSnapshot().token).not.toBe(loading)
    panel.sourceFailed()
    expect(panel.getSelectionSnapshot().ready).toBe(false)
    await load()
    const reaccepted = panel.getSelectionSnapshot().token
    panel.clear()
    expect(panel.getSelectionSnapshot().ready).toBe(false)
    expect(panel.getSelectionSnapshot().token).not.toBe(reaccepted)
  })

  it('never presents an unadopted automatic candidate as accepted sentence timing', async () => {
    const { panel, service } = await setup({ timed: false })
    change('language', 'en')
    el('model-consent').checked = true; el('model-consent').dispatchEvent(new Event('change', { bubbles: true }))
    const before = panel.getSelectionSnapshot()
    command('align'); await settle()
    expect(service.run).toHaveBeenCalledTimes(1)
    expect(panel.getSelectionSnapshot()).toEqual(before)
    command('align.adopt')
    expect(panel.getSelectionSnapshot()).toMatchObject({ ready: true, precision: 'sentence',
      line: { text: 'First sentence!', start: 1, end: 2, confirmed: false, timingOrigin: 'automatic' } })
    expect(panel.getSelectionSnapshot().token).not.toBe(before.token)
  })
})
