import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { initLyricsPanel } from '../../src/js/lyrics/panel.js'
import { createSession } from '../../src/js/lyrics/session.js'

vi.mock('../../src/js/audio/sha256.js', () => ({
  sha256Hex: vi.fn(async bytes => new Uint8Array(bytes)[0].toString(16).repeat(64)),
}))

const STORAGE_KEY = 'waveforge.lyrics.recovery.v1'
const html = readFileSync('index.html', 'utf8')
const el = id => document.getElementById(`lyrics-${id}`)
const command = id => document.querySelector(`[data-command="lyrics.${id}"]`).click()
const file = (name, byte) => ({ name, arrayBuffer: async () => new Uint8Array([byte]).buffer })
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function openControl(id) {
  const disclosure = el(id).closest('details')
  if (disclosure && !disclosure.open) disclosure.querySelector('summary').click()
}

function change(id, value) {
  openControl(id)
  el(id).value = String(value)
  el(id).dispatchEvent(new Event('change', { bubbles: true }))
}

function openProject(projectFile) {
  Object.defineProperty(el('project-file'), 'files', { configurable: true, value: [projectFile] })
  el('project-file').dispatchEvent(new Event('change', { bubbles: true }))
}

async function setup({ applyOriginal = true } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(parsed.getElementById('mode-lyrics'))
  document.getElementById('mode-lyrics').hidden = false
  const engine = { currentTime: 0, duration: 8, buffer: {}, seekTo: vi.fn() }
  const buffer = { duration: 8, numberOfChannels: 1, getChannelData: () => new Float32Array(8) }
  let currentFile
  const stopPlayback = vi.fn(() => { engine.currentTime = 0 })
  const panel = initLyricsPanel({ engine, getCurrentFile: () => currentFile, stopPlayback, playRange: vi.fn() })
  const load = async next => { currentFile = next; await panel.sourceAccepted(next, buffer) }
  const apply = raw => { openControl('raw'); el('raw').value = raw; command('apply') }
  const original = file('original.wav', 1)
  await load(original)
  if (applyOriginal) apply('Original lyric')
  return { panel, engine, load, apply, original, buffer, stopPlayback }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect() {}, fillRect() {} })
})

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('lyrics panel interrupted workflows', () => {
  it('renders imported lyrics, source names and alignment diagnostics without HTML execution', async () => {
    const { apply, load } = await setup({ applyOriginal: false })
    const payload = '<img src=x onerror="globalThis.__wfXss=1"><svg onload="globalThis.__wfXss=1">'
    await load(file(payload, 2)); apply(payload)
    expect(el('list').querySelector('.lyrics-line-text').textContent).toBe(payload)
    expect(el('source').textContent).toContain(payload)
    const project = createSession(payload, { name: payload, hash: '2'.repeat(64), duration: 8 })
    project.lines[0].alignment = { status: 'unresolved', evidence: { coverage: 0, reasons: [payload] }, engine: payload, model: payload, modelRevision: payload, language: 'en', backend: 'wasm', pass: 1 }
    openProject({ size: 2000, text: async () => JSON.stringify(project) })
    await vi.advanceTimersByTimeAsync(0)
    expect(el('selected-text').textContent).toBe(payload)
    expect(document.querySelector('#mode-lyrics img, #mode-lyrics svg[onload], #mode-lyrics [onerror]')).toBeNull()
    expect(globalThis.__wfXss).toBeUndefined()
  })
  it('starts with paste only, then exposes timing and keeps the original editor closed after application', async () => {
    const { apply } = await setup({ applyOriginal: false })
    expect(el('original').open).toBe(true)
    expect(el('editor').hidden).toBe(true)
    expect(el('alignment').hidden).toBe(true)
    expect(el('delivery').hidden).toBe(true)
    expect(el('model-settings').open).toBe(false)
    expect(el('help').open).toBe(false)
    el('raw').focus()
    apply('First line\n\nLast line')
    expect(el('original').open).toBe(false)
    expect(el('editor').hidden).toBe(false)
    expect(el('alignment').hidden).toBe(false)
    expect(el('delivery').hidden).toBe(false)
    expect(document.activeElement).toBe(el('waveform'))
    expect(el('original-summary').textContent).toContain('3 行')
    expect(el('list').querySelectorAll('.lyrics-line-text')).toHaveLength(3)
    expect(el('list').querySelector('.lyrics-line-text').textContent).toBe('First line')
    expect(el('list').querySelector('.lyrics-line-time').textContent).toBe('— → —')
    expect(el('line-count').textContent).toBe('0／2 句已確認')
    expect(el('model-consent').closest('details')).toBeNull()
    expect(el('model-info').closest('details')).toBeNull()
    expect(el('model-privacy').textContent).toContain('huggingface.co（收到下載請求）')
    expect(el('model-privacy').textContent).toContain('不會上傳')
    expect(document.querySelector('[data-command="lyrics.align"]').disabled).toBe(true)
  })

  it('keeps explicitly opened original text open across timing edits and returns to paste when undo removes the lyrics', async () => {
    const { apply } = await setup({ applyOriginal: false })
    apply('Original line')
    openControl('raw')
    expect(el('original').open).toBe(true)
    change('start-value', 1)
    expect(el('original').open).toBe(true)
    expect(el('list').querySelector('.lyrics-line-time').textContent).toBe('1.00 → —')
    command('undo')
    command('undo')
    expect(el('original').open).toBe(true)
    expect(el('editor').hidden).toBe(true)
    command('redo')
    expect(el('original').open).toBe(false)
    expect(el('editor').hidden).toBe(false)
  })

  it.each(['row', 'waveform'])('keeps keyboard undo and redo in a visible lyrics region from %s', async target => {
    const { apply } = await setup({ applyOriginal: false })
    apply('First line')
    const focusTarget = target === 'row' ? el('list').querySelector('[data-line]') : el('waveform')
    focusTarget.focus()
    focusTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
    expect(el('editor').hidden).toBe(true)
    expect(document.activeElement).toBe(el('original-summary'))
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
    expect(el('editor').hidden).toBe(false)
    expect(el('raw').value).toBe('First line')
    expect(document.activeElement).toBe(el('waveform'))
  })

  it('opens a recovered meaningful project directly into the timing workspace', async () => {
    await setup({ applyOriginal: false })
    const restored = createSession('Recovered lyric')
    openProject({ name: 'recovered.json', size: 1000, text: async () => JSON.stringify(restored) })
    await vi.advanceTimersByTimeAsync(0)
    expect(el('original').open).toBe(false)
    expect(el('raw').value).toBe('Recovered lyric')
    expect(el('editor').hidden).toBe(false)
    expect(el('selected-text').textContent).toBe('Recovered lyric')
    expect(el('model-settings').open).toBe(false)
  })

  it('does not let an obsolete source hash failure disconnect a newer accepted source', async () => {
    const { load, apply, engine } = await setup()
    const read = deferred()
    const pending = load({ name: 'old-pending.wav', arrayBuffer: () => read.promise })
    await load(file('newest.wav', 3))
    apply('New lyric')
    read.reject(new Error('obsolete read failed'))
    await pending
    engine.currentTime = 1
    command('start')
    expect(el('start-value').value).toBe('1')
    expect(el('source').textContent).toContain('newest.wav')
    expect(el('status').textContent).not.toContain('obsolete read failed')
  })

  it('preserves the latest old-source timings when replacement precedes the autosave debounce', async () => {
    const { load } = await setup()
    change('start-value', 1)
    change('end-value', 2)
    command('confirm')
    await vi.advanceTimersByTimeAsync(400)
    change('start-value', 1.25)
    await load(file('replacement.wav', 2))
    await vi.advanceTimersByTimeAsync(400)
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(saved.source.name).toBe('original.wav')
    expect(saved.lines[0].start).toBe(1.25)
    expect(saved.lines[0].end).toBe(2)
  })

  it('retains previous-source timings in Undo when replacement cannot back up to storage', async () => {
    const { load } = await setup()
    change('start-value', 1)
    change('end-value', 2)
    command('confirm')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    await load(file('replacement.wav', 2))
    expect(el('status').textContent).toContain('備份失敗')
    expect(el('status').textContent).not.toContain('上次備份仍可恢復')
    command('undo')
    expect(el('raw').value).toBe('Original lyric')
    expect(el('start-value').value).toBe('1')
    expect(el('end-value').value).toBe('2')
    expect(el('list').firstElementChild.textContent).toContain('已確認')
  })

  it('locks timing during source loading and reconnects the unchanged session after failed replacement', async () => {
    const { panel, original, buffer, engine, stopPlayback } = await setup()
    change('start-value', 1)
    change('end-value', 2)
    panel.sourceLoading()
    expect(el('start-value').disabled).toBe(true)
    expect(document.querySelector('[data-command="lyrics.start"]').disabled).toBe(true)
    engine.currentTime = 1.5 // The main loader restores the previous playhead on failure.
    stopPlayback.mockClear()
    await panel.sourceFailed(original, buffer)
    expect(el('start-value').disabled).toBe(false)
    expect(el('start-value').value).toBe('1')
    expect(el('end-value').value).toBe('2')
    expect(engine.currentTime).toBe(1.5)
    expect(stopPlayback).not.toHaveBeenCalled()
    expect(el('source').textContent).toContain('來源已連結')
  })

  it('preserves an existing recovery backup when audio is loaded before lyrics are recovered', async () => {
    const saved = createSession('Previously saved lyric', { name: 'original.wav', hash: '1'.repeat(64), duration: 8 })
    Object.assign(saved.lines[0], { start: 1, end: 2, confirmed: true })
    const payload = JSON.stringify(saved)
    localStorage.setItem(STORAGE_KEY, payload)
    const { load, original } = await setup({ applyOriginal: false })
    expect(localStorage.getItem(STORAGE_KEY)).toBe(payload)
    change('offset', '') // Rejected input is not a new lyric revision.
    await load(file('second-source-only.wav', 2))
    expect(localStorage.getItem(STORAGE_KEY)).toBe(payload)
    command('recover')
    expect(el('raw').value).toBe('Previously saved lyric')
    expect(el('start-value').value).toBe('1')
    expect(el('source').textContent).toContain('來源未連結')
    await load(original)
    expect(el('source').textContent).toContain('來源已連結')
  })

  it('restoring a project replaces pending autosave ownership and backs up the restored project', async () => {
    await setup()
    const restored = createSession('Imported lyric', { name: 'original.wav', hash: '1'.repeat(64), duration: 8 })
    restored.revision = 7
    openProject({ name: 'project.json', size: 1000, text: async () => JSON.stringify(restored) })
    await vi.advanceTimersByTimeAsync(400)
    expect(el('raw').value).toBe('Imported lyric')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual(restored)
  })

  it('also backs up a restored project when there is no older pending autosave', async () => {
    await setup()
    await vi.advanceTimersByTimeAsync(400)
    const restored = createSession('Imported lyric', { name: 'original.wav', hash: '1'.repeat(64), duration: 8 })
    restored.revision = 7
    openProject({ name: 'project.json', size: 1000, text: async () => JSON.stringify(restored) })
    await vi.advanceTimersByTimeAsync(400)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY))).toEqual(restored)
  })

  it('flushes the most recent edit immediately when the source is cleared', async () => {
    const { panel } = await setup()
    change('start-value', 1.25)
    panel.clear()
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(saved.lines[0].start).toBe(1.25)
    expect(saved.source.name).toBe('original.wav')
    expect(el('raw').value).toBe('Original lyric')
  })

  it('flushes the most recent edit on pagehide without waiting for the debounce', async () => {
    await setup()
    change('start-value', 1.25)
    window.dispatchEvent(new Event('pagehide'))
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY))
    expect(saved.lines[0].start).toBe(1.25)
  })

  it('resumes clock display after a persisted pagehide/pageshow navigation', async () => {
    const { engine } = await setup()
    const hide = new Event('pagehide')
    Object.defineProperty(hide, 'persisted', { value: true })
    window.dispatchEvent(hide)
    const show = new Event('pageshow')
    Object.defineProperty(show, 'persisted', { value: true })
    window.dispatchEvent(show)
    engine.currentTime = 3
    await vi.advanceTimersByTimeAsync(100)
    expect(el('position').textContent).toBe('3.000 s')
  })

  it('rejects a project read that finishes after a newer lyric edit', async () => {
    const { apply } = await setup()
    const read = deferred()
    openProject({ name: 'slow.json', size: 1000, text: () => read.promise })
    apply('My newer draft')
    read.resolve(JSON.stringify(createSession('Old imported lyric')))
    await vi.advanceTimersByTimeAsync(400)
    expect(el('raw').value).toBe('My newer draft')
    expect(el('status').textContent).toContain('請重新開啟')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).rawText).toBe('My newer draft')
  })

  it('keeps the selected lyric row focused across consecutive keyboard timing edits', async () => {
    const { engine } = await setup()
    el('list').firstElementChild.focus()
    engine.currentTime = 1
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: '[', altKey: true, bubbles: true }))
    expect(document.activeElement.dataset.line).toBe('line-1')
    engine.currentTime = 2
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: ']', altKey: true, bubbles: true }))
    expect(el('start-value').value).toBe('1')
    expect(el('end-value').value).toBe('2')
  })

  it('does not steal focus from a timing input when rendering an edit', async () => {
    await setup()
    el('start-value').focus()
    change('start-value', 1)
    expect(document.activeElement).toBe(el('start-value'))
  })
})
