import { diagnostics, parseSession } from './session.js'

function clock(ticks, precision, separator) {
  const fraction = ticks % precision
  const seconds = Math.floor(ticks / precision)
  const hh = Math.floor(seconds / 3600).toString().padStart(2, '0')
  const mm = Math.floor(seconds / 60 % 60).toString().padStart(2, '0')
  const ss = (seconds % 60).toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}${separator}${fraction.toString().padStart(precision === 100 ? 2 : 3, '0')}`
}
// ASS has renderer-specific escaping; fail visibly instead of changing raw text.
function assText(text) {
  if (/[{}\\]/.test(text)) throw new Error('原文含 ASS 控制字元（大括號／反斜線），請使用 TXT／SRT；未改動原文')
  return text
}

export function exportLyrics(input, format, { allowOverlap = false } = {}) {
  const session = parseSession(input)
  if (format === 'txt') return session.rawText
  if (!['lrc', 'srt', 'ass'].includes(format)) throw new Error('不支援的歌詞格式')
  const precision = format === 'srt' ? 1000 : 100
  const errors = diagnostics(session, { precision, allowOverlap: format === 'lrc' ? false : allowOverlap })
  if (format === 'lrc' && errors.some(error => error.includes('重疊'))) throw new Error('LRC 無法完整表達重疊歌詞，請調整時間或改用 SRT／ASS')
  if (errors.length) throw new Error(errors.join('\n'))
  const rows = session.lines.filter(l => l.sung).map(l => ({ text: l.text,
    start: Math.round((l.start + session.displayOffsetMs / 1000) * precision),
    end: Math.round((l.end + session.displayOffsetMs / 1000) * precision) }))
  if (rows.some(r => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.text))) throw new Error('原文含字幕控制字元，請使用 TXT 保存原文')
  if (format === 'lrc') {
    // Minutes do not wrap at an hour. End markers preserve instrumental gaps.
    const stamp = t => `[${Math.floor(t / 6000).toString().padStart(2, '0')}:${(Math.floor(t / 100) % 60).toString().padStart(2, '0')}.${(t % 100).toString().padStart(2, '0')}]`
    return rows.map((r, i) => {
      if (/\[\d+:\d{2}(?:[.:]\d+)?\]/.test(r.text)) throw new Error('原文含 LRC 時碼語法，請使用 TXT／SRT 保存原文')
      const next = rows[i + 1]
      return stamp(r.start) + r.text + ((!next || r.end < next.start) ? '\n' + stamp(r.end) : '')
    }).join('\n') + '\n'
  }
  if (format === 'srt' && rows.some(r => /<[^>]+>/.test(r.text))) throw new Error('原文含 SRT 樣式標記，請使用 TXT 保存原文')
  if (format === 'srt') return rows.map((r, i) => `${i + 1}\n${clock(r.start, 1000, ',')} --> ${clock(r.end, 1000, ',')}\n${r.text}`).join('\n\n') + '\n'
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,40,40,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`
  return header + rows.map(r => `Dialogue: 0,${clock(r.start, 100, '.')},${clock(r.end, 100, '.')},Default,,0,0,0,,${assText(r.text)}`).join('\n') + '\n'
}
