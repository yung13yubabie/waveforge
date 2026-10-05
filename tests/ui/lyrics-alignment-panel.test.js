// Injected recognition results test orchestration only, not model quality.
import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { initLyricsPanel } from '../../src/js/lyrics/panel.js'
import { createSession } from '../../src/js/lyrics/session.js'

vi.mock('../../src/js/audio/sha256.js', () => ({
  sha256Hex: vi.fn(async bytes => new Uint8Array(bytes)[0].toString(16).repeat(64)),
}))

const html = readFileSync('index.html', 'utf8')
const key = 'waveforge.lyrics.recovery.v1'
const rawText = '第一句 🎵\n\nSame chorus!\nSame chorus!'
const el = id => document.getElementById(`lyrics-${id}`)
const button = name => document.querySelector(`[data-command="lyrics.${name}"]`)
const click = name => button(name).click()
const file = (name, byte) => ({ name, arrayBuffer: async () => new Uint8Array([byte]).buffer })
const settle = () => vi.advanceTimersByTimeAsync(0)
const saved = () => JSON.parse(localStorage.getItem(key))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function change(id, value) {
  el(id).value = String(value)
  el(id).dispatchEvent(new Event('change', { bubbles: true }))
}
function check(id, value = true) {
  el(id).checked = value
  el(id).dispatchEvent(new Event('change', { bubbles: true }))
}
function choose(id) { document.querySelector(`[data-line="${id}"]`).click() }
function resultFor(request, overrides = {}) {
  return {
    version: 1, status: 'completed', diagnostics: [],
    candidates: request.targetIds.map((id, i) => {
      const line = request.lines.find(item => item.id === id)
      return { id, text: line.text, index: request.lines.indexOf(line), status: 'matched', start: 1 + i * 2, end: 2 + i * 2,
        evidence: { coverage: .9, matchedCharacters: 9, totalCharacters: 10, wordIndices: [i], unmatchedText: '', reasons: ['請試聽句尾'] } }
    }),
    run: { sourceHash: request.source.hash, sourceRevision: request.revision, engine: 'test-local', model: 'test-model', modelRevision: 'test-revision', language: request.language, backend: 'test', pass: request.secondPass ? 2 : 1 },
    ...overrides,
  }
}
async function setup({ pending = false, raw = rawText } = {}) {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  document.body.replaceChildren(parsed.getElementById('mode-lyrics'))
  document.getElementById('mode-lyrics').hidden = false
  const buffer = { duration: 12, sampleRate: 16000, numberOfChannels: 1, getChannelData: () => new Float32Array(12) }
  const engine = { currentTime: 0, duration: 12, buffer, seekTo: vi.fn() }
  const work = deferred()
  const service = {
    info: { name: '測試本機模型', downloadBytes: 66406756, runtimeAssetBytes: 21640503, modelUrl: 'https://example.com/model', license: 'MIT', licenseUrl: 'https://example.com/license' },
    run: vi.fn(request => pending ? work.promise : Promise.resolve(resultFor(request))), dispose: vi.fn(), clearCache: vi.fn(async () => ({ deleted: true, persistentCacheAvailable: true })),
  }
  let currentFile = file('original.wav', 1)
  const playRange = vi.fn(), stopPlayback = vi.fn()
  const panel = initLyricsPanel({ engine, getCurrentFile: () => currentFile, playRange, stopPlayback, alignmentService: service })
  await panel.sourceAccepted(currentFile, buffer)
  el('raw').value = raw; click('apply')
  await vi.advanceTimersByTimeAsync(400)
  const configure = () => { change('language', 'zh'); check('model-consent') }
  const load = async (next = file('replacement.wav', 2)) => {
    panel.sourceLoading(); currentFile = next; engine.buffer = { ...buffer }
    await panel.sourceAccepted(next, engine.buffer)
  }
  return { panel, engine, service, work, configure, load, playRange }
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

describe('local lyric alignment controls and proposals', () => {
  it('requires explicit language and model download consent without auto-detection or startup recognition', async () => {
    const { service } = await setup()
    expect(service.run).not.toHaveBeenCalled()
    expect([...el('language').options].map(option => option.value)).not.toContain('auto')
    expect(el('model-info').textContent).toContain('63.3 MiB')
    expect(el('model-info').textContent).toContain('同站執行檔（約 20.6 MiB）')
    expect(el('model-link').href).toBe('https://example.com/model')
    expect(button('align').disabled).toBe(true)
    change('language', 'zh')
    expect(button('align').disabled).toBe(true)
    check('model-consent')
    expect(button('align').disabled).toBe(false)
    click('align'); await settle()
    expect(service.run).toHaveBeenCalledTimes(1)
    expect(service.run.mock.calls[0][0].language).toBe('zh')
    expect(service.run.mock.calls[0][0].modelSourceApproved).toBe(true)
    expect(service.run.mock.calls[0][0].lines.map(line => line.text).join('\n')).toBe(rawText)
  })

  it('clears model cache only on an explicit click and preserves original work', async () => {
    const { configure, service } = await setup()
    const clear = deferred(); service.clearCache.mockReturnValue(clear.promise)
    const before = localStorage.getItem(key)
    configure(); expect(service.clearCache).not.toHaveBeenCalled()
    click('align.clear-cache')
    expect(service.clearCache).toHaveBeenCalledTimes(1)
    expect(button('align').disabled).toBe(true)
    expect(button('align.clear-cache').disabled).toBe(true)
    clear.resolve({ deleted: true, persistentCacheAvailable: true }); await settle()
    expect(el('alignment-message').textContent).toContain('模型快取已清除')
    expect(localStorage.getItem(key)).toBe(before)
    expect(service.run).not.toHaveBeenCalled()
    expect(button('align').disabled).toBe(false)
  })

  it('reports cache deletion failure honestly and disables deletion during analysis', async () => {
    const { configure, service } = await setup({ pending: true })
    service.clearCache.mockRejectedValueOnce(new Error('此瀏覽器不支援快取管理'))
    click('align.clear-cache'); await settle()
    expect(el('alignment-message').textContent).toContain('模型快取刪除失敗')
    expect(el('alignment-message').textContent).not.toContain('已清除')
    configure(); click('align')
    expect(button('align.clear-cache').disabled).toBe(true)
    click('align.clear-cache'); expect(service.clearCache).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ deleted: false, persistentCacheAvailable: false }, '不支援持久模型快取'],
    [{ deleted: false, persistentCacheAvailable: true }, '沒有已下載的模型快取可刪除'],
    [undefined, '未收到模型快取刪除確認'],
  ])('does not invent a successful cache deletion for %j', async (outcome, expected) => {
    const { service } = await setup()
    service.clearCache.mockResolvedValueOnce(outcome)
    const before = localStorage.getItem(key)
    click('align.clear-cache'); await settle()
    expect(el('alignment-message').textContent).toContain(expected)
    expect(el('alignment-message').textContent).not.toContain('模型快取已清除')
    expect(localStorage.getItem(key)).toBe(before)
  })

  it.each([
    ['reading-cache', '讀取已下載的模型'], ['cache-unavailable', '瀏覽器無法保存模型'],
    ['verifying', '核對模型檔案完整性'], ['loading', '載入本機辨識模型'],
    ['transcribing', '辨識這段演唱'], ['complete', '這段辨識結束'],
    ['preparing', '準備分析音訊'], ['matching', '比對原文與辨識結果'],
  ])('explains the actual %s phase without invented progress', async (phase, expected) => {
    const { service, configure } = await setup({ pending: true })
    configure(); click('align')
    service.run.mock.calls[0][0].onProgress({ phase })
    expect(el('alignment-message').textContent).toContain(expected)
    expect(el('model-progress').hidden).toBe(true)
    expect(el('alignment-message').textContent).not.toContain('%')
  })

  it('prefers measured aggregate file preparation bytes, including cached data, and keeps inference separate', async () => {
    const { service, configure } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    request.onProgress({ phase: 'reading-cache', loaded: 1048576, total: 2097152, aggregateLoaded: 5242880, aggregateTotal: 66406756 })
    expect(el('model-progress').value).toBe(5242880)
    expect(el('model-progress').max).toBe(66406756)
    expect(el('alignment-message').textContent).toContain('模型檔案準備 5.0／63.3 MiB（含快取讀取）')
    expect(el('model-progress').getAttribute('aria-label')).toContain('含快取讀取')
    request.onProgress({ phase: 'downloading', loaded: 1048576, total: 2097152 })
    expect(el('alignment-message').textContent).toContain('單一模型檔案準備 1.0／2.0 MiB')
    request.onProgress({ phase: 'transcribing', aggregateLoaded: 66406756, aggregateTotal: 66406756 })
    expect(el('model-progress').hidden).toBe(true)
    expect(el('alignment-message').textContent).not.toContain('MiB')
  })

  it('shows real download/phase progress without rebuilding the focused lyric list or fabricating percentages', async () => {
    const { service, configure } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    const row = el('list').firstElementChild; row.focus()
    request.onProgress({ phase: 'download', loaded: 1048576, total: 10485760, message: '下載模型檔案' })
    expect(el('model-progress').value).toBe(1048576)
    expect(el('model-progress').max).toBe(10485760)
    expect(el('alignment-message').textContent).toContain('1.0／10.0 MiB')
    request.onProgress({ phase: 'transcribing', chunkIndex: 1, chunkCount: 4 })
    expect(el('model-progress').hidden).toBe(true)
    expect(el('alignment-message').textContent).toContain('片段 1／4')
    expect(el('alignment-message').textContent).not.toContain('%')
    expect(document.activeElement).toBe(row)
    expect(el('list').firstElementChild).toBe(row)
    click('align')
    expect(service.run).toHaveBeenCalledTimes(1)
  })

  it('keeps candidates outside the saved session, exposes old/new evidence and previews the proposed range', async () => {
    const { configure, playRange } = await setup()
    const before = localStorage.getItem(key)
    configure(); click('align'); await settle()
    expect(el('proposal').hidden).toBe(false)
    expect(el('proposal-summary').textContent).toContain('找到 3 句')
    expect(el('candidate-times').textContent).toContain('1.000–2.000 秒')
    expect(el('candidate-reasons').textContent).toContain('9／10')
    expect(el('line-evidence').textContent).toContain('不是辨識正確率')
    expect(el('start-value').value).toBe('')
    expect(localStorage.getItem(key)).toBe(before)
    click('align.play'); await settle()
    expect(playRange).toHaveBeenCalledWith(1, 2, false)
    click('align.discard')
    expect(el('proposal').hidden).toBe(true)
    expect(localStorage.getItem(key)).toBe(before)
  })

  it('adopts a whole batch as one undo step, saves exact original text and leaves confirmation required', async () => {
    const { configure } = await setup()
    configure(); click('align'); await settle(); click('align.adopt')
    await vi.advanceTimersByTimeAsync(400)
    expect(saved().rawText).toBe(rawText)
    expect(saved().lines.filter(line => line.sung).map(line => line.start)).toEqual([1, 3, 5])
    expect(saved().lines.every(line => !line.confirmed)).toBe(true)
    expect(el('diagnostics').textContent).toContain('尚未確認')
    click('undo'); await vi.advanceTimersByTimeAsync(400)
    expect(saved().lines.every(line => line.start === null)).toBe(true)
    click('redo'); await vi.advanceTimersByTimeAsync(400)
    expect(saved().lines.filter(line => line.sung).map(line => line.start)).toEqual([1, 3, 5])
  })

  it('preserves manual times and scopes a second pass to the selected unlocked line', async () => {
    const { configure, service } = await setup()
    change('start-value', .2); change('end-value', .8)
    expect(el('manual-lock').checked).toBe(true)
    configure(); expect(button('align.selected').disabled).toBe(true)
    choose('line-3'); click('align.selected'); await settle()
    const request = service.run.mock.calls[0][0]
    expect(request.targetIds).toEqual(['line-3'])
    expect(request.secondPass).toBe(true)
    click('align.adopt'); await vi.advanceTimersByTimeAsync(400)
    expect(saved().lines[0]).toMatchObject({ start: .2, end: .8, manualLocked: true })
    expect(saved().lines[2].start).toBe(1)
    expect(saved().lines[3].start).toBe(null)
  })

  it('persists unresolved evidence without inventing or clearing times', async () => {
    const { configure, service } = await setup({ raw: '未找到的句子' })
    change('start-value', 4); change('end-value', 5); check('manual-lock', false)
    service.run.mockImplementation(request => Promise.resolve(resultFor(request, {
      candidates: [{ id: 'line-1', text: request.lines[0].text, index: 0, status: 'unresolved', start: null, end: null,
        evidence: { coverage: 0, reasons: ['沒有足夠的文字吻合依據'] } }],
    })))
    configure(); click('align.selected'); await settle()
    expect(el('candidate-times').textContent).toContain('此次未找到，保留原時間')
    click('align.adopt'); await vi.advanceTimersByTimeAsync(400)
    expect(saved().lines[0]).toMatchObject({ start: 4, end: 5, confirmed: false, alignment: { status: 'unresolved' } })
    expect(el('candidate-reasons').textContent).toContain('沒有足夠')
    expect(el('candidate-times').textContent).toContain('保留原時間')
  })
})

describe('interrupted local alignment', () => {
  it('cancels immediately and ignores all progress/results from the cancelled task', async () => {
    const { configure, service, work } = await setup({ pending: true })
    const before = localStorage.getItem(key)
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    click('align.cancel')
    expect(request.signal.aborted).toBe(true)
    request.onProgress({ phase: 'matching', message: 'obsolete progress' })
    work.resolve(resultFor(request)); await settle()
    expect(el('alignment-message').textContent).toContain('已取消')
    expect(el('alignment-message').textContent).not.toContain('obsolete')
    expect(el('proposal').hidden).toBe(true)
    expect(localStorage.getItem(key)).toBe(before)
  })

  it('cannot let an older rejection overwrite a newer completed proposal', async () => {
    const { configure, service, work } = await setup({ pending: true })
    configure(); click('align'); click('align.cancel')
    service.run.mockImplementation(request => Promise.resolve(resultFor(request)))
    click('align'); await settle()
    work.reject(new Error('obsolete error')); await settle()
    expect(el('proposal').hidden).toBe(false)
    expect(el('alignment-message').textContent).not.toContain('obsolete error')
  })

  it('invalidates analysis on a manual timing edit and preserves that edit', async () => {
    const { configure, service, work } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    change('start-value', .4)
    expect(request.signal.aborted).toBe(true)
    work.resolve(resultFor(request)); await vi.advanceTimersByTimeAsync(400)
    expect(el('proposal').hidden).toBe(true)
    expect(saved().lines[0].start).toBe(.4)
  })

  it('requires applying a changed raw draft and never revives a cancelled task if the draft is changed back', async () => {
    const { configure, service, work } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    el('raw').value += '!'; el('raw').dispatchEvent(new Event('input'))
    expect(request.signal.aborted).toBe(true)
    expect(el('alignment-availability').textContent).toContain('請先按「套用歌詞」')
    el('raw').value = rawText; el('raw').dispatchEvent(new Event('input'))
    work.resolve(resultFor(request)); await settle()
    expect(el('proposal').hidden).toBe(true)
    expect(saved().rawText).toBe(rawText)
  })

  it('invalidates pending results on source replacement and clear', async () => {
    const { configure, service, work, load, panel } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    await load(); work.resolve(resultFor(request)); await settle()
    expect(request.signal.aborted).toBe(true)
    expect(el('proposal').hidden).toBe(true)
    expect(el('source').textContent).toContain('replacement.wav')
    service.run.mockImplementation(next => Promise.resolve(resultFor(next)))
    click('align'); await settle()
    expect(el('proposal').hidden).toBe(false)
    panel.clear()
    expect(el('proposal').hidden).toBe(true)
    expect(service.dispose).toHaveBeenCalled()
  })

  it('cancels on undo, language change and withdrawn download consent', async () => {
    const { configure, service } = await setup({ pending: true })
    configure(); click('align')
    const first = service.run.mock.calls[0][0]
    click('undo'); expect(first.signal.aborted).toBe(true)
    click('redo'); click('align')
    const second = service.run.mock.calls[1][0]
    change('language', 'en'); expect(second.signal.aborted).toBe(true)
    click('align')
    const third = service.run.mock.calls[2][0]
    check('model-consent', false); expect(third.signal.aborted).toBe(true)
    expect(button('align').disabled).toBe(true)
  })

  it('aborts on BFCache navigation and resumes usable controls without restarting analysis', async () => {
    const { configure, service } = await setup({ pending: true })
    configure(); click('align')
    const request = service.run.mock.calls[0][0]
    const hide = new Event('pagehide'); Object.defineProperty(hide, 'persisted', { value: true })
    window.dispatchEvent(hide); window.dispatchEvent(new Event('pageshow'))
    expect(request.signal.aborted).toBe(true)
    expect(button('align').disabled).toBe(false)
    expect(button('align.cancel').disabled).toBe(true)
    expect(service.run).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['TimeoutError', 'Whisper transcription timed out', '分析等待時間過長'],
    ['ModelSourceApprovalError', 'Approve the pinned model source and download before transcription', '模型來源與下載尚未獲同意'],
  ])('translates %s and preserves the original work', async (name, message, expected) => {
    const { configure, service } = await setup()
    service.run.mockRejectedValueOnce(Object.assign(new Error(message), { name }))
    const before = localStorage.getItem(key)
    configure(); click('align'); await settle()
    expect(el('alignment-message').textContent).toContain(expected)
    expect(el('alignment-message').textContent).not.toContain(message)
    expect(localStorage.getItem(key)).toBe(before)
    expect(button('align').disabled).toBe(false)
  })

  it('reports failures without changing original work and allows a retry', async () => {
    const { configure, service } = await setup()
    service.run.mockRejectedValueOnce(new Error('記憶體不足'))
    const before = localStorage.getItem(key)
    configure(); click('align'); await settle()
    expect(el('alignment-message').textContent).toContain('分析失敗：記憶體不足')
    expect(el('proposal').hidden).toBe(true)
    expect(localStorage.getItem(key)).toBe(before)
    expect(button('align').disabled).toBe(false)
    click('align'); await settle(); expect(el('proposal').hidden).toBe(false)
  })

  it('rejects adoption when result provenance belongs to a different source', async () => {
    const { configure, service } = await setup()
    const before = localStorage.getItem(key)
    service.run.mockImplementation(request => {
      const result = resultFor(request)
      result.run.sourceHash = 'f'.repeat(64)
      return Promise.resolve(result)
    })
    configure(); click('align'); await settle()
    expect(el('alignment-message').textContent).toContain('這次結果未套用')
    expect(el('proposal').hidden).toBe(true)
    expect(localStorage.getItem(key)).toBe(before)
    expect(el('start-value').value).toBe('')
  })

  it('invalidates a proposal when another saved project is opened', async () => {
    const { configure } = await setup()
    configure(); click('align'); await settle()
    const restored = createSession('另一份原文', saved().source)
    Object.defineProperty(el('project-file'), 'files', { configurable: true, value: [
      { name: 'saved.json', size: 2000, text: async () => JSON.stringify(restored) },
    ] })
    el('project-file').dispatchEvent(new Event('change')); await settle()
    expect(el('proposal').hidden).toBe(true)
    expect(el('raw').value).toBe('另一份原文')
    click('undo'); expect(el('raw').value).toBe(rawText)
  })
})
