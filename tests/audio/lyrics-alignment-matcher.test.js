import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { ALIGNMENT_LIMITS, matchLyricsToAsr, matchLyricsToWords, normalizeLyricsForAnalysis } from '../../src/js/lyrics/alignment-matcher.js'

const lines = texts => texts.map((text, index) => ({ id: `line-${index + 1}`, text,
  sung: text.trim().length > 0, start: null, end: null, confirmed: false }))
const words = (texts, offset = 0) => texts.map((text, index) => ({ text,
  timestamp: [offset + index * 2, offset + index * 2 + 0.75] }))
const match = (texts, audio, options = {}) => matchLyricsToAsr(lines(texts), audio, { duration: 300, ...options })
const times = result => result.candidates.map(({ start, end }) => [start, end])
const statuses = result => result.candidates.map(candidate => candidate.status)
const deeplyFrozen = value => !value || typeof value !== 'object'
  || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))

describe('audio-conditioned lyrics matching', () => {
  it('uses observed English word boundaries, preserving locked text, IDs and order', () => {
    const source = lines(['  HELLO, world!  ', 'Goodbye moon'])
    const audio = words(['hello', 'world', 'goodbye', 'moon'])
    const before = structuredClone({ source, audio })
    const result = matchLyricsToAsr(source, audio, { duration: 20 })
    assert.equal(result.version, 1)
    assert.deepEqual(statuses(result), ['matched', 'matched'])
    assert.deepEqual(times(result), [[0, 2.75], [4, 6.75]])
    assert.deepEqual(result.candidates.map(({ id, text }) => ({ id, text })), source.map(({ id, text }) => ({ id, text })))
    assert.equal(result.candidates[0].evidence.coverage, 1)
    assert.equal(result.candidates[0].evidence.boundarySource, 'asr')
    assert.deepEqual({ source, audio }, before)
    assert.ok(deeplyFrozen(result))
    assert.equal(Object.isFrozen(source), false)
    assert.equal(Object.isFrozen(source[0]), false)
  })

  it('treats punctuation as separators without merging adjacent words', () => {
    const result = match(['Hello,world! We’re here.'], words(['hello', 'world', "we're", 'here']))
    assert.equal(result.candidates[0].status, 'matched')
    assert.equal(result.candidates[0].evidence.coverage, 1)
  })

  it('matches CJK without spaces across differing ASR chunk sizes', () => {
    const result = match(['唱出自己的歌', '看見天空'], words(['唱出', '自己的歌', '看見天空']))
    assert.deepEqual(statuses(result), ['matched', 'matched'])
    assert.deepEqual(times(result), [[0, 2.75], [4, 4.75]])
  })

  it('matches mixed Arabic, Japanese and English without transliterating the source', () => {
    const text = 'مَرْحَبًا 世界、きみと ＬＯＶＥ！'
    const result = match([text], words(['مرحبا', '世界', 'きみと', 'love']))
    assert.equal(result.candidates[0].status, 'matched')
    assert.equal(result.candidates[0].text, text)
    assert.equal(result.candidates[0].evidence.coverage, 1)
  })

  it('uses Unicode composition only for analysis and preserves voiced Japanese distinctions', () => {
    const result = match(['カ\u3099ラスの歌'], words(['ガラスの歌']))
    assert.equal(result.candidates[0].status, 'matched')
    assert.equal(result.candidates[0].text, 'カ\u3099ラスの歌')
    assert.notEqual(normalizeLyricsForAnalysis('カ'), normalizeLyricsForAnalysis('ガ'))
  })

  it('preserves meaningful non-Arabic combining marks rather than conflating words', () => {
    assert.notEqual(normalizeLyricsForAnalysis('कि'), normalizeLyricsForAnalysis('कु'))
    const result = match(['कि गीत'], words(['कि', 'गीत']))
    assert.equal(result.candidates[0].status, 'matched')
  })

  it('preserves duplicate lyric text and duplicate IDs without deduplicating rows', () => {
    const source = lines(['sing again', 'sing again'])
    source[1].id = source[0].id
    const result = matchLyricsToAsr(source, words(['sing', 'again', 'sing', 'again']), { duration: 20 })
    assert.equal(result.candidates.length, 2)
    assert.deepEqual(result.candidates.map(row => row.id), ['line-1', 'line-1'])
    assert.deepEqual(times(result), [[0, 2.75], [4, 6.75]])
  })

  it('leaves both identical choruses unresolved when only one is heard', () => {
    const result = match(['love again', 'missing verse', 'love again'], words(['love', 'again']))
    assert.deepEqual(statuses(result), ['unresolved', 'unresolved', 'unresolved'])
    assert.ok(result.candidates[0].evidence.reasons.includes('ambiguous_alignment'))
    assert.ok(result.candidates[2].evidence.reasons.includes('ambiguous_alignment'))
    assert.deepEqual(times(result), [[null, null], [null, null], [null, null]])
  })

  it('does not choose one repeated audio occurrence for one lyric line', () => {
    const result = match(['only chorus'], words(['only', 'chorus', 'only', 'chorus']))
    assert.equal(result.candidates[0].status, 'unresolved')
    assert.ok(result.candidates[0].evidence.reasons.includes('ambiguous_alignment'))
    assert.equal(result.candidates[0].evidence.coverage, 0)
    assert.equal(result.candidates[0].evidence.bestAlternativeCoverage, 1)
  })

  it('counts globally optimal paths that omit a line, rather than trusting a single local candidate', () => {
    const result = match(['again', 'again', 'again'], words(['again', 'again']))
    assert.deepEqual(statuses(result), ['unresolved', 'unresolved', 'unresolved'])
    assert.ok(result.candidates.every(row => row.evidence.reasons.includes('ambiguous_alignment')))
  })

  it('uses unique whole-song context to disambiguate repeated choruses monotonically', () => {
    const result = match(['love again', 'unique middle', 'love again'], words(['love', 'again', 'unique', 'middle', 'love', 'again']))
    assert.deepEqual(statuses(result), ['matched', 'matched', 'matched'])
    assert.deepEqual(times(result), [[0, 2.75], [4, 6.75], [8, 10.75]])
  })

  it('leaves an omitted verse untimed while matching later lyrics', () => {
    const result = match(['first line', 'entirely omitted verse', 'final ending'], words(['first', 'line', 'final', 'ending']))
    assert.deepEqual(statuses(result), ['matched', 'unresolved', 'matched'])
    assert.deepEqual(times(result), [[0, 2.75], [null, null], [4, 6.75]])
    assert.deepEqual(result.candidates[1].evidence.unmatchedNormalizedUnits, ['entirely', 'omitted', 'verse'])
  })

  it('allows extra adlibs while reporting evidence and retaining actual word endpoints', () => {
    const result = match(['hello beautiful world'], words(['hello', 'uh', 'beautiful', 'world']))
    assert.equal(result.candidates[0].status, 'matched')
    assert.deepEqual(times(result), [[0, 6.75]])
    assert.equal(result.candidates[0].evidence.coverage, 1)
    assert.deepEqual(result.candidates[0].evidence.extraAsrWordIndices, [1])
    assert.deepEqual(result.candidates[0].evidence.extraAsrNormalizedUnits, ['uh'])
    assert.ok(result.candidates[0].evidence.reasons.includes('extra_asr_words'))
  })

  it('reports extra lexical units inside a single ASR chunk', () => {
    const result = match(['hello beautiful world'], words(['hello uh beautiful world']))
    assert.equal(result.candidates[0].status, 'matched')
    assert.deepEqual(result.candidates[0].evidence.extraAsrNormalizedUnits, ['uh'])
    assert.ok(result.candidates[0].evidence.reasons.includes('extra_asr_words'))
  })

  it('reports partial lyrics without inventing the missing word duration', () => {
    const result = match(['a beautiful sunrise'], words(['beautiful', 'sunrise'], 10))
    assert.equal(result.candidates[0].status, 'matched')
    assert.deepEqual(times(result), [[10, 12.75]])
    assert.ok(result.candidates[0].evidence.coverage < 1)
    assert.deepEqual(result.candidates[0].evidence.unmatchedNormalizedUnits, ['a'])
    assert.ok(result.candidates[0].evidence.reasons.includes('partial_lyrics'))
  })

  it('does not assign any timestamps during silence or when no supporting words exist', () => {
    const result = match(['first line', '', 'last line'], [])
    assert.deepEqual(statuses(result), ['unresolved', 'context', 'unresolved'])
    assert.deepEqual(times(result), [[null, null], [null, null], [null, null]])
  })

  it('keeps long audio gaps and nonuniform durations instead of averaging them', () => {
    const audio = [{ text: 'first', timestamp: [8.2, 8.4] }, { text: 'line', timestamp: [8.9, 14.3] },
      { text: 'last', timestamp: [120, 122] }, { text: 'line', timestamp: [150, 157.8] }]
    const result = match(['first line', 'last line'], audio)
    assert.deepEqual(times(result), [[8.2, 14.3], [120, 157.8]])
  })

  it('never invents internal boundaries when one ASR chunk covers two lyric lines', () => {
    const result = match(['hello', 'world'], [{ text: 'hello world', timestamp: [1, 8] }])
    assert.deepEqual(statuses(result), ['unresolved', 'unresolved'])
    assert.deepEqual(times(result), [[null, null], [null, null]])
  })

  it('does not claim chunk edges when matching a substring of that chunk', () => {
    assert.equal(match(['world'], words(['hello world'])).candidates[0].status, 'unresolved')
    assert.equal(match(['hello'], words(['hello world'])).candidates[0].status, 'unresolved')
  })

  it('rejects null, absent, string, infinite, negative, reversed, zero and out-of-bounds times', () => {
    const bad = [[null, 1], [0, null], [], ['0', 1], [0, Infinity], [-1, 1], [3, 2], [1, 1], [0, 301]]
    for (const timestamp of bad) {
      const result = match(['hello'], [{ text: 'hello', timestamp }])
      assert.equal(result.candidates[0].status, 'unresolved', JSON.stringify(timestamp))
      assert.equal(result.diagnostics.rejectedWords[0].reason, 'invalid_asr_timestamp')
    }
  })

  it('rejects both sides of overlapping observations without sorting or repairing them', () => {
    const audio = [{ text: 'alpha', timestamp: [0, 2] }, { text: 'beta', timestamp: [1, 3] }, { text: 'safe', timestamp: [4, 5] }]
    const result = match(['alpha', 'beta', 'safe'], audio)
    assert.deepEqual(statuses(result), ['unresolved', 'unresolved', 'matched'])
    assert.deepEqual(result.diagnostics.rejectedWords.map(word => word.index), [0, 1])
    assert.deepEqual(times(result)[2], [4, 5])
  })

  it('rejects nested overlaps and backwards ASR order, but accepts touching endpoints', () => {
    const nested = match(['one', 'two', 'three'], [
      { text: 'one', timestamp: [0, 10] }, { text: 'two', timestamp: [1, 2] }, { text: 'three', timestamp: [3, 4] },
    ])
    assert.deepEqual(statuses(nested), ['unresolved', 'unresolved', 'unresolved'])
    const backwards = match(['one', 'two'], [{ text: 'one', timestamp: [5, 6] }, { text: 'two', timestamp: [1, 2] }])
    assert.deepEqual(statuses(backwards), ['unresolved', 'unresolved'])
    const touching = match(['one', 'two'], [{ text: 'one', timestamp: [0, 1] }, { text: 'two', timestamp: [1, 2] }])
    assert.deepEqual(statuses(touching), ['matched', 'matched'])
  })

  it('uses already-absolute crop times once, ignoring unrelated offset metadata', () => {
    const audio = words(['hello', 'world']).map(word => ({ ...word, timestamp: word.timestamp.map(time => time + 73) }))
    const result = match(['hello world'], audio, { cropOffset: 73, offset: 73 })
    assert.deepEqual(times(result), [[73, 75.75]])
    assert.equal(result.diagnostics.timestampBasis, 'absolute_source_seconds')
  })

  it('reruns only targets while retaining whole-lyrics context for repeated words', () => {
    const source = lines(['love again', 'unique middle', 'love again'])
    const audio = words(['love', 'again', 'unique', 'middle', 'love', 'again'])
    const result = matchLyricsToAsr(source, audio, { duration: 40, targetIds: ['line-3'] })
    assert.deepEqual(statuses(result), ['context', 'context', 'matched'])
    assert.deepEqual(times(result), [[null, null], [null, null], [8, 10.75]])
    assert.equal(source[2].start, null)
  })

  it('respects confirmed and manually locked timing anchors, never proposing overwrites', () => {
    const source = lines(['chorus', 'anchor', 'chorus'])
    source[1] = { ...source[1], start: 4, end: 5, confirmed: true }
    const result = matchLyricsToAsr(source, words(['chorus', 'chorus', 'anchor', 'chorus']), { duration: 20 })
    assert.equal(result.candidates[1].status, 'protected')
    assert.deepEqual(times(result)[1], [null, null])
    assert.deepEqual(times(result)[2], [6, 6.75])
    assert.equal(source[1].start, 4)
    source[1].confirmed = false; source[1].manualLocked = true
    assert.equal(matchLyricsToAsr(source, words(['chorus', 'anchor', 'chorus']), { duration: 20 }).candidates[1].status, 'protected')
  })

  it('uses explicit manual anchors and protected IDs without requiring ASR for the anchors', () => {
    const source = lines(['chorus', 'manual anchor', 'chorus'])
    const result = matchLyricsToAsr(source, words(['chorus', 'chorus'], 10), {
      duration: 40, anchors: [{ id: 'line-2', start: 11, end: 12 }], protectedIds: ['line-1'],
    })
    assert.deepEqual(statuses(result), ['protected', 'protected', 'matched'])
    assert.deepEqual(times(result), [[null, null], [null, null], [12, 12.75]])
  })

  it('fails closed for invalid, overlapping, unknown or duplicate-ID anchors', () => {
    const source = lines(['one', 'two', 'three'])
    for (const anchors of [
      [{ id: 'line-2', start: null, end: 1 }],
      [{ id: 'unknown', start: 1, end: 2 }],
      [{ id: 'line-1', start: 5, end: 6 }, { id: 'line-2', start: 4, end: 7 }],
      [{ id: 'line-2', start: 1, end: 2 }, { id: 'line-2', start: 1, end: 2 }],
    ]) {
      const result = matchLyricsToAsr(source, words(['one', 'two', 'three']), { duration: 20, anchors })
      assert.equal(result.status, 'invalid_anchors')
      assert.ok(result.candidates.every(row => row.start === null && row.end === null))
    }
    const duplicates = lines(['one', 'one']); duplicates[1].id = 'line-1'
    assert.equal(matchLyricsToAsr(duplicates, words(['one']), { duration: 20, anchors: [{ id: 'line-1', start: 0, end: 1 }] }).status, 'invalid_anchors')
  })

  it('fails closed when protected timing is malformed instead of trusting a partial anchor', () => {
    const source = lines(['one', 'two'])
    source[0] = { ...source[0], confirmed: true, start: 1, end: null }
    const result = matchLyricsToAsr(source, words(['one', 'two']), { duration: 20 })
    assert.equal(result.status, 'invalid_anchors')
    assert.ok(result.candidates.every(row => row.start === null && row.end === null))
  })

  it('does not label coverage or matching scores as a calibrated confidence', () => {
    const result = match(['hello'], words(['hello']))
    assert.equal('confidence' in result.candidates[0], false)
    assert.match(result.diagnostics.scoreMeaning, /not calibrated probabilities/)
  })

  it('returns an explicit bounded-work result for pathological repeated material', () => {
    const text = Array(5000).fill('again')
    const result = match(text, words(Array(1000).fill('again')), { duration: 3000 })
    assert.equal(result.status, 'workload_limit')
    assert.equal(result.candidates.length, 5000)
    assert.ok(result.candidates.every(row => row.start === null && row.evidence.reasons.includes('workload_limit')))
    assert.ok(result.diagnostics.matrixCells <= ALIGNMENT_LIMITS.maxMatrixCells)
  })

  it('caps text, line count, ASR count and per-line complexity without manufacturing timings', () => {
    const tooLong = match(['x'.repeat(200001)], words(['x']))
    assert.equal(tooLong.status, 'workload_limit')
    const tooManyLines = match(Array(5001).fill('x'), [])
    assert.equal(tooManyLines.status, 'workload_limit')
    const tooManyWords = match(['x'], Array(50001).fill({ text: 'x', timestamp: [0, 1] }))
    assert.equal(tooManyWords.status, 'workload_limit')
    const tooManyUnits = match(['中'.repeat(513)], words(['中']))
    assert.equal(tooManyUnits.status, 'workload_limit')
  })

  it('handles 5,000 supported lines without a dense song-by-song matrix', () => {
    const source = lines(Array.from({ length: 5000 }, (_, i) => `lyric${i} sung${i}`))
    const audio = source.flatMap((line, i) => line.text.split(' ').map((text, j) => ({ text,
      timestamp: [i * 2 + j, i * 2 + j + 0.5] })))
    const result = matchLyricsToAsr(source, audio, { duration: 10000 })
    assert.equal(result.status, 'complete')
    assert.ok(result.candidates.every(row => row.status === 'matched'))
    assert.ok(result.diagnostics.matrixCells < 200000)
  })

  it('fails closed for the global matrix-work cap, without returning partially contextualized timings', () => {
    const source = lines(Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 200 }, (_, j) => `token${i}x${j}`).join(' ')))
    const audio = source.flatMap((line, i) => line.text.split(' ').map((text, j) => ({ text,
      timestamp: [i * 200 + j, i * 200 + j + 0.5] })))
    const result = matchLyricsToAsr(source, audio, { duration: 1600 })
    assert.equal(result.status, 'workload_limit')
    assert.ok(result.candidates.every(row => row.start === null && row.end === null))
    assert.ok(result.diagnostics.matrixCells > ALIGNMENT_LIMITS.maxMatrixCells)
  })

  it('agrees with an exhaustive best-path oracle on 150 short repeated/omitted sequences', () => {
    let seed = 1907
    const random = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max }
    const vocabulary = ['a', 'bbb', 'cc']
    for (let trial = 0; trial < 150; trial++) {
      const lyric = Array.from({ length: 1 + random(5) }, () => vocabulary[random(3)])
      const transcript = Array.from({ length: random(6) }, () => vocabulary[random(3)])
      let best = -1, paths = []
      function enumerate(line, word, score, mapping) {
        if (line === lyric.length) {
          if (score > best) { best = score; paths = [mapping] }
          else if (score === best) paths.push(mapping)
          return
        }
        enumerate(line + 1, word, score, [...mapping, null])
        for (let i = word; i < transcript.length; i++) {
          if (lyric[line] === transcript[i]) enumerate(line + 1, i + 1, score + lyric[line].length * 100, [...mapping, i])
        }
      }
      enumerate(0, 0, 0, [])
      const result = match(lyric, words(transcript))
      for (let i = 0; i < lyric.length; i++) {
        const assignments = new Set(paths.map(path => path[i]))
        const expected = assignments.size === 1 && !assignments.has(null)
        assert.equal(result.candidates[i].status === 'matched', expected, JSON.stringify({ lyric, transcript, i }))
        if (expected) assert.equal(result.candidates[i].start, [...assignments][0] * 2)
      }
    }
  })

  it('validates the structural contract and offers the integration alias', () => {
    assert.equal(matchLyricsToWords, matchLyricsToAsr)
    assert.throws(() => matchLyricsToAsr([], [], {}), /duration/)
    assert.throws(() => matchLyricsToAsr([], [], { duration: 0 }), /duration/)
    assert.throws(() => matchLyricsToAsr(null, [], { duration: 20 }), /arrays/)
    assert.throws(() => matchLyricsToAsr([{ id: 'id' }], [], { duration: 20 }), /id and text/)
    assert.throws(() => matchLyricsToAsr([], [], { duration: 20, targetIds: new Set() }), /array/)
    assert.deepEqual(matchLyricsToAsr([], [], { duration: 20 }).candidates, [])
  })
})
