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
      sung: text.trim().length > 0, start: null, end: null, confirmed: false })) }
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
    return { ...line, sung: candidate.sung, start: candidate.start, end: candidate.end, confirmed: candidate.confirmed }
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
