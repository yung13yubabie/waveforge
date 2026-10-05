// Lyrics are authoritative text. Timing edits never rewrite or normalize it.
export const SCHEMA = 'waveforge.lyrics.v1'
export const MAX_TEXT = 200000
export const MAX_LINES = 5000
export const clone = value => structuredClone(value)

export function createSession(rawText = '', source = null) {
  if (typeof rawText !== 'string' || rawText.length > MAX_TEXT) throw new Error('歌詞最多 200,000 字元')
  const texts = rawText.split(/\r\n|\r|\n/)
  if (texts.length > MAX_LINES) throw new Error('歌詞最多 5,000 行')
  return { schema: SCHEMA, revision: 0, rawText, source: source && clone(source), displayOffsetMs: 0,
    lines: texts.map((text, index) => ({ id: `line-${index + 1}`, text,
      sung: text.trim().length > 0, start: null, end: null, confirmed: false,
      manualLocked: false, timingOrigin: null, alignment: null })) }
}

function parseAlignment(value) {
  if (value == null) return null
  if (typeof value !== 'object' || !['matched', 'unresolved'].includes(value.status)) throw new Error('自動對時狀態無效')
  const evidence = value.evidence
  if (!evidence || !Number.isFinite(evidence.coverage) || evidence.coverage < 0 || evidence.coverage > 1) throw new Error('文字比對依據無效')
  if (!Array.isArray(evidence.reasons) || evidence.reasons.length > 3 || evidence.reasons.some(r => typeof r !== 'string' || r.length > 120)) throw new Error('對時診斷超出範圍')
  const result = { status: value.status, evidence: { coverage: evidence.coverage, reasons: [...evidence.reasons] } }
  for (const key of ['engine', 'model', 'modelRevision', 'language', 'backend']) {
    if (typeof value[key] !== 'string' || !value[key].length || value[key].length > 160) throw new Error('對時來源資訊無效')
    result[key] = value[key]
  }
  if (![1, 2].includes(value.pass)) throw new Error('對時輪次無效')
  result.pass = value.pass
  return result
}

export function parseSession(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (!data || data.schema !== SCHEMA) throw new Error('不支援的歌詞工程版本，原工程未變更')
  const fresh = createSession(data.rawText, data.source)
  if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('工程版本無效')
  if (!Number.isInteger(data.displayOffsetMs) || Math.abs(data.displayOffsetMs) > 60000) throw new Error('字幕偏移須在 ±60,000 ms')
  if (data.source !== null) {
    const s = data.source
    if (!s || typeof s.name !== 'string' || !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isFinite(s.duration) || s.duration <= 0) throw new Error('來源身份無效')
    // Pick known fields rather than retaining arbitrary imported objects.
    fresh.source = { name: s.name, hash: s.hash, duration: s.duration }
  }
  if (!Array.isArray(data.lines) || data.lines.length !== fresh.lines.length) throw new Error('原文行數不一致')
  fresh.lines = fresh.lines.map((line, i) => {
    const candidate = data.lines[i]
    if (!candidate || candidate.id !== line.id || candidate.text !== line.text) throw new Error('原文內容或行序不一致')
    if (typeof candidate.sung !== 'boolean' || typeof candidate.confirmed !== 'boolean') throw new Error('行狀態無效')
    for (const key of ['start', 'end']) {
      const value = candidate[key]
      if (value !== null && (!Number.isFinite(value) || value < 0 || !fresh.source || value > fresh.source.duration)) throw new Error('時間超出來源範圍')
    }
    if (candidate.start !== null && candidate.end !== null && candidate.start >= candidate.end) throw new Error('句首必須早於句尾')
    if (candidate.confirmed && candidate.sung && (candidate.start === null || candidate.end === null)) throw new Error('確認行缺少時間')
    const hasTime = candidate.start !== null || candidate.end !== null
    // Original v1 files only had manual timing. Protect partial, unconfirmed
    // edits too, rather than silently treating legacy times as model output.
    const manualLocked = candidate.manualLocked === undefined ? hasTime || candidate.confirmed : candidate.manualLocked
    if (typeof manualLocked !== 'boolean') throw new Error('人工時間保護狀態無效')
    const timingOrigin = candidate.timingOrigin === undefined ? (hasTime ? 'manual' : null) : candidate.timingOrigin
    if (![null, 'manual', 'automatic'].includes(timingOrigin)) throw new Error('時間來源無效')
    return { ...line, sung: candidate.sung, start: candidate.start, end: candidate.end, confirmed: candidate.confirmed,
      manualLocked: manualLocked || candidate.confirmed, timingOrigin, alignment: parseAlignment(candidate.alignment) }
  })
  fresh.revision = data.revision
  fresh.displayOffsetMs = data.displayOffsetMs
  return fresh
}

export function editLine(session, id, patch) {
  const next = clone(session)
  const line = next.lines.find(l => l.id === id)
  if (!line) throw new Error('找不到歌詞行')
  for (const key of Object.keys(patch)) {
    if (!['start', 'end', 'sung', 'confirmed'].includes(key)) throw new Error('不可改動鎖定原文')
    line[key] = patch[key]
  }
  if ('start' in patch || 'end' in patch || 'sung' in patch) line.confirmed = false
  if ('start' in patch || 'end' in patch) {
    const hasTime = line.start !== null || line.end !== null
    line.manualLocked = hasTime
    line.timingOrigin = hasTime ? 'manual' : null
    line.alignment = null
  }
  if (patch.confirmed === true) line.manualLocked = true
  next.revision++
  return parseSession(next)
}

export function setManualLock(session, id, locked) {
  if (typeof locked !== 'boolean') throw new Error('請選擇是否保留人工時間')
  const next = clone(session), line = next.lines.find(l => l.id === id)
  if (!line) throw new Error('找不到歌詞行')
  line.manualLocked = locked
  // An explicit unlock also removes the manual approval. Export still needs
  // a new confirmation after another model proposal has been adopted.
  if (!locked) line.confirmed = false
  next.revision++
  return parseSession(next)
}

export function adoptAlignmentCandidates(session, result, { targetIds } = {}) {
  const current = parseSession(session)
  if (!current.source || result?.version !== 1 || !Array.isArray(result.candidates)) throw new Error('自動對時結果無效')
  if (result.run?.sourceHash !== current.source.hash || result.run?.sourceRevision !== current.revision) throw new Error('音檔或歌詞已變更，這次結果未套用')
  if (!Array.isArray(targetIds) || targetIds.length === 0 || targetIds.some(id => typeof id !== 'string')) throw new Error('請選擇要採用的歌詞行')
  const targets = new Set(targetIds), known = new Map(current.lines.map(line => [line.id, line]))
  if (targets.size !== targetIds.length || targetIds.some(id => !known.has(id))) throw new Error('目標歌詞行無效')
  if (result.candidates.length > current.lines.length) throw new Error('對時結果行數超出原文')
  const seen = new Set(), next = clone(current)
  const nextLines = new Map(next.lines.map(line => [line.id, line]))
  for (const candidate of result.candidates) {
    if (!candidate || seen.has(candidate.id) || !known.has(candidate.id)) throw new Error('對時结果含重複或未知行')
    seen.add(candidate.id)
    const previous = known.get(candidate.id)
    if (candidate.text !== previous.text) throw new Error('自動對時不得改動鎖定原文')
    if (!['matched', 'unresolved', 'protected', 'context'].includes(candidate.status)) throw new Error('自動對時狀態無效')
    if (!targets.has(candidate.id) || previous.manualLocked || previous.confirmed || !previous.sung || ['protected', 'context'].includes(candidate.status)) continue
    const line = nextLines.get(candidate.id)
    const reasons = candidate.evidence?.reasons
    if (!Array.isArray(reasons) || reasons.some(reason => typeof reason !== 'string')) throw new Error('對時診斷無效')
    line.alignment = parseAlignment({ status: candidate.status,
      evidence: { coverage: candidate.evidence?.coverage, reasons: reasons.slice(0, 3).map(reason => reason.slice(0, 120)) },
      engine: result.run.engine, model: result.run.model, modelRevision: result.run.modelRevision,
      language: result.run.language, backend: result.run.backend, pass: result.run.pass })
    if (candidate.status === 'matched') {
      if (!Number.isFinite(candidate.start) || !Number.isFinite(candidate.end) || candidate.start < 0 || candidate.end > current.source.duration || candidate.end <= candidate.start) throw new Error('模型時間超出音檔或缺少有效邊界')
      line.start = candidate.start; line.end = candidate.end; line.confirmed = false
      line.manualLocked = false; line.timingOrigin = 'automatic'
    }
    // Unresolved proposals only save diagnostic evidence. They never erase
    // previous times or fabricate a boundary from text length/song duration.
  }
  next.revision++
  return parseSession(next)
}

export function diagnostics(session, { precision = 1000, allowOverlap = false, requireConfirmed = true } = {}) {
  const errors = []
  let previousStart = -1, previousEnd = -1
  for (const line of session.lines.filter(l => l.sung)) {
    const prefix = `${line.id}：`
    if (line.start === null || line.end === null) { errors.push(prefix + '待打點'); continue }
    const start = Math.round((line.start + session.displayOffsetMs / 1000) * precision)
    const end = Math.round((line.end + session.displayOffsetMs / 1000) * precision)
    if (start < 0 || end > Math.round((session.source?.duration ?? 0) * precision)) errors.push(prefix + '字幕偏移超出音檔')
    if (start >= end) errors.push(prefix + '格式取整後句首未早於句尾')
    if (start < previousStart) errors.push(prefix + '行序與時間順序衝突')
    if (!allowOverlap && start < previousEnd) errors.push(prefix + '與前句重疊；請校正或允許重疊')
    if (requireConfirmed && !line.confirmed) errors.push(prefix + '尚未確認')
    previousStart = start; previousEnd = end
  }
  if (!session.lines.some(l => l.sung)) errors.push('沒有演唱行')
  return errors
}
