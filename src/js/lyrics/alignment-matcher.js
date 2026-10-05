/**
 * Read-only lexical alignment of locked lyrics to AUDIO-CONDITIONED ASR times.
 * This module does not transcribe audio and never estimates word durations.
 *
 * matchLyricsToAsr(lines, words, { duration, targetIds?, protectedIds?, anchors? })
 * - words are { text, timestamp: [absoluteStart, absoluteEnd] }; crop offsets must
 *   already have been applied exactly once by the transcription adapter.
 * - anchors are { id, start, end }; confirmed/manualLocked lines are protected
 *   automatically. Valid protected timings are hard barriers, never new evidence.
 * - every input line has one output row, in the original order, including blanks,
 *   duplicate text and non-target context. Only status === 'matched' is applicable.
 * - start/end are null for ALL other statuses. No session or input is changed.
 * - coverage is normalized lexical-character coverage, NOT a probability.
 *
 * Matching is exact after Unicode analysis normalization, with missing lyric units
 * and extra ASR units allowed. CJK/Japanese units are individual characters; other
 * scripts use words. ASR chunks remain indivisible timing observations. A chunk
 * spanning two lyric lines cannot be split into guessed line timestamps.
 *
 * Candidate intervals are scored by matched characters minus omissions/extras.
 * A sparse monotone whole-lyrics alignment considers omitted lines too. Exact
 * forward/backward path counts identify timings shared by every optimal path.
 * Ties (including an equally good path omitting a line) stay unresolved.
 * Work is capped before returning any usable timing if context is incomplete.
 */

export const ALIGNMENT_LIMITS = Object.freeze({
  maxLines: 5000,
  maxTextCharacters: 200000,
  maxAsrWords: 50000,
  maxUnitsPerLine: 512,
  maxStartsPerLine: 128,
  maxCandidates: 20000,
  maxMatrixCells: 8000000,
})

const MIN_COVERAGE = 0.75
const MATCH = 100
const MISSING = 60
const EXTRA = 30
const NEGATIVE = -0x3fffffff
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/** Analysis only. Callers must retain the original source string separately. */
export function normalizeLyricsForAnalysis(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .replace(/['’\p{Cf}\u0610-\u061a\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/gu, '')
    .replace(/[\p{P}\p{S}]/gu, ' ')
}

function unitsFor(text) {
  const normalized = normalizeLyricsForAnalysis(text)
  const units = []
  let word = ''
  const flush = () => { if (word) { units.push({ key: word, length: Array.from(word).length }); word = '' } }
  for (const char of normalized) {
    if (CJK.test(char)) { flush(); units.push({ key: char, length: 1 }) }
    else if (/[\p{L}\p{N}\p{M}]/u.test(char)) word += char
    else flush()
  }
  flush()
  return units
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function validTime(start, end, duration) {
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < end && end <= duration
}

function evidence(totalCharacters = 0, reasons = []) {
  return {
    coverage: 0, matchedCharacters: 0, totalCharacters,
    matchedWordIndices: [], unmatchedNormalizedUnits: [], extraAsrWordIndices: [], extraAsrNormalizedUnits: [],
    reasons, boundarySource: null,
  }
}

function outputRows(lines, targets, protectedIds) {
  return lines.map((line, lineIndex) => ({
    id: line.id, text: line.text, lineIndex, sung: line.sung !== false,
    target: !targets || targets.has(line.id),
    protected: line.confirmed === true || line.manualLocked === true || protectedIds.has(line.id),
    status: 'unresolved', start: null, end: null, evidence: evidence(),
  }))
}

function finish(rows, diagnostics, status = 'complete') {
  return freeze({ version: 1, status, candidates: rows, diagnostics })
}

function failUnresolved(rows, diagnostics, reason, status) {
  for (const row of rows) {
    if (row.status === 'unresolved') row.evidence.reasons.push(reason)
  }
  return finish(rows, diagnostics, status)
}

function prepareWords(words, duration, diagnostics) {
  const entries = words.map((word, index) => {
    const [start, end] = Array.isArray(word?.timestamp) ? word.timestamp : []
    let reason = null
    if (typeof word?.text !== 'string') reason = 'invalid_asr_text'
    else if (!validTime(start, end, duration)) reason = 'invalid_asr_timestamp'
    return { index, text: word?.text, start, end, reason }
  })
  // Reject both sides of conflicting time observations. Never sort, clamp, fill a
  // null end, or silently pick one overlapping observation as the trusted one.
  let previous = null
  for (const word of entries) {
    if (word.reason) continue
    if (previous && word.start < previous.end) {
      word.reason = 'overlapping_or_nonmonotone_asr'
      previous.reason = 'overlapping_or_nonmonotone_asr'
    }
    if (!previous || word.end > previous.end) previous = word
  }
  const units = []
  const positions = new Map()
  for (const word of entries) {
    if (word.reason) {
      diagnostics.rejectedWords.push({ index: word.index, reason: word.reason })
      continue
    }
    const tokens = unitsFor(word.text)
    if (!tokens.length) {
      diagnostics.rejectedWords.push({ index: word.index, reason: 'empty_asr_text' })
      continue
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = { ...tokens[i], wordIndex: word.index, start: word.start, end: word.end,
        first: i === 0, last: i === tokens.length - 1 }
      const position = units.length
      units.push(token)
      if (token.first) {
        if (!positions.has(token.key)) positions.set(token.key, [])
        positions.get(token.key).push(position)
      }
    }
  }
  return { units, positions }
}

function anchorBounds(lines, rows, options, duration, diagnostics) {
  const explicit = new Map()
  const indicesById = new Map()
  lines.forEach((line, index) => {
    if (!indicesById.has(line.id)) indicesById.set(line.id, [])
    indicesById.get(line.id).push(index)
  })
  for (const anchor of options.anchors || []) {
    const indices = indicesById.get(anchor?.id) || []
    if (indices.length !== 1 || !validTime(anchor?.start, anchor?.end, duration) || explicit.has(indices[0])) {
      diagnostics.reasons.push('invalid_anchor')
      return null
    }
    explicit.set(indices[0], { start: anchor.start, end: anchor.end })
    rows[indices[0]].protected = true
    rows[indices[0]].status = 'protected'
    rows[indices[0]].evidence.reasons = ['protected_anchor']
  }
  const anchors = []
  for (let i = 0; i < lines.length; i++) {
    if (explicit.has(i)) anchors.push({ index: i, ...explicit.get(i) })
    else if (rows[i].protected && (lines[i].start != null || lines[i].end != null || (lines[i].confirmed && rows[i].sung))) {
      if (!validTime(lines[i].start, lines[i].end, duration)) {
        diagnostics.reasons.push('invalid_protected_timing')
        return null
      }
      anchors.push({ index: i, start: lines[i].start, end: lines[i].end })
    }
  }
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].start < anchors[i - 1].end) {
      diagnostics.reasons.push('nonmonotone_anchors')
      return null
    }
  }
  const bounds = lines.map(() => ({ start: 0, end: duration }))
  let previousEnd = 0, cursor = 0
  for (let i = 0; i < lines.length; i++) {
    while (cursor < anchors.length && anchors[cursor].index < i) previousEnd = anchors[cursor++].end
    bounds[i] = { start: previousEnd, end: cursor < anchors.length ? anchors[cursor].start : duration }
  }
  return bounds
}

function traceMatch(trace, columns, tokens, asr, start, endColumn, lastLyric) {
  const matchedLyrics = [lastLyric - 1]
  const matchedAsr = [start + endColumn - 1]
  let i = lastLyric - 1, j = endColumn - 1
  while (i > 0 && j > 0) {
    const direction = trace[i * columns + j]
    if (direction === 1) { matchedLyrics.push(i - 1); matchedAsr.push(start + j - 1); i--; j-- }
    else if (direction === 2) i--
    else if (direction === 3) j--
    else break
  }
  matchedLyrics.reverse(); matchedAsr.reverse()
  const matchedCharacters = matchedLyrics.reduce((sum, index) => sum + tokens[index].length, 0)
  return { matchedLyrics, matchedAsr, matchedCharacters }
}

function candidatesForLine(tokens, asr, positions, bounds, lineIndex, budget) {
  const total = tokens.reduce((sum, token) => sum + token.length, 0)
  const starts = new Set()
  let omittedPrefix = 0
  for (const token of tokens) {
    if (omittedPrefix > total * (1 - MIN_COVERAGE)) break
    const occurrences = positions.get(token.key) || []
    let low = 0, high = occurrences.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (asr[occurrences[middle]].start < bounds.start) low = middle + 1
      else high = middle
    }
    for (let index = low; index < occurrences.length; index++) {
      const position = occurrences[index]
      if (asr[position].end > bounds.end) break
      starts.add(position)
      if (starts.size > ALIGNMENT_LIMITS.maxStartsPerLine) throw new Error('workload_limit')
    }
    omittedPrefix += token.length
  }
  const byInterval = new Map()
  const prefix = [0]
  for (const token of tokens) prefix.push(prefix.at(-1) + token.length)
  // This is a lexical search window, not an audio duration estimate.
  const maxWindow = tokens.length + Math.max(8, Math.ceil(tokens.length / 2))
  for (const start of starts) {
    let width = Math.min(maxWindow, asr.length - start)
    while (width > 0 && asr[start + width - 1].end > bounds.end) width--
    const columns = width + 1
    const cells = (tokens.length + 1) * columns
    budget.cells += cells
    if (budget.cells > ALIGNMENT_LIMITS.maxMatrixCells) throw new Error('workload_limit')
    const matrix = new Int32Array(cells).fill(NEGATIVE)
    const trace = new Uint8Array(cells)
    matrix[0] = 0
    for (let i = 1; i <= tokens.length; i++) {
      matrix[i * columns] = -prefix[i] * MISSING
      for (let j = 1; j <= width; j++) {
        const cell = i * columns + j
        const audio = asr[start + j - 1]
        let score = matrix[cell - columns] - tokens[i - 1].length * MISSING
        let direction = 2
        if (j > 1) {
          const insert = matrix[cell - 1] - audio.length * EXTRA
          if (insert > score) { score = insert; direction = 3 }
        }
        if (tokens[i - 1].key === audio.key) {
          const match = matrix[cell - columns - 1] + tokens[i - 1].length * MATCH
          if (match >= score) { score = match; direction = 1 }
        }
        matrix[cell] = score; trace[cell] = direction
      }
    }
    for (let j = 1; j <= width; j++) {
      const last = asr[start + j - 1]
      if (!last.last) continue
      let score = NEGATIVE, lastLyric = 0
      for (let i = 1; i <= tokens.length; i++) {
        if (tokens[i - 1].key !== last.key) continue
        const endScore = matrix[(i - 1) * columns + j - 1]
          + tokens[i - 1].length * MATCH - (total - prefix[i]) * MISSING
        if (endScore > score) { score = endScore; lastLyric = i }
      }
      if (score <= 0 || !lastLyric) continue
      const match = traceMatch(trace, columns, tokens, asr, start, j, lastLyric)
      if (match.matchedCharacters / total < MIN_COVERAGE) continue
      const first = asr[start]
      const key = `${first.wordIndex}:${last.wordIndex}`
      const candidate = { lineIndex, startWord: first.wordIndex, endWord: last.wordIndex,
        start: first.start, end: last.end, score, ...match }
      if (!byInterval.has(key)) {
        budget.candidates++
        if (budget.candidates > ALIGNMENT_LIMITS.maxCandidates) throw new Error('workload_limit')
      }
      if (!byInterval.has(key) || byInterval.get(key).score < score) byInterval.set(key, candidate)
    }
  }
  return [...byInterval.values()]
}

// A Fenwick max tree carries exact counts of best paths. Distinct predecessors
// are counted once; equal-score routes are not broken by an arbitrary tie-break.
function bestTree(size) {
  const scores = new Float64Array(size + 2)
  const counts = Array(size + 2).fill(0n)
  return {
    query(index) {
      let score = 0, count = 1n // The one empty path.
      for (let i = index; i > 0; i -= i & -i) {
        if (scores[i] > score) { score = scores[i]; count = counts[i] }
        else if (scores[i] === score && score > 0) count += counts[i]
      }
      return { score, count }
    },
    update(index, score, count) {
      for (let i = index; i < scores.length; i += i & -i) {
        if (score > scores[i]) { scores[i] = score; counts[i] = count }
        else if (score === scores[i]) counts[i] += count
      }
    },
  }
}

function resolvePaths(groups, wordCount) {
  let tree = bestTree(wordCount + 1)
  for (const group of groups) {
    for (const candidate of group) {
      const best = tree.query(candidate.startWord)
      candidate.forward = best.score + candidate.score; candidate.forwardCount = best.count
    }
    for (const candidate of group) tree.update(candidate.endWord + 1, candidate.forward, candidate.forwardCount)
  }
  const overall = tree.query(wordCount + 1)
  tree = bestTree(wordCount + 1)
  for (let i = groups.length - 1; i >= 0; i--) {
    for (const candidate of groups[i]) {
      const best = tree.query(wordCount - candidate.endWord - 1)
      candidate.backward = best.score + candidate.score; candidate.backwardCount = best.count
    }
    for (const candidate of groups[i]) tree.update(wordCount - candidate.startWord, candidate.backward, candidate.backwardCount)
  }
  return overall
}

function matchedEvidence(candidate, tokens, asr) {
  const matchedSet = new Set(candidate.matchedLyrics)
  const matchedWordIndices = [...new Set(candidate.matchedAsr.map(index => asr[index].wordIndex))]
  const words = new Set(matchedWordIndices)
  const matchedUnits = new Set(candidate.matchedAsr)
  const extraAsrNormalizedUnits = []
  for (let index = candidate.matchedAsr[0]; index <= candidate.matchedAsr.at(-1); index++) {
    if (!matchedUnits.has(index)) extraAsrNormalizedUnits.push(asr[index].key)
  }
  const extraAsrWordIndices = []
  for (let index = candidate.startWord; index <= candidate.endWord; index++) {
    if (!words.has(index)) extraAsrWordIndices.push(index)
  }
  const totalCharacters = tokens.reduce((sum, token) => sum + token.length, 0)
  const coverage = candidate.matchedCharacters / totalCharacters
  const reasons = []
  if (coverage < 1) reasons.push('partial_lyrics')
  if (extraAsrNormalizedUnits.length || extraAsrWordIndices.length) reasons.push('extra_asr_words')
  return { coverage, matchedCharacters: candidate.matchedCharacters, totalCharacters,
    matchedWordIndices, unmatchedNormalizedUnits: tokens.filter((_, i) => !matchedSet.has(i)).map(token => token.key),
    extraAsrWordIndices, extraAsrNormalizedUnits, reasons, boundarySource: 'asr' }
}

export function matchLyricsToAsr(lines, words, options = {}) {
  if (!Array.isArray(lines) || !Array.isArray(words)) throw new TypeError('Lyrics and ASR words must be arrays')
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new RangeError('A finite positive source duration is required')
  if (lines.some(line => !line || typeof line.id !== 'string' || typeof line.text !== 'string')) {
    throw new TypeError('Each locked line must have its original string id and text')
  }
  for (const key of ['targetIds', 'protectedIds', 'anchors']) {
    if (options[key] != null && !Array.isArray(options[key])) throw new TypeError(`${key} must be an array`)
  }
  const targets = options.targetIds == null ? null : new Set(options.targetIds)
  const protectedIds = new Set(options.protectedIds || [])
  const rows = outputRows(lines, targets, protectedIds)
  const diagnostics = { reasons: [], rejectedWords: [], matrixCells: 0, candidateCount: 0,
    scoreMeaning: 'Lexical coverage and alignment score are not calibrated probabilities',
    timestampBasis: 'absolute_source_seconds' }
  for (const row of rows) {
    if (row.protected) { row.status = 'protected'; row.evidence.reasons.push('protected_line') }
    else if (!row.target) { row.status = 'context'; row.evidence.reasons.push('not_targeted') }
    else if (!row.sung) { row.status = 'context'; row.evidence.reasons.push('not_sung') }
  }
  const inputCharacters = lines.reduce((sum, line) => sum + line.text.length, 0)
  const asrCharacters = words.reduce((sum, word) => sum + (typeof word?.text === 'string' ? word.text.length : 0), 0)
  if (lines.length > ALIGNMENT_LIMITS.maxLines || words.length > ALIGNMENT_LIMITS.maxAsrWords
    || inputCharacters > ALIGNMENT_LIMITS.maxTextCharacters || asrCharacters > ALIGNMENT_LIMITS.maxTextCharacters) {
    diagnostics.reasons.push('workload_limit')
    return failUnresolved(rows, diagnostics, 'workload_limit', 'workload_limit')
  }
  const bounds = anchorBounds(lines, rows, options, options.duration, diagnostics)
  if (!bounds) return failUnresolved(rows, diagnostics, 'invalid_anchors', 'invalid_anchors')
  const { units: asr, positions } = prepareWords(words, options.duration, diagnostics)
  const tokens = lines.map(line => unitsFor(line.text))
  const groups = lines.map(() => [])
  const budget = { cells: 0, candidates: 0 }
  try {
    for (let i = 0; i < lines.length; i++) {
      rows[i].evidence.totalCharacters = tokens[i].reduce((sum, token) => sum + token.length, 0)
      rows[i].evidence.unmatchedNormalizedUnits = tokens[i].map(token => token.key)
      if (!rows[i].sung || rows[i].protected || !tokens[i].length) continue
      if (tokens[i].length > ALIGNMENT_LIMITS.maxUnitsPerLine) throw new Error('workload_limit')
      groups[i] = candidatesForLine(tokens[i], asr, positions, bounds[i], i, budget)
    }
  } catch (error) {
    if (error.message !== 'workload_limit') throw error
    diagnostics.matrixCells = budget.cells; diagnostics.candidateCount = budget.candidates
    diagnostics.reasons.push('workload_limit')
    return failUnresolved(rows, diagnostics, 'workload_limit', 'workload_limit')
  }
  diagnostics.matrixCells = budget.cells; diagnostics.candidateCount = budget.candidates
  const overall = resolvePaths(groups, words.length)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.status !== 'unresolved') continue
    if (!tokens[i].length) { row.evidence.reasons.push('no_lexical_content'); continue }
    if (!groups[i].length) { row.evidence.reasons.push('insufficient_word_evidence'); continue }
    const best = groups[i].filter(candidate => candidate.forward + candidate.backward - candidate.score === overall.score)
    const throughPaths = best.reduce((sum, candidate) => sum + candidate.forwardCount * candidate.backwardCount, 0n)
    if (best.length !== 1 || throughPaths !== overall.count) {
      row.evidence.reasons.push(best.length || throughPaths ? 'ambiguous_alignment' : 'monotone_context_conflict')
      // Keep selected evidence empty. A lexical match somewhere in the audio is
      // not evidence that this particular lyric occurrence was resolved.
      row.evidence.bestAlternativeCoverage = Math.max(...groups[i].map(candidate => candidate.matchedCharacters)) / row.evidence.totalCharacters
      continue
    }
    row.status = 'matched'; row.start = best[0].start; row.end = best[0].end
    row.evidence = matchedEvidence(best[0], tokens[i], asr)
  }
  return finish(rows, diagnostics)
}

export const matchLyricsToWords = matchLyricsToAsr
