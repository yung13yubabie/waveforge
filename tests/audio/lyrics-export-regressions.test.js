import { describe, it, expect } from 'vitest'
import { createSession, editLine } from '../../src/js/lyrics/session.js'
import { exportLyrics } from '../../src/js/lyrics/export.js'

function timed(rawText, intervals) {
  let session = createSession(rawText, { name: 'source.wav', hash: 'a'.repeat(64), duration: 10 })
  intervals.forEach(([start, end], index) => {
    session = editLine(session, `line-${index + 1}`, { start, end })
    session = editLine(session, `line-${index + 1}`, { confirmed: true })
  })
  return session
}

describe('subtitle format-specific safety', () => {
  it('rejects overlapping LRC cues rather than silently truncating their intervals', () => {
    const session = timed('Long line\nShort line', [[0, 10], [1, 2]])
    expect(() => exportLyrics(session, 'lrc', { allowOverlap: true })).toThrow()
    expect(exportLyrics(session, 'srt', { allowOverlap: true })).toContain('00:00:00,000 --> 00:00:10,000')
    expect(exportLyrics(session, 'ass', { allowOverlap: true })).toContain('00:00:00.00,00:00:10.00')
  })

  it.each(['\u0000', '\u0001', '\u000b', '\u001f'])('rejects control character %j in every subtitle format while preserving TXT', control => {
    const raw = `Hello${control}world`
    const session = timed(raw, [[1, 2]])
    for (const format of ['lrc', 'srt', 'ass']) expect(() => exportLyrics(session, format)).toThrow()
    expect(exportLyrics(session, 'txt')).toBe(raw)
  })

  it('keeps valid adjacent LRC cues and instrumental end markers', () => {
    const session = timed('First\nSecond\nThird', [[0, 1], [1, 2], [3, 4]])
    expect(exportLyrics(session, 'lrc')).toBe('[00:00.00]First\n[00:01.00]Second\n[00:02.00]\n[00:03.00]Third\n[00:04.00]\n')
  })
})
