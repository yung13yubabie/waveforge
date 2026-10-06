import '../../css/pitch.css'
import { createPitchAnalysisClient } from './analysis-client.js'
import { describePitch, midiToFrequency, midiToNote, PITCH_ANALYSIS_INFO } from './analysis.js'

const SVG = 'http://www.w3.org/2000/svg'
const PAGE_SIZE = 12
const WIDTH = 800, HEIGHT = 300, LEFT = 58, RIGHT = 16, TOP = 24, BOTTOM = 38
const REASONS = {
  'below-level': '聲音太小或接近安靜',
  transient: '瞬間起音或音量變化太大',
  'low-periodicity': '沒有足夠穩定的重複波形',
  'outside-range': '超出可估計的頻率範圍',
  'isolated-estimate': '只有孤立的估計點，暫不當作音符',
}
const seconds = value => `${value.toFixed(3)} 秒`
const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const isVoiced = frame => frame?.state === 'voiced' && Number.isFinite(frame.midi) && Number.isFinite(frame.frequencyHz)
function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  if (text !== undefined) node.textContent = text
  return node
}
function svgDescription(svg, title, description) {
  svg.replaceChildren(svgNode('title', { id: `${svg.id}-title` }, title), svgNode('desc', { id: `${svg.id}-desc` }, description))
  svg.setAttribute('aria-labelledby', `${svg.id}-title ${svg.id}-desc`)
}
function safeSource(value) {
  const buffer = value?.buffer
  if (!buffer || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || !Number.isSafeInteger(buffer.length) || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1) return null
  return { buffer, id: value.id ?? value.hash ?? null, name: String(value.name ?? '目前原音檔') }
}
function sameSource(a, b) { return a?.buffer === b?.buffer && a?.id === b?.id }

/**
 * One read-only source and an externally coordinated raw-source transport.
 * playRange may return a promise. It should respect the optional AbortSignal /
 * isCurrent guard when waiting for resume/decode before starting playback.
 * No analysis runs until the user explicitly clicks Analyze; no source is stored.
 */
export function initPitchPanel({
  root = document.getElementById('pitch-section'), getSource = () => null,
  playRange, stop = () => {}, beforePlayback = () => {}, onSourceChanged, analysisClient,
  resumeTimeoutMs = 10000,
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
} = {}) {
  if (!root) throw new Error('Pitch panel markup is missing')
  const el = id => root.querySelector(`#pitch-${id}`)
  const client = analysisClient ?? createPitchAnalysisClient()
  const listeners = []
  let source = null, result = null, selected = 0, page = 0, chart = null
  let active = null, analysisEpoch = 0, disposed = false, unsubscribe
  let previewEpoch = 0, previewKind = null, playbackController = null
  let toneContext = null, tone = null, toneController = null
  let waveformPath = '', contourWidth = WIDTH, resizeObserver = null
  const listen = (target, type, handler) => { target.addEventListener(type, handler); listeners.push(() => target.removeEventListener(type, handler)) }
  const status = (text, error = false) => { el('status').textContent = text; el('status').dataset.error = String(error) }
  const targetMidi = () => Number(el('target').value)
  const chosenChannel = () => Number(el('channel').value)
  function selection() {
    const start = el('start').value.trim() === '' ? NaN : Number(el('start').value)
    const end = el('end').value.trim() === '' ? NaN : Number(el('end').value)
    let error = ''
    if (!source) error = '請先載入原音檔'
    else if (!Number.isFinite(start) || !Number.isFinite(end)) error = '請輸入有效的起點與終點秒數'
    else if (start < 0 || end > source.buffer.duration + 1e-9) error = `範圍需在 0 到 ${source.buffer.duration.toFixed(3)} 秒之間`
    else if (end <= start) error = '終點必須晚於起點'
    else if (end - start > PITCH_ANALYSIS_INFO.maxDuration + 1e-9) error = '每次最多 60 秒；請縮短所選片段'
    else if (end - start < PITCH_ANALYSIS_INFO.frameDuration) error = '片段太短，請至少選取 0.064 秒'
    return { start, end, error }
  }
  function controls() {
    const range = selection()
    el('start').disabled = el('end').disabled = !source
    el('channel').disabled = !source || source.buffer.numberOfChannels < 2
    el('analyze').disabled = disposed || !!active || !!range.error
    el('play-original').disabled = disposed || !!range.error || typeof playRange !== 'function'
    el('cancel').hidden = !active
    el('progress').hidden = !active
    el('range-error').textContent = source ? range.error : ''
    for (const id of ['start', 'end']) el(id).setAttribute('aria-invalid', String(!!source && !!range.error))
    el('point').disabled = !result?.frames.length
    el('prev-page').disabled = !result?.frames.length || page === 0
    el('next-page').disabled = !result?.frames.length || (page + 1) * PAGE_SIZE >= result.frames.length
  }
  function invalidate(message, clear = true) {
    const hadTask = !!active
    ++analysisEpoch
    active?.controller.abort(); active = null
    client.cancel()
    if (clear) { result = null; selected = 0; page = 0; chart = null; renderResult() }
    controls()
    if (message && (hadTask || clear)) status(message)
  }
  function closeContext(context) {
    if (!context) return
    try { Promise.resolve(context.close()).catch(() => {}) } catch { /* already closed */ }
  }
  function resumeContext(context, signal) {
    return new Promise((resolve, reject) => {
      let timer
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
      const finish = (error) => { cleanup(); if (error) reject(error); else resolve() }
      const onAbort = () => finish(Object.assign(new Error('已停止參考音'), { name: 'AbortError' }))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) { onAbort(); return }
      timer = setTimeout(() => finish(Object.assign(new Error('音訊啟動逾時，請再試一次'), { name: 'TimeoutError' })), resumeTimeoutMs)
      try { Promise.resolve(context.resume()).then(() => finish(), error => finish(error)) } catch (error) { finish(error) }
    })
  }
  function disconnectTone(record) {
    if (!record) return
    record.oscillator.onended = null
    try { record.oscillator.stop() } catch { /* already stopped */ }
    record.oscillator.disconnect(); record.gain.disconnect()
  }
  function stopPreview() {
    ++previewEpoch
    const oldKind = previewKind
    previewKind = null
    playbackController?.abort(); playbackController = null
    if (oldKind === 'source' || oldKind === 'source-pending') stop()
    const oldTone = tone; tone = null; disconnectTone(oldTone)
    toneController?.abort(); toneController = null
    const context = toneContext; toneContext = null; closeContext(context)
    if (oldKind) el('preview-status').textContent = '已停止試聽'
  }
  function selectedReadout(frame) {
    if (!frame) return '分析後選一個時間點'
    if (!isVoiced(frame)) return `${seconds(frame.time)}：${frame.state === 'uncertain' ? '不確定' : '無明確音高'}。${REASONS[frame.reason] ?? '沒有足夠可靠的音高資料'}。不代表唱錯。`
    const info = describePitch(frame.frequencyHz, targetMidi())
    const cents = Math.round(info.referenceCents)
    const comparison = Math.abs(cents) <= 5 ? `接近你選的 ${midiToNote(targetMidi())}（相差 ${Math.abs(cents)} 音分）` : `比你選的 ${midiToNote(targetMidi())} ${cents > 0 ? '高' : '低'} ${Math.abs(cents)} 音分`
    return `${seconds(frame.time)} · ${info.note} · ${frame.frequencyHz.toFixed(1)} Hz\n${comparison}。${Math.abs(cents) > 100 ? '可能本來就在唱別的音。' : ''}`
  }
  function renderPoint() {
    const frames = result?.frames ?? []
    selected = clamp(selected, 0, Math.max(0, frames.length - 1))
    const frame = frames[selected]
    el('point').max = String(Math.max(0, frames.length - 1)); el('point').value = String(selected)
    el('point').setAttribute('aria-valuetext', frame ? `${seconds(frame.time)}，${isVoiced(frame) ? `估計 ${midiToNote(frame.midi)}` : '無可靠音高'}` : '尚無分析資料')
    el('point-readout').textContent = selectedReadout(frame)
    const marker = el('contour').querySelector('.pitch-marker')
    if (marker) {
      marker.replaceChildren()
      if (frame && chart) {
        marker.append(svgNode('line', { x1: chart.x(frame.time), x2: chart.x(frame.time), y1: TOP, y2: chart.height - BOTTOM, class: 'pitch-selected-line' }))
        if (isVoiced(frame)) marker.append(svgNode('circle', { cx: chart.x(frame.time), cy: chart.y(frame.midi), r: 4, class: 'pitch-selected-dot' }))
      }
    }
  }
  function renderTable() {
    el('rows').replaceChildren()
    const frames = result?.frames ?? []
    if (!frames.length) { el('page').textContent = '尚無資料'; controls(); return }
    const begin = page * PAGE_SIZE, end = Math.min(frames.length, begin + PAGE_SIZE)
    el('page').textContent = `${begin + 1}–${end} / ${frames.length} 點`
    for (let i = begin; i < end; i++) {
      const frame = frames[i], row = document.createElement('tr')
      row.setAttribute('aria-selected', String(i === selected))
      for (const text of [seconds(frame.time), isVoiced(frame) ? midiToNote(frame.midi) : '—', isVoiced(frame) ? `${frame.frequencyHz.toFixed(1)} Hz` : '—', isVoiced(frame) ? '有可辨識音高' : `${frame.state === 'uncertain' ? '不確定' : '無明確音高'} · ${REASONS[frame.reason] ?? '資料不足'}`]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell)
      }
      const cell = document.createElement('td'), button = document.createElement('button')
      button.type = 'button'; button.textContent = '查看'; button.dataset.point = String(i)
      button.setAttribute('aria-label', `查看 ${seconds(frame.time)} 的音高`)
      cell.append(button); row.append(cell); el('rows').append(row)
    }
    controls()
  }
  function drawContour() {
    const svg = el('contour')
    const width = Math.max(280, Math.round(svg.getBoundingClientRect().width || WIDTH))
    const height = width < 500 ? 220 : HEIGHT
    contourWidth = width
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.style.height = `${height}px`
    const frames = result?.frames ?? [], known = frames.filter(isVoiced)
    const desc = !result ? '尚未分析，沒有音高曲線。分析後可使用下方時間點控制及資料表查看相同資料。' : `${seconds(result.start)} 至 ${seconds(result.start + result.duration)}，${frames.length} 個時間點，其中 ${known.length} 點有可辨識音高。空段不連線，無法判斷旋律是否正確。下方時間點控制及資料表提供相同資料。`
    svgDescription(svg, '所選片段的音高估計', desc)
    chart = null
    if (!frames.length) {
      svg.append(svgNode('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, result ? '片段太短，沒有足夠的分析時間點' : '選取片段並分析後顯示實際音高'))
      return
    }
    const midis = known.map(frame => frame.midi)
    let low = known.length ? Math.floor(Math.min(...midis)) - 3 : 57
    let high = known.length ? Math.ceil(Math.max(...midis)) + 3 : 81
    if (high - low < 12) { const center = (high + low) / 2; low = Math.floor(center - 6); high = low + 12 }
    const x = time => LEFT + clamp((time - result.start) / result.duration, 0, 1) * (width - LEFT - RIGHT)
    const y = midi => TOP + (high - midi) / (high - low) * (height - TOP - BOTTOM)
    chart = { x, y, height }
    const step = high - low > 30 ? 12 : high - low > 18 ? 6 : 3
    for (let midi = Math.ceil(low / step) * step; midi <= high; midi += step) {
      svg.append(svgNode('line', { x1: LEFT, x2: width - RIGHT, y1: y(midi), y2: y(midi), class: 'pitch-grid' }))
      svg.append(svgNode('text', { x: LEFT - 10, y: y(midi) + 4, 'text-anchor': 'end' }, midiToNote(midi)))
    }
    for (let i = 0; i <= 4; i++) {
      const time = result.start + result.duration * i / 4, tx = x(time)
      svg.append(svgNode('line', { x1: tx, x2: tx, y1: TOP, y2: height - BOTTOM, class: 'pitch-grid' }))
      svg.append(svgNode('text', { x: tx, y: height - 12, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, `${time.toFixed(2)}s`))
    }
    // Merge unknown time spans. Never connect known points across an unknown frame.
    let unknownStart = null
    const addUnknown = end => {
      if (unknownStart !== null) svg.append(svgNode('rect', { x: x(unknownStart), y: TOP, width: Math.max(1, x(end) - x(unknownStart)), height: height - TOP - BOTTOM, class: 'pitch-unknown' }))
      unknownStart = null
    }
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i], before = i === 0 ? result.start : (frames[i - 1].time + frame.time) / 2
      if (!isVoiced(frame) && unknownStart === null) unknownStart = before
      if (isVoiced(frame) && unknownStart !== null) addUnknown(before)
    }
    addUnknown(result.start + result.duration)
    const reference = targetMidi()
    if (reference >= low && reference <= high) {
      svg.append(svgNode('line', { x1: LEFT, x2: width - RIGHT, y1: y(reference), y2: y(reference), class: 'pitch-target-line' }))
      svg.append(svgNode('text', { x: width - RIGHT - 5, y: y(reference) - 6, 'text-anchor': 'end' }, `參考 ${midiToNote(reference)}`))
    } else svg.append(svgNode('text', { x: width - RIGHT, y: 15, 'text-anchor': 'end' }, `參考 ${midiToNote(reference)} 在圖外${reference > high ? '上方' : '下方'}`))
    let path = '', previous = null
    for (const frame of frames) {
      if (!isVoiced(frame)) { previous = null; continue }
      const connected = previous && frame.time - previous.time <= (result.hopDuration || .02) * 1.6
      path += `${connected ? 'L' : 'M'}${x(frame.time).toFixed(2)},${y(frame.midi).toFixed(2)} `
      if (!connected) svg.append(svgNode('circle', { cx: x(frame.time), cy: y(frame.midi), r: 2, class: 'pitch-estimate-dot' }))
      previous = frame
    }
    if (path) svg.append(svgNode('path', { d: path, class: 'pitch-estimate' }))
    if (!known.length) svg.append(svgNode('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, '這段未找到可靠音高，請換較清楚的單音片段'))
    svg.append(svgNode('g', { class: 'pitch-marker', 'aria-hidden': 'true' }))
  }
  function renderResult() {
    if (!result) el('summary').textContent = '選好片段，再按「分析片段」'
    else {
      const known = result.frames.filter(isVoiced).length
      el('summary').textContent = `${seconds(result.start)}–${seconds(result.start + result.duration)} · 第 ${Number(result.channel ?? chosenChannel()) + 1} 聲道 · ${known} / ${result.frames.length} 點可辨識。計數不是正確率。`
    }
    drawContour(); renderPoint(); renderTable(); controls()
  }
  function buildWaveform() {
    waveformPath = ''
    if (!source) return
    const data = source.buffer.getChannelData(chosenChannel())
    const columns = Math.min(720, data.length)
    const top = [], bottom = []
    // Bounded sampled overview, not a substitute for the analysis PCM. It never
    // sums channels, so anti-phase stereo cannot make the display falsely silent.
    for (let column = 0; column < columns; column++) {
      const begin = Math.floor(column * data.length / columns), end = Math.floor((column + 1) * data.length / columns)
      const stride = Math.max(1, Math.ceil((end - begin) / 160))
      let min = 0, max = 0
      for (let i = begin; i < end; i += stride) { const value = Number.isFinite(data[i]) ? clamp(data[i], -1, 1) : 0; min = Math.min(min, value); max = Math.max(max, value) }
      const x = column / Math.max(1, columns - 1) * WIDTH
      top.push(`${x.toFixed(2)},${(50 - max * 40).toFixed(2)}`); bottom.unshift(`${x.toFixed(2)},${(50 - min * 40).toFixed(2)}`)
    }
    if (top.length) waveformPath = `M${top.join(' L')} L${bottom.join(' L')} Z`
  }
  function drawWaveform() {
    const svg = el('waveform'), range = selection()
    svgDescription(svg, '原音波形總覽', source ? `${source.name}，總長 ${seconds(source.buffer.duration)}，第 ${chosenChannel() + 1} 聲道取樣波形。${range.error || `已選 ${seconds(range.start)} 至 ${seconds(range.end)}`}。下方秒數欄位可用鍵盤選取。` : '尚未載入音訊，沒有波形')
    if (!source) { svg.append(svgNode('text', { x: WIDTH / 2, y: 55, 'text-anchor': 'middle' }, '載入原音後顯示波形')); return }
    svg.append(svgNode('line', { x1: 0, x2: WIDTH, y1: 50, y2: 50, class: 'pitch-wave-line' }))
    if (waveformPath) svg.append(svgNode('path', { d: waveformPath, class: 'pitch-wave-shape' }))
    if (!range.error) svg.append(svgNode('rect', { x: range.start / source.buffer.duration * WIDTH, width: (range.end - range.start) / source.buffer.duration * WIDTH, y: 2, height: 96, class: 'pitch-wave-selection' }))
  }
  function refreshSource() {
    if (disposed) return
    const next = safeSource(getSource())
    if (sameSource(source, next)) {
      if (next) { source.name = next.name; el('source').textContent = `${source.name} · ${source.buffer.duration.toFixed(3)} 秒 · ${source.buffer.numberOfChannels} 聲道` }
      return
    }
    stopPreview(); source = next
    invalidate(null)
    el('channel').replaceChildren()
    if (source) {
      const count = source.buffer.numberOfChannels
      for (let i = 0; i < count; i++) {
        const option = document.createElement('option'); option.value = String(i)
        option.textContent = count === 1 ? '單聲道' : `第 ${i + 1} 聲道${count === 2 ? i === 0 ? '（左）' : '（右）' : ''}`
        el('channel').append(option)
      }
      el('start').value = '0'; el('end').value = String(Math.floor(Math.min(source.buffer.duration, 60) * 1000) / 1000)
      el('start').max = el('end').max = String(source.buffer.duration)
      el('source').textContent = `${source.name} · ${source.buffer.duration.toFixed(3)} 秒 · ${count} 聲道`
      status(source.buffer.duration > 60 ? '已選前 60 秒；可改起訖秒數查看其他片段。尚未分析' : '原音已就緒 · 選好片段後分析')
    } else {
      el('start').value = el('end').value = '0'
      el('source').textContent = '尚未載入音訊'
      status('先載入原音檔')
    }
    buildWaveform(); drawWaveform(); controls()
  }
  async function analyze() {
    if (disposed) return
    refreshSource()
    const range = selection()
    if (range.error || active) { controls(); return }
    invalidate(null)
    const epoch = ++analysisEpoch, acceptedSource = source, controller = new AbortController()
    active = { epoch, controller }
    const current = () => !disposed && epoch === analysisEpoch && sameSource(acceptedSource, safeSource(getSource())) && !controller.signal.aborted
    status('正在本機分析…')
    el('progress').value = 0; controls()
    try {
      const value = await client.analyze(source.buffer, {
        start: range.start, duration: Math.min(60, range.end - range.start), channel: chosenChannel(), signal: controller.signal,
        onProgress: progress => { if (current()) { const value = progress?.progress; if (Number.isFinite(value)) el('progress').value = clamp(value, 0, 1) } },
      })
      if (!current()) { if (!disposed && epoch === analysisEpoch) refreshSource(); return }
      result = value; selected = Math.max(0, result.frames.findIndex(isVoiced)); page = Math.floor(selected / PAGE_SIZE)
      renderResult()
      status(result.frames.some(isVoiced) ? '分析完成 · 選一個時間點比較' : '這段未找到可靠音高；請改選較清楚的獨唱或單音片段')
    } catch (error) {
      if (!current()) return
      status(error?.name === 'TimeoutError' ? '分析時間過長，已停止。請改選較短片段後再試' : error?.name === 'AbortError' ? '已取消分析' : `無法完成音高分析：${error?.message ?? '未知錯誤'}`, error?.name !== 'AbortError')
    } finally {
      if (!disposed && epoch === analysisEpoch) { active = null; controls() }
    }
  }
  async function playOriginal() {
    if (disposed) return
    refreshSource()
    const range = selection()
    if (range.error || typeof playRange !== 'function') return
    stopPreview()
    const epoch = ++previewEpoch, acceptedSource = source
    const controller = new AbortController(); playbackController = controller; previewKind = 'source-pending'
    const isCurrent = () => !disposed && epoch === previewEpoch && !controller.signal.aborted && sameSource(acceptedSource, safeSource(getSource()))
    el('preview-status').textContent = '正在準備原音試聽'
    try {
      await beforePlayback()
      if (!isCurrent()) return
      await playRange(range.start, range.end, {
        signal: controller.signal, isCurrent,
        onEnded: () => {
          if (!isCurrent()) return
          ++previewEpoch; previewKind = null; playbackController = null
          el('preview-status').textContent = '原音片段已播完'
        },
      })
      if (!isCurrent()) return
      previewKind = 'source'; el('preview-status').textContent = `A · 原音試聽 ${seconds(range.start)}–${seconds(range.end)}`
    } catch (error) {
      if (isCurrent()) { previewKind = null; playbackController = null; el('preview-status').textContent = `原音試聽失敗：${error?.message ?? '請再試一次'}` }
    }
  }
  async function playTone() {
    if (disposed) return
    stopPreview()
    stop() // Reference playback also retires the raw source transport.
    // A fresh context belongs to this explicit click, and is closed on end/Stop.
    // Never queue behind a suspended context: an interrupted browser resume must
    // not block all later attempts or race a delayed suspend into the next tone.
    const epoch = ++previewEpoch
    if (!AudioContextClass) { el('preview-status').textContent = '此瀏覽器無法產生參考音'; return }
    try { toneContext = new AudioContextClass() } catch { el('preview-status').textContent = '無法啟動參考音，請檢查瀏覽器音訊設定'; return }
    const context = toneContext, midi = targetMidi(), controller = new AbortController()
    toneController = controller
    const current = () => !disposed && epoch === previewEpoch && context === toneContext && !controller.signal.aborted
    previewKind = 'reference-pending'; el('preview-status').textContent = '正在準備參考音'
    try {
      await beforePlayback()
      if (!current()) return
      await resumeContext(context, controller.signal)
      if (!current()) return
      const oscillator = context.createOscillator(), gain = context.createGain()
      const now = context.currentTime, volume = clamp(Number(el('tone-volume').value) || 0, 0, .06)
      const record = { oscillator, gain }; tone = record
      oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(midiToFrequency(midi), now)
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + .025)
      gain.gain.setValueAtTime(volume, now + 1.9); gain.gain.linearRampToValueAtTime(0, now + 2)
      oscillator.connect(gain); gain.connect(context.destination)
      previewKind = 'reference'
      oscillator.onended = () => {
        oscillator.disconnect(); gain.disconnect()
        if (tone !== record) return
        tone = null; toneController = null; toneContext = null; previewKind = null
        closeContext(context); el('preview-status').textContent = '參考音已播完'
      }
      oscillator.start(now); oscillator.stop(now + 2)
      el('preview-status').textContent = `B · ${midiToNote(midi)}，${midiToFrequency(midi).toFixed(1)} Hz，播放 2 秒`
    } catch (error) {
      if (current()) {
        disconnectTone(tone); tone = null; toneController = null; toneContext = null; previewKind = null
        closeContext(context); el('preview-status').textContent = `參考音無法播放：${error?.message ?? '請再試一次'}`
      }
    }
  }
  function updateReference() {
    el('target-description').textContent = `${midiToNote(targetMidi())} · ${midiToFrequency(targetMidi()).toFixed(1)} Hz`
    drawContour(); renderPoint()
  }
  const referenceOptions = document.createDocumentFragment()
  for (let midi = 36; midi <= 84; midi++) {
    const option = document.createElement('option'); option.value = String(midi); option.textContent = `${midiToNote(midi)} · ${midiToFrequency(midi).toFixed(1)} Hz`; referenceOptions.append(option)
  }
  el('target').replaceChildren(referenceOptions); el('target').value = '69'
  listen(el('analyze'), 'click', analyze)
  listen(el('cancel'), 'click', () => invalidate('已取消分析', false))
  for (const id of ['start', 'end']) listen(el(id), 'input', () => { stopPreview(); invalidate('範圍已變更，請重新分析'); drawWaveform() })
  listen(el('channel'), 'change', () => { stopPreview(); invalidate('分析聲道已變更，請重新分析'); buildWaveform(); drawWaveform() })
  listen(el('waveform'), 'click', event => {
    if (!source || disposed) return
    const bounds = el('waveform').getBoundingClientRect()
    if (!bounds.width) return
    const range = selection(), duration = range.error ? Math.min(source.buffer.duration, 60) : range.end - range.start
    const time = clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * source.buffer.duration
    const start = clamp(time - duration / 2, 0, source.buffer.duration - duration)
    el('start').value = String(Math.floor(start * 1000) / 1000); el('end').value = String(Math.floor((start + duration) * 1000) / 1000)
    stopPreview(); invalidate('範圍已變更，請重新分析'); drawWaveform()
  })
  listen(el('target'), 'change', () => { if (previewKind?.startsWith('reference')) stopPreview(); updateReference() })
  listen(el('point'), 'input', () => { selected = Number(el('point').value); page = Math.floor(selected / PAGE_SIZE); renderPoint(); renderTable() })
  listen(el('rows'), 'click', event => { const button = event.target.closest('[data-point]'); if (button) { selected = Number(button.dataset.point); renderPoint(); renderTable() } })
  listen(el('prev-page'), 'click', () => { if (page > 0) { page--; renderTable() } })
  listen(el('next-page'), 'click', () => { if ((page + 1) * PAGE_SIZE < (result?.frames.length ?? 0)) { page++; renderTable() } })
  listen(el('play-original'), 'click', playOriginal)
  listen(el('play-tone'), 'click', playTone)
  listen(el('stop'), 'click', stopPreview)
  listen(el('tone-volume'), 'input', () => { if (previewKind?.startsWith('reference')) stopPreview() })
  listen(document, 'wf:mode-change', event => { if (event.detail?.mode !== 'pitch') { stopPreview(); if (active) invalidate('已離開音高助手，分析已取消', false) } else refreshSource() })
  listen(document, 'visibilitychange', () => { if (document.hidden) stopPreview() })
  const resizeContour = () => {
    if (disposed) return
    const width = Math.round(el('contour').getBoundingClientRect().width)
    if (width > 0 && width !== contourWidth) { drawContour(); renderPoint() }
  }
  listen(window, 'resize', resizeContour)
  if (typeof globalThis.ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(resizeContour); resizeObserver.observe(el('contour'))
  }
  updateReference(); renderResult(); drawWaveform(); refreshSource()
  if (typeof onSourceChanged === 'function') unsubscribe = onSourceChanged(refreshSource)
  return {
    refreshSource, stopPreview,
    dispose() {
      if (disposed) return
      stopPreview(); disposed = true
      ++analysisEpoch; active?.controller.abort(); active = null
      client.dispose(); resizeObserver?.disconnect(); resizeObserver = null; if (typeof unsubscribe === 'function') unsubscribe()
      for (const remove of listeners) remove()
      const context = toneContext; toneContext = null; closeContext(context)
      source = null; result = null; chart = null; waveformPath = ''; playbackController = null
      el('channel').replaceChildren(); el('rows').replaceChildren(); controls()
      for (const control of root.querySelectorAll('button, input, select')) control.disabled = true
    },
  }
}
