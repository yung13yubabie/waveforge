import { describe, it, expect } from 'vitest'
import { createSession, editLine, parseSession, diagnostics } from '../src/js/lyrics/session.js'
import { exportLyrics } from '../src/js/lyrics/export.js'
const source = { name: 'test.wav', hash: 'a'.repeat(64), duration: 3900 }
function timed(text = '右だけ\n\n右だけ\nOnly the right sleeve knows') {
  let s = createSession(text, source)
  let time = 16
  for (const line of s.lines.filter(l => l.sung)) {
    s = editLine(s, line.id, { start: time, end: time + 2 })
    s = editLine(s, line.id, { confirmed: true }); time += 4
  }
  return s
}
describe('authoritative lyrics sessions', () => {
  it('preserves CRLF, duplicate lines, Unicode and punctuation through save/reopen and TXT', () => {
    const raw = '右だけ　\r\n\r\n右だけ　\r\nA & B, café 🎶'
    const s = timed(raw), reopened = parseSession(JSON.stringify(s))
    expect(reopened).toEqual(s)
    expect(exportLyrics(reopened, 'txt')).toBe(raw)
    expect(reopened.lines[0].text).toBe(reopened.lines[2].text)
    expect(reopened.lines[1].sung).toBe(false)
  })
  it('never assigns time to unaligned lines', () => {
    const s = createSession('Hello\nHello', source)
    expect(s.lines.every(l => l.start === null && l.end === null)).toBe(true)
    expect(() => exportLyrics(s, 'srt')).toThrow('待打點')
  })
  it('invalid edits and altered imported raw text are rejected without changing input', () => {
    const s = timed(), before = JSON.stringify(s)
    expect(() => editLine(s, 'line-1', { start: 20 })).toThrow('早於')
    expect(() => editLine(s, 'line-1', { text: 'guess' })).toThrow('鎖定原文')
    const broken = JSON.parse(before); broken.lines[0].text = 'guess'
    expect(() => parseSession(broken)).toThrow('不一致')
    expect(JSON.stringify(s)).toBe(before)
  })
  it('rejects NaN, unsupported schema, malformed sources, oversized text and out-of-bounds time', () => {
    expect(() => createSession('a'.repeat(200001))).toThrow()
    const s = timed()
    for (const patch of [{ start: NaN }, { start: -1 }, { end: 5000 }]) expect(() => editLine(s, 'line-1', patch)).toThrow()
    expect(() => parseSession({ ...s, schema: 'future' })).toThrow('不支援')
    expect(() => parseSession({ ...s, source: { ...source, hash: 'bad' } })).toThrow('身份')
  })
  it('time or singing edits invalidate manual confirmation; original stays unchanged', () => {
    const s = timed(), next = editLine(s, 'line-1', { end: 18.5 })
    expect(next.lines[0].confirmed).toBe(false)
    expect(next.rawText).toBe(s.rawText)
    expect(s.lines[0].end).toBe(18)
  })
})
describe('subtitle serializers', () => {
  it('SRT contains numbered intervals and original selected lines; instrumental gaps stay empty', () => {
    const s = timed(), output = exportLyrics(s, 'srt')
    const blocks = output.trimEnd().split('\n\n')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toBe('1\n00:00:16,000 --> 00:00:18,000\n右だけ')
    expect(blocks[1]).toBe('2\n00:00:20,000 --> 00:00:22,000\n右だけ')
  })
  it('LRC ends lines before gaps and does not wrap minutes at an hour', () => {
    const s = timed('hello')
    expect(exportLyrics(s, 'lrc')).toBe('[00:16.00]hello\n[00:18.00]\n')
    s.lines[0].start = 3601.23; s.lines[0].end = 3602.23
    expect(exportLyrics(s, 'lrc')).toContain('[60:01.23]hello')
  })
  it('ASS has styles, events and CJK text, preserving commas in the text field', () => {
    const output = exportLyrics(timed('中文, English 🎶'), 'ass')
    expect(output).toContain('[V4+ Styles]')
    expect(output).toContain('Dialogue: 0,00:00:16.00,00:00:18.00,Default,,0,0,0,,中文, English 🎶')
  })
  it('dangerous ASS controls and LRC timestamps fail visibly instead of altering raw text', () => {
    const ass = timed('{\\b1}hello')
    expect(() => exportLyrics(ass, 'ass')).toThrow('控制字元')
    expect(exportLyrics(ass, 'txt')).toBe('{\\b1}hello')
    expect(() => exportLyrics(timed('[00:01.00]hello'), 'lrc')).toThrow('時碼語法')
  })
  it('exports require confirmation, reject order/overlap, and allow explicit overlaps', () => {
    let s = timed('A\nB')
    s = editLine(s, 'line-2', { start: 17, end: 21 })
    expect(() => exportLyrics(s, 'srt')).toThrow('尚未確認')
    s = editLine(s, 'line-2', { confirmed: true })
    expect(() => exportLyrics(s, 'srt')).toThrow('重疊')
    expect(exportLyrics(s, 'srt', { allowOverlap: true })).toContain('B')
    s.lines[1].start = 15
    expect(diagnostics(s, { allowOverlap: true }).join()).toContain('順序')
  })
  it('rounding and display offsets cannot yield zero-length or negative cues', () => {
    const s = timed('A'); s.lines[0].start = .001; s.lines[0].end = .003
    expect(() => exportLyrics(s, 'lrc')).toThrow('取整')
    expect(exportLyrics(s, 'srt')).toContain('00:00:00,001 --> 00:00:00,003')
    s.displayOffsetMs = -100
    expect(() => exportLyrics(s, 'srt')).toThrow('超出')
  })
})
