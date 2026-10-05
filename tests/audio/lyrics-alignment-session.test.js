import { describe, it, expect } from 'vitest'
import { createSession, parseSession, editLine, setManualLock, adoptAlignmentCandidates } from '../../src/js/lyrics/session.js'
import { exportLyrics } from '../../src/js/lyrics/export.js'
import { History } from '../../src/js/history.js'

const source = { name: 'synthetic.wav', hash: 'a'.repeat(64), duration: 30 }
function proposal(session, candidates) {
  return { version: 1, candidates, run: { sourceHash: source.hash, sourceRevision: session.revision,
    engine: 'transformers.js', model: 'Xenova/whisper-tiny', modelRevision: '5332fcc35e32a33b86612b9a57a89be7906102b1',
    language: 'en', backend: 'wasm', pass: 1 } }
}
const matched = (line, start = 1, end = 2) => ({ id: line.id, text: line.text, status: 'matched', start, end,
  evidence: { coverage: 1, reasons: [] } })

describe('model timing adoption and preservation (synthetic proposals, no model)', () => {
  it('migrates all partial legacy manual times to protected states', () => {
    const session = createSession('First\nSecond', source)
    session.lines[0].start = 1; session.lines[1].end = 5
    for (const line of session.lines) { delete line.manualLocked; delete line.timingOrigin; delete line.alignment }
    const restored = parseSession(JSON.stringify(session))
    expect(restored.lines.map(line => line.manualLocked)).toEqual([true, true])
    expect(restored.lines.map(line => line.timingOrigin)).toEqual(['manual', 'manual'])
  })

  it('locks manual edits and confirmation, while an explicit unlock removes confirmation', () => {
    let session = editLine(createSession('Hello', source), 'line-1', { start: 1, end: 2 })
    expect(session.lines[0]).toMatchObject({ manualLocked: true, timingOrigin: 'manual' })
    session = editLine(session, 'line-1', { confirmed: true })
    session = setManualLock(session, 'line-1', false)
    expect(session.lines[0]).toMatchObject({ manualLocked: false, confirmed: false, start: 1, end: 2 })
    session = editLine(session, 'line-1', { start: null, end: null })
    expect(session.lines[0]).toMatchObject({ manualLocked: false, timingOrigin: null })
  })

  it('adopts once without changing raw text, IDs, punctuation, whitespace or line order', () => {
    const session = createSession('我 Hello！\r\n\r\n我 Hello！\r\nمرحبا 🎶', source)
    const candidates = [matched(session.lines[0]), matched(session.lines[2], 5, 6), matched(session.lines[3], 8, 9)]
    const next = adoptAlignmentCandidates(session, proposal(session, candidates), { targetIds: candidates.map(c => c.id) })
    expect(next.rawText).toBe(session.rawText)
    expect(next.lines.map(l => [l.id, l.text])).toEqual(session.lines.map(l => [l.id, l.text]))
    expect(next.revision).toBe(session.revision + 1)
    expect(next.lines[0]).toMatchObject({ start: 1, end: 2, confirmed: false, manualLocked: false, timingOrigin: 'automatic' })
    expect(exportLyrics(next, 'txt')).toBe(session.rawText)
    expect(() => exportLyrics(next, 'srt')).toThrow('尚未確認')
    expect(session.lines[0].start).toBeNull()
  })

  it('round-trips bounded evidence and provenance in existing v1 JSON', () => {
    const session = createSession('Hello', source), result = proposal(session, [matched(session.lines[0])])
    const next = adoptAlignmentCandidates(session, result, { targetIds: ['line-1'] })
    expect(parseSession(JSON.stringify(next))).toEqual(next)
    expect(next.lines[0].alignment).toMatchObject({ status: 'matched', evidence: { coverage: 1, reasons: [] }, model: result.run.model, pass: 1 })
  })

  it('does not overwrite any locked, confirmed, context or non-target line', () => {
    let session = createSession('A\nB\nC\nD', source)
    session = editLine(session, 'line-1', { start: 1, end: 2 })
    session = editLine(session, 'line-2', { start: 3, end: 4 })
    session = editLine(session, 'line-2', { confirmed: true })
    const result = proposal(session, session.lines.map((line, i) => matched(line, 10 + i * 2, 11 + i * 2)))
    const next = adoptAlignmentCandidates(session, result, { targetIds: ['line-1', 'line-2', 'line-3'] })
    expect(next.lines[0]).toEqual(session.lines[0]); expect(next.lines[1]).toEqual(session.lines[1])
    expect(next.lines[3]).toEqual(session.lines[3]); expect(next.lines[2].start).toBe(14)
  })

  it('stores a missing-line diagnosis without assigning or erasing time', () => {
    let session = createSession('A\nB', source)
    session = adoptAlignmentCandidates(session, proposal(session, [matched(session.lines[0])]), { targetIds: ['line-1'] })
    const result = proposal(session, session.lines.map(line => ({ id: line.id, text: line.text, status: 'unresolved', start: null, end: null,
      evidence: { coverage: 0, reasons: ['no_lexical_support'] } })))
    result.run.pass = 2
    const next = adoptAlignmentCandidates(session, result, { targetIds: ['line-1', 'line-2'] })
    expect(next.lines[0]).toMatchObject({ start: 1, end: 2, alignment: { status: 'unresolved', pass: 2 } })
    expect(next.lines[1]).toMatchObject({ start: null, end: null, alignment: { status: 'unresolved' } })
  })

  it('creates one undo step for the whole adopted batch', () => {
    const session = createSession('A\nB', source), history = new History(session)
    const next = adoptAlignmentCandidates(session, proposal(session, session.lines.map((line, i) => matched(line, i * 3 + 1, i * 3 + 2))), { targetIds: ['line-1', 'line-2'] })
    history.push(next)
    expect(history.length).toBe(2); expect(history.undo()).toEqual(session); expect(history.redo()).toEqual(next)
  })

  it.each(['sourceHash', 'sourceRevision'])('rejects a stale %s without mutation', key => {
    const session = createSession('Hello', source), before = JSON.stringify(session), result = proposal(session, [matched(session.lines[0])])
    result.run[key] = key === 'sourceHash' ? 'b'.repeat(64) : session.revision + 1
    expect(() => adoptAlignmentCandidates(session, result, { targetIds: ['line-1'] })).toThrow('已變更')
    expect(JSON.stringify(session)).toBe(before)
  })

  it.each([[-1, 2], [1, Infinity], [2, 2], [4, 3], [29, 31], [null, 2]])('rejects invalid endpoints %s %s', (start, end) => {
    const session = createSession('Hello', source)
    expect(() => adoptAlignmentCandidates(session, proposal(session, [matched(session.lines[0], start, end)]), { targetIds: ['line-1'] })).toThrow('邊界')
  })

  it('rejects forged text, duplicate rows, unknown IDs and unknown targets atomically', () => {
    const session = createSession('A\nB', source), candidate = matched(session.lines[0])
    for (const candidates of [[{ ...candidate, text: 'different' }], [candidate, candidate], [{ ...candidate, id: 'unknown' }]]) {
      expect(() => adoptAlignmentCandidates(session, proposal(session, candidates), { targetIds: ['line-1'] })).toThrow()
    }
    expect(() => adoptAlignmentCandidates(session, proposal(session, [candidate]), { targetIds: ['unknown'] })).toThrow()
    expect(() => adoptAlignmentCandidates(session, proposal(session, [candidate]), { targetIds: ['line-1', 'line-1'] })).toThrow()
    expect(session.lines[0].start).toBeNull()
  })

  it('rejects malformed evidence and strips untrusted extra imported metadata', () => {
    const session = createSession('A', source), result = proposal(session, [matched(session.lines[0])])
    result.candidates[0].evidence.coverage = 90
    expect(() => adoptAlignmentCandidates(session, result, { targetIds: ['line-1'] })).toThrow('比對依據')
    result.candidates[0].evidence.coverage = .5
    const next = adoptAlignmentCandidates(session, result, { targetIds: ['line-1'] })
    next.lines[0].alignment.secret = 'discard'; next.lines[0].alignment.evidence.rawTranscript = 'discard'
    const restored = parseSession(next)
    expect(restored.lines[0].alignment.secret).toBeUndefined()
    expect(restored.lines[0].alignment.evidence.rawTranscript).toBeUndefined()
  })

  it('manual correction removes obsolete model evidence without rewriting text', () => {
    const session = createSession('Hello', source)
    const auto = adoptAlignmentCandidates(session, proposal(session, [matched(session.lines[0])]), { targetIds: ['line-1'] })
    const next = editLine(auto, 'line-1', { start: 1.1 })
    expect(next.lines[0]).toMatchObject({ text: 'Hello', manualLocked: true, timingOrigin: 'manual', alignment: null })
  })
})
