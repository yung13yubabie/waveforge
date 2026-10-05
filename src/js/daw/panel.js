import { createProject, applyCommand, registerAudioBuffer, getProjectDuration, generateId, DAW_LIMITS, getClipVolumeAutomation, envelopeValueAt } from './project.js'
import { renderProject } from './render.js'
import { ProjectHistory } from './history.js'
import { exportProjectArchive, importProjectArchive, archiveFileName } from './archive.js'
import { sha256Hex } from '../audio/sha256.js'
import { encodeWAV } from '../audio/wav.js'
import { decodeDawAsset } from './decode.js'

const FILE_LIMIT = 64 * 1024 * 1024
const abortError = () => new DOMException('已取消', 'AbortError')
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
export function formatDawTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}
export function snapDawTime(seconds, tempo, beats = 1, enabled = true) {
  const step = enabled ? 60 / tempo * beats : .001
  return Math.max(0, Math.round(seconds / step) * step)
}
function node(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}
function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = node('a'); a.href = url; a.download = name; a.hidden = true
  document.body.append(a); a.click(); a.remove()
  // Downloads start asynchronously in some browsers; revoke after the handoff.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function decodedBytes(buffers) {
  return [...buffers.values()].reduce((sum, buffer) => sum + buffer.length * buffer.numberOfChannels * 4, 0)
}

/** Local runtime owns audio; project/history contain only portable metadata. */
export function initDawPanel({ decodeAsset, onSendToMaster, beforePlayback,
  confirmAction = message => window.confirm(message), downloadFile = download,
  AudioContextClass = globalThis.AudioContext } = {}) {
  const root = document.getElementById('mode-editor')
  if (!root) return null
  const el = id => document.getElementById(`daw-${id}`)
  const button = command => root.querySelector(`[data-daw="${command}"]`)
  const disposers = []
  const listen = (target, event, fn, options) => {
    target.addEventListener(event, fn, options)
    disposers.push(() => target.removeEventListener(event, fn, options))
  }
  let project = createProject({ name: '未命名專案' })
  let history = new ProjectHistory(project)
  let buffers = new Map(), files = new Map()
  let saved = JSON.stringify(project), hasDownloaded = false
  let selection = null, cursor = 0, mix = null, job = null, generation = 0
  let context = null, source = null, frame = null, playback = null, destroyed = false
  let drag = null, suppressClick = false, automationDrag = null, automationIndex = 0, automationClipId = null
  const getContext = () => context ||= new AudioContextClass()
  const dirty = () => saved !== JSON.stringify(project)
  const selected = () => {
    const track = project.tracks.find(item => item.id === selection?.trackId)
    const clip = track?.clips.find(item => item.id === selection?.clipId)
    return clip ? { track, clip } : null
  }
  const duration = () => getProjectDuration(project)
  const gridStep = () => 60 / project.tempo * Number(el('grid').value)
  const snap = seconds => snapDawTime(seconds, project.tempo, Number(el('grid').value), el('snap').checked)
  const status = (message, error = false) => { el('status').textContent = message; el('status').dataset.error = String(error) }
  const report = error => {
    if (error?.name === 'AbortError') return
    // Immediate-value controls must never display rejected state as applied.
    for (const [key, value] of Object.entries({ name: project.name, tempo: project.tempo, 'sample-rate': project.sampleRate, 'master-gain': project.masterGainDb })) el(key).value = String(value)
    const item = selected()
    if (item) { el('clip-name').value = item.clip.name; el('clip-gain').value = String(item.clip.gainDb) }
    root.querySelectorAll('input[data-track-control]').forEach(input => {
      const track = project.tracks.find(track => track.id === input.dataset.trackId)
      if (track) input.value = String(track[input.dataset.trackControl])
    })
    renderAutomation()
    status(error?.message || String(error), true)
  }
  const run = task => Promise.resolve().then(task).catch(report)
  const currentTime = () => {
    if (!playback || !context) return cursor
    const elapsed = context.currentTime - playback.started
    return playback.loop ? playback.start + (elapsed % (playback.end - playback.start)) : Math.min(playback.end, playback.start + elapsed)
  }
  function paintPlayhead() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    const time = currentTime()
    el('seek').value = String(time)
    el('time').textContent = `${formatDawTime(time)} / ${formatDawTime(duration())}`
    const x = time * Number(el('zoom').value)
    root.querySelectorAll('.daw-playhead').forEach(line => { line.style.left = `${x}px` })
    if (source) frame = requestAnimationFrame(paintPlayhead)
  }
  function stop({ rewind = false } = {}) {
    cursor = rewind ? 0 : currentTime()
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    if (source) { source.onended = null; try { source.stop() } catch { /* Already ended. */ } source.disconnect() }
    source = null; playback = null
    button('play').textContent = '播放混音'
    button('stop').disabled = !job && cursor === 0
    paintPlayhead()
  }
  function cancelJob(message = '已取消；原專案保持不變') {
    if (!job) return
    job.controller.abort(); generation++; job = null
    status(message); refreshControls()
  }
  function invalidate() {
    automationDrag = null
    stop()
    mix = null
    if (job && ['render', 'transfer'].includes(job.kind)) cancelJob('設定已修改，請重新產生混音')
  }
  function retainHistoryAssets() {
    const ids = history.retainedAssetIds()
    for (const id of buffers.keys()) if (!ids.has(id)) buffers.delete(id)
    for (const id of files.keys()) if (!ids.has(id)) files.delete(id)
  }
  function commit(next, label) {
    history.push(next) // Validate before replacing state or invalidating playback.
    invalidate(); project = next
    retainHistoryAssets()
    if (!selected()) selection = null
    cursor = clamp(cursor, 0, duration())
    render(); status(label)
  }
  function command(value, label) {
    if (job && ['import', 'open'].includes(job.kind)) throw new Error('請等待匯入完成，或先取消目前工作')
    commit(applyCommand(project, value), label)
  }
  function clipCommand(type, extra, label) {
    const item = selected()
    if (!item) throw new Error('請先選取一個片段')
    command({ type, trackId: item.track.id, clipId: item.clip.id, ...extra }, label)
  }
  function changeHistory(direction) {
    if (job && ['import', 'open'].includes(job.kind)) return
    const next = history[direction]()
    if (!next) return
    invalidate(); project = next
    if (!selected()) selection = null
    cursor = clamp(cursor, 0, duration()); render(); status(direction === 'undo' ? '已復原上一步' : '已重做')
  }
  function refreshControls() {
    const locked = job && ['import', 'open'].includes(job.kind)
    const hasClips = duration() > 0
    button('undo').disabled = Boolean(locked || !history.canUndo)
    button('redo').disabled = Boolean(locked || !history.canRedo)
    for (const key of ['import', 'open', 'save', 'export', 'master']) button(key).disabled = Boolean(job || (['save', 'export', 'master'].includes(key) && !project.tracks.length) || (['export', 'master'].includes(key) && !hasClips) || (key === 'master' && !onSendToMaster))
    button('play').disabled = Boolean(job || !hasClips)
    button('stop').disabled = !source && !job && cursor === 0
    button('cancel').hidden = !job
    button('add-track').disabled = Boolean(locked || project.tracks.length >= DAW_LIMITS.maxTracks)
    el('clip-fields').disabled = Boolean(locked || !selected())
    for (const key of ['name', 'tempo', 'sample-rate', 'master-gain']) el(key).disabled = Boolean(locked)
    root.querySelectorAll('[data-track-control]').forEach(control => { control.disabled = Boolean(locked) })
    el('save-state').textContent = job?.kind === 'save' ? '正在製作工程下載…' : dirty() ? '有未下載的修改' : hasDownloaded ? '目前版本已交付下載；請確認檔案已存好' : project.tracks.length ? '已開啟工程；修改後請重新下載' : '尚無修改'
    root.setAttribute('aria-busy', String(Boolean(job)))
  }
  function renderInspector() {
    const item = selected()
    el('selection-title').textContent = item ? `${item.track.name} › ${item.clip.name}` : '尚未選取片段'
    el('selection-range').textContent = item ? `${formatDawTime(item.clip.atSeconds)}–${formatDawTime(item.clip.atSeconds + item.clip.durationSeconds)} · 原檔保留不變${item.clip.gainEnvelope ? '。保留裁切前的接縫曲線；重新套用淡入／淡出會替換它' : ''}` : '點選波形，這裡只修改該片段'
    if (item) {
      const { clip, track } = item
      for (const [key, value] of Object.entries({ 'clip-name': clip.name, 'clip-at': clip.atSeconds, 'trim-start': clip.atSeconds, 'trim-end': clip.atSeconds + clip.durationSeconds, 'clip-gain': clip.gainDb, 'fade-in': clip.fadeInSeconds, 'fade-out': clip.fadeOutSeconds })) el(key).value = typeof value === 'number' ? String(value) : value
      el('clip-track').replaceChildren(...project.tracks.map(t => { const option = node('option', '', t.name); option.value = t.id; return option }))
      el('clip-track').value = track.id
    }
    renderAutomation()
    root.querySelectorAll('.daw-clip').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.clipId === selection?.clipId)))
    refreshControls()
  }
  function renderAutomation(previewPoints) {
    const item = selected(), graph = el('automation-graph')
    const points = item ? previewPoints || getClipVolumeAutomation(item.clip) : []
    if (automationClipId !== item?.clip.id) { automationClipId = item?.clip.id; automationIndex = 0; automationDrag = null }
    automationIndex = clamp(automationIndex, 0, Math.max(0, points.length - 1))
    graph.replaceChildren()
    const svgNode = (tag, attributes, text) => {
      const result = document.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attributes)) result.setAttribute(key, String(value))
      if (text !== undefined) result.textContent = text
      graph.append(result); return result
    }
    for (const value of [0, 1, 2]) {
      const y = 124 - value * 54
      svgNode('line', { x1: 16, x2: 304, y1: y, y2: y, class: value === 1 ? 'daw-automation-unity' : 'daw-automation-grid' })
      svgNode('text', { x: 20, y: y - 3 }, `${value * 100}%`)
    }
    if (item) {
      const coordinates = points.map(point => [16 + point.timeSeconds / item.clip.durationSeconds * 288, 124 - point.value * 54])
      svgNode('polyline', { points: coordinates.map(point => point.join(',')).join(' '), class: 'daw-automation-line' })
      coordinates.forEach(([cx, cy], index) => svgNode('circle', { cx, cy, r: 7, class: 'daw-automation-dot', 'data-automation-index': index, 'data-selected': index === automationIndex }))
    }
    el('automation-point').replaceChildren(...points.map((point, index) => {
      const label = index === 0 ? '起點' : index === points.length - 1 ? '終點' : `中間點 ${index}`
      const option = node('option', '', `${label} · ${Number(point.timeSeconds.toFixed(4))} 秒 · ${Number((point.value * 100).toFixed(2))}%`)
      option.value = String(index); return option
    }))
    el('automation-point').value = String(automationIndex)
    const point = points[automationIndex], endpoint = automationIndex === 0 || automationIndex === points.length - 1
    el('automation-time').value = point ? String(point.timeSeconds) : ''
    el('automation-time').max = String(item?.clip.durationSeconds || 0)
    el('automation-time').readOnly = endpoint
    el('automation-value').value = point ? String(point.value * 100) : ''
    button('automation-remove').disabled = !item || endpoint
    button('automation-reset').disabled = !item?.clip.volumeAutomation
    button('automation-add').disabled = !item || points.length >= DAW_LIMITS.maxAutomationPoints
    el('automation-summary').textContent = item ? `${item.clip.volumeAutomation ? '已套用' : '尚無變化，整句 100%'} · ${points.length}/${DAW_LIMITS.maxAutomationPoints} 點 · 0–${Number(item.clip.durationSeconds.toFixed(4))} 秒` : '尚未選取片段'
    graph.setAttribute('aria-label', item ? `片段音量曲線，${points.length} 點，範圍 0 至 200%，可用下方數字編輯` : '尚未選取片段的音量曲線')
  }
  function addAutomationPoint() {
    const item = selected(); if (!item) return
    const points = getClipVolumeAutomation(item.clip)
    let widest = 1
    for (let index = 2; index < points.length; index++) {
      if (points[index].timeSeconds - points[index - 1].timeSeconds > points[widest].timeSeconds - points[widest - 1].timeSeconds) widest = index
    }
    const timeSeconds = (points[widest - 1].timeSeconds + points[widest].timeSeconds) / 2
    clipCommand('clip.automation.add', { point: { timeSeconds, value: envelopeValueAt(points, timeSeconds) } }, '已新增音量點；調整數字後按「套用音量點」')
    automationIndex = widest; renderAutomation(); el('automation-value').focus({ preventScroll: true })
  }
  function applyAutomationPoint() {
    if (!el('automation-time').value || !el('automation-value').value) throw new Error('請填入音量點的時間與音量；原設定仍保留')
    clipCommand('clip.automation.update', { index: automationIndex, patch: { timeSeconds: Number(el('automation-time').value), value: Number(el('automation-value').value) / 100 } }, '已套用句內音量；試聽與匯出都會使用這條曲線')
  }
  function waveform(clip) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 160 50'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'daw-wave'); svg.setAttribute('aria-hidden', 'true')
    const buffer = buffers.get(clip.assetId)
    if (!buffer) return svg
    const channel = buffer.getChannelData(0), points = 160
    const begin = Math.floor(clip.offsetSeconds * buffer.sampleRate), count = Math.max(1, Math.floor(clip.durationSeconds * buffer.sampleRate))
    let path = ''
    for (let i = 0; i < points; i++) {
      const a = begin + Math.floor(i * count / points), b = Math.min(channel.length, begin + Math.max(Math.floor((i + 1) * count / points), 1))
      let peak = 0
      // A display envelope only; bound work independently of imported duration.
      const stride = Math.max(1, Math.floor((b - a) / 80))
      for (let j = a; j < b; j += stride) peak = Math.max(peak, Math.abs(channel[j]))
      const height = Math.max(.7, Math.min(24, peak * 24))
      path += `M${i},${25 - height}v${height * 2}h.8v${-height * 2}Z`
    }
    const shape = document.createElementNS(svg.namespaceURI, 'path'); shape.setAttribute('d', path); svg.append(shape)
    return svg
  }
  function trackButton(track, action, label, pressed) {
    const control = node('button', '', label); control.type = 'button'; control.dataset.trackId = track.id; control.dataset.trackControl = action
    control.setAttribute('aria-label', `${track.name}：${label}`)
    if (pressed !== undefined) control.setAttribute('aria-pressed', String(pressed))
    return control
  }
  function renderTracks() {
    const focused = document.activeElement
    const focusKey = focused?.dataset.clipId || null
    const focusTrack = focused?.dataset.trackControl ? { id: focused.dataset.trackId, control: focused.dataset.trackControl } : null
    const rate = Number(el('zoom').value), seconds = Math.min(600, Math.max(20, Math.ceil((duration() + 5) / 5) * 5))
    const timeline = el('timeline'); timeline.style.setProperty('--daw-lane-width', `${seconds * rate}px`); timeline.style.setProperty('--daw-beat-width', `${gridStep() * rate}px`)
    const rulerLabel = node('span', 'daw-ruler-label', '音軌混音 · 點刻度定位')
    const rulerLane = node('div', 'daw-ruler-lane'); rulerLane.dataset.seekLane = 'true'
    const tickSize = seconds > 120 ? 10 : 5
    for (let sec = 0; sec <= seconds; sec += tickSize) { const tick = node('span', 'daw-tick', formatDawTime(sec).slice(0, 5)); tick.style.left = `${sec * rate}px`; rulerLane.append(tick) }
    rulerLane.append(node('i', 'daw-playhead')); el('ruler').replaceChildren(rulerLabel, rulerLane)
    const rows = project.tracks.map(track => {
      const row = node('div', 'daw-track'); row.dataset.trackId = track.id
      const controls = node('div', 'daw-track-controls'); controls.append(node('p', 'daw-track-name', track.name))
      const actions = node('div', 'daw-actions')
      actions.append(trackButton(track, 'mute', '靜音', track.mute), trackButton(track, 'solo', '獨聽', track.solo), trackButton(track, 'remove', '刪軌'))
      controls.append(actions)
      const sliders = node('div', 'daw-track-mix')
      for (const [key, label, min, max, step] of [['gainDb', '音量 dB', -60, 12, .5], ['pan', '左 −1／右 1', -1, 1, .05]]) {
        const wrap = node('label', '', label), input = node('input'); input.type = 'number'; input.min = min; input.max = max; input.step = step; input.value = track[key]
        input.dataset.trackId = track.id; input.dataset.trackControl = key; input.setAttribute('aria-label', `${track.name}：${label}`); wrap.append(input); sliders.append(wrap)
      }
      controls.append(sliders)
      const lane = node('div', 'daw-lane'); lane.dataset.seekLane = 'true'; lane.dataset.trackId = track.id
      const layerEnds = [], layers = new Map()
      for (const clip of [...track.clips].sort((a, b) => a.atSeconds - b.atSeconds)) {
        let layer = layerEnds.findIndex(end => end <= clip.atSeconds)
        if (layer < 0) layer = layerEnds.length
        layerEnds[layer] = clip.atSeconds + clip.durationSeconds; layers.set(clip.id, layer)
      }
      lane.style.minHeight = `${Math.max(142, layerEnds.length * 104 + 30)}px`
      for (const clip of track.clips) {
        const control = node('button', 'daw-clip'); control.type = 'button'; control.dataset.clipId = clip.id; control.dataset.trackId = track.id
        control.style.top = `${20 + layers.get(clip.id) * 104}px`; control.style.left = `${clip.atSeconds * rate}px`; control.style.width = `${Math.max(12, clip.durationSeconds * rate)}px`
        control.setAttribute('aria-label', `${track.name}，${clip.name}，${formatDawTime(clip.atSeconds)} 至 ${formatDawTime(clip.atSeconds + clip.durationSeconds)}。左右方向鍵移動`)
        control.setAttribute('aria-pressed', String(selection?.clipId === clip.id)); control.append(node('span', 'daw-clip-name', clip.name), waveform(clip)); lane.append(control)
      }
      lane.append(node('i', 'daw-playhead')); row.append(controls, lane); return row
    })
    el('tracks').replaceChildren(...rows); el('empty').hidden = project.tracks.length > 0
    if (focusKey) ([...root.querySelectorAll('.daw-clip')].find(item => item.dataset.clipId === focusKey) || el('timeline')).focus({ preventScroll: true })
    if (focusTrack) ([...root.querySelectorAll('[data-track-control]')].find(item => item.dataset.trackId === focusTrack.id && item.dataset.trackControl === focusTrack.control) || button('add-track')).focus({ preventScroll: true })
  }
  function render() {
    el('name').value = project.name; el('tempo').value = String(project.tempo); el('sample-rate').value = String(project.sampleRate); el('master-gain').value = String(project.masterGainDb)
    el('summary').textContent = `${project.tracks.length} 軌 · ${project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} 片段 · ${formatDawTime(duration())}`
    el('seek').max = String(duration()); el('seek').disabled = !duration()
    if (!mix) el('render-info').textContent = '尚未產生目前版本的混音；採樣峰值或估計 True Peak 超過 0 dBFS 會停止 WAV 輸出，請先降低總混音音量'
    renderTracks(); renderInspector(); paintPlayhead()
  }
  async function withJob(kind, work) {
    if (job) throw new Error('另一項工作正在進行；請等待或先取消')
    const current = { kind, controller: new AbortController(), generation: ++generation }
    job = current; refreshControls()
    const isCurrent = () => !destroyed && !current.controller.signal.aborted && current.generation === generation
    const check = () => { if (!isCurrent()) throw abortError() }
    try { const result = await work({ signal: current.controller.signal, isCurrent, check }); check(); return result }
    finally { if (job === current) { job = null; refreshControls() } }
  }
  async function decode(bytes, metadata, signal) {
    let timer, aborted
    const cancelled = new Promise((_, reject) => { aborted = () => reject(abortError()); signal.addEventListener('abort', aborted, { once: true }) })
    try {
      const result = await Promise.race([
        (decodeAsset || decodeDawAsset)(bytes, metadata, { signal }), cancelled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('音檔解碼逾時；原專案仍保留')), 30000) }),
      ])
      return result?.buffer?.getChannelData ? result.buffer : result
    } finally { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
  }
  async function importFiles(inputFiles) {
    const list = [...inputFiles]
    if (!list.length) return
    return withJob('import', async ({ signal, check }) => {
      if (project.tracks.length + list.length > DAW_LIMITS.maxTracks) throw new Error('最多 16 軌；請先刪除不需要的音軌')
      for (const file of list) if (!file.size || file.size > FILE_LIMIT) throw new Error(`${file.name}：原檔須介於 1 byte 與 64 MiB 之間`)
      let next = project, nextSelection = selection
      const nextBuffers = new Map(buffers), nextFiles = new Map(files)
      const inputBytes = list.reduce((sum, file) => sum + file.size, 0)
      if (inputBytes + retainedBytes() > DAW_LIMITS.maxCombinedBytes) throw new Error('匯入會超出記憶體預算；請先下載並清理舊專案')
      for (let i = 0; i < list.length; i++) {
        const file = list[i]; status(`正在解碼 ${i + 1}/${list.length}：${file.name}`)
        const bytes = await file.arrayBuffer(); check()
        const hash = await sha256Hex(bytes); check()
        const buffer = await decode(bytes, { name: file.name }, signal); check()
        const originalBytes = [...nextFiles.values()].reduce((sum, value) => sum + value.size, 0) + file.size
        if (decodedBytes(nextBuffers) + buffer.length * buffer.numberOfChannels * 4 + originalBytes + file.size * 2 + cachedMixBytes() + metadataBytes() > DAW_LIMITS.maxCombinedBytes) throw new Error('音檔解碼後超出記憶體預算；原專案仍保留')
        const registered = registerAudioBuffer(next, nextBuffers, buffer, { name: file.name, hash })
        next = registered.project; nextFiles.set(registered.asset.id, file)
        const trackId = generateId('track'), clipId = generateId('clip')
        next = applyCommand(next, { type: 'track.add', track: { id: trackId, name: file.name } })
        next = applyCommand(next, { type: 'clip.add', trackId, clip: { id: clipId, assetId: registered.asset.id, name: file.name } })
        if (i === list.length - 1) nextSelection = { trackId, clipId }
      }
      check(); history.push(next); invalidate(); project = next; selection = nextSelection; buffers = nextBuffers; files = nextFiles
      retainHistoryAssets(); cursor = 0; render(); status(`已匯入 ${list.length} 個音檔，各自從 0 秒開始。可復原整批匯入`)
    })
  }
  const cachedMixBytes = () => mix ? mix.buffer.length * mix.buffer.numberOfChannels * 4 : 0
  const metadataBytes = () => history.bytes * 2 + JSON.stringify(project).length * 2
  const retainedBytes = () => decodedBytes(buffers) + [...files.values()].reduce((sum, file) => sum + file.size, 0) + cachedMixBytes() + metadataBytes()
  async function openArchive(file) {
    if (!file) return
    if ((dirty() || project.assets.length) && !await confirmAction('開啟工程會取代此多軌專案與復原紀錄。尚未下載的修改將遺失；要繼續嗎？')) return
    return withJob('open', async ({ signal, check }) => {
      status('正在檢查工程與原始音檔…')
      const restored = await importProjectArchive(file, { signal, decodeAsset: (bytes, metadata, options) => decode(bytes, metadata, options.signal), retainedBytes: retainedBytes(), onProgress: value => { check(); status(`正在還原工程：${value.phase} ${value.completed}/${value.total}`) } })
      check(); const nextHistory = new ProjectHistory(restored.project)
      invalidate(); project = restored.project; files = restored.files; buffers = restored.buffers; history = nextHistory
      saved = JSON.stringify(project); hasDownloaded = false; selection = null; cursor = 0
      render(); status('工程已還原，音檔、剪輯與混音設定可繼續修改')
    })
  }
  async function getMix({ signal, check }) {
    if (mix) return mix
    const snapshot = project
    const renderBytes = Math.ceil(duration() * project.sampleRate) * 2 * 4
    if (retainedBytes() + renderBytes > DAW_LIMITS.maxCombinedBytes) throw new Error('原檔、復原音訊與混音合計超出記憶體預算；請縮短時間軸或降低混音取樣率')
    status('正在合成目前專案混音…')
    const result = await renderProject(snapshot, buffers, { signal, isCurrent: () => !destroyed && project === snapshot })
    check(); if (project !== snapshot) throw abortError()
    mix = result
    const db = value => Number.isFinite(value) ? `${value.toFixed(2)} dBFS` : '−∞ dBFS'
    el('render-info').textContent = `第 ${result.revision} 版 · ${project.sampleRate / 1000} kHz · 採樣峰值 ${db(result.peaks?.samplePeakDb ?? 20 * Math.log10(result.peak))} · 估計 True Peak（4×）${db(result.peaks?.truePeakDb)}。${result.peak > 1 || result.peaks?.truePeakDb > 0 ? '有過載，請降低總混音音量後重試' : 'WAV 輸出不會自動增減音量'}`
    return result
  }
  async function play() {
    if (source) { stop(); return }
    if (!duration() || root.hidden) return
    await withJob('render', async request => {
      await beforePlayback?.(); request.check()
      const ctx = getContext(); await ctx.resume(); request.check()
      const result = await getMix(request); request.check()
      const item = selected(), looping = el('loop').checked
      if (looping && !item) throw new Error('循環試聽前請先選取片段')
      const start = looping ? item.clip.atSeconds : cursor >= duration() ? 0 : cursor
      const end = looping ? item.clip.atSeconds + item.clip.durationSeconds : duration()
      source = ctx.createBufferSource(); source.buffer = result.buffer; source.connect(ctx.destination)
      playback = { start, end, loop: looping, started: ctx.currentTime }; cursor = start
      if (looping) { source.loop = true; source.loopStart = start; source.loopEnd = end }
      const activeSource = source
      source.onended = () => { if (source === activeSource) { cursor = end; source.disconnect(); source = null; playback = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; button('play').textContent = '播放混音'; refreshControls(); paintPlayhead() } }
      if (looping) source.start(0, start); else source.start(0, start, end - start)
      button('play').textContent = '暫停'; status(looping ? '正在循環所選片段的完整混音' : '正在播放目前專案混音'); paintPlayhead()
    })
  }
  async function exportMix(toMaster = false) {
    const transferred = await withJob(toMaster ? 'transfer' : 'render', async request => {
      const result = await getMix(request); request.check()
      const bitDepth = toMaster ? 24 : Number(el('bit-depth').value)
      const encodedBytes = result.buffer.length * result.buffer.numberOfChannels * bitDepth / 8 + 44
      if (retainedBytes() + encodedBytes > DAW_LIMITS.maxCombinedBytes) throw new Error('WAV 編碼會超出編輯器的保守記憶體預算；請縮短時間軸或降低混音取樣率')
      if (toMaster) {
        const accepted = await onSendToMaster(result.buffer, { name: project.name, revision: project.revision, signal: request.signal, isCurrent: request.isCurrent })
        request.check()
        if (accepted !== true) throw new Error('母帶頁尚未確認載入成功；多軌工程仍保留')
        status('已將完整混音送往母帶處理')
        return true
      }
      else {
        if (result.peak > 1 || result.peaks?.samplePeakDb > 0 || result.peaks?.truePeakDb > 0) throw new Error('混音採樣峰值或估計 True Peak 超過 0 dBFS，已停止 WAV 輸出。請降低「總混音音量」後重新試聽／匯出')
        const channels = Array.from({ length: result.buffer.numberOfChannels }, (_, index) => result.buffer.getChannelData(index))
        const wav = encodeWAV(channels, result.buffer.sampleRate, Number(el('bit-depth').value))
        downloadFile(new Blob([wav], { type: 'audio/wav' }), `${project.name.replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'mix'}-mix.wav`)
        status(`已交付下載：完整立體聲混音 WAV · ${result.buffer.sampleRate / 1000} kHz · ${el('bit-depth').value}-bit；工程仍留在本頁`)
      }
    })
    // Retire ownership before our successful navigation; user navigation while
    // the callback is pending cancels the transfer and cannot be overridden.
    if (transferred) document.querySelector('.mode-tab[data-mode="master"]')?.click()
  }
  async function saveArchive() {
    await withJob('save', async request => {
      const snapshot = project, snapshotJson = JSON.stringify(snapshot)
      const sourceSizes = snapshot.assets.map(asset => files.get(asset.id)?.size || 0)
      const archiveEstimate = sourceSizes.reduce((sum, size) => sum + size, 0) + 1024 * 1024
      if (retainedBytes() + archiveEstimate + 2 * Math.max(0, ...sourceSizes) > DAW_LIMITS.maxCombinedBytes) throw new Error('工程打包加上原檔、復原紀錄與快取混音會超出保守記憶體預算；請先停止試聽並降低素材用量')
      status('正在打包工程；包括每份原始音檔與編輯設定…')
      const blob = await exportProjectArchive(snapshot, files, { signal: request.signal }); request.check()
      downloadFile(blob, archiveFileName(snapshot)); saved = snapshotJson; hasDownloaded = true
      status(project === snapshot ? '工程已交付下載，請確認檔案已存好。分享 ZIP 也會分享其中完整原始音檔' : '已下載開始打包時的版本；後續修改尚未保存，請再下載一次')
    })
  }
  function clear() {
    cancelJob(); stop({ rewind: true }); generation++
    project = createProject({ name: '未命名專案' }); history = new ProjectHistory(project)
    buffers.clear(); files.clear(); mix = null; selection = null; saved = JSON.stringify(project); hasDownloaded = false
    el('audio-files').value = ''; el('project-file').value = ''; render(); status('已清除此多軌專案與復原紀錄。裝置上的原檔與下載檔仍保留')
  }
  function choose(trackId, clipId) {
    automationDrag = null
    selection = { trackId, clipId }; const item = selected(); if (!item) { selection = null; return }
    stop(); cursor = item.clip.atSeconds; renderInspector(); paintPlayhead()
  }
  function nudge(direction) {
    const item = selected(); if (!item) return
    const step = el('snap').checked ? gridStep() : .01
    clipCommand('clip.move', { atSeconds: Math.max(0, item.clip.atSeconds + direction * step) }, direction < 0 ? '已把片段提早' : '已把片段延後')
  }
  const actions = {
    import: () => el('audio-files').click(), open: () => el('project-file').click(), save: saveArchive,
    clear: async () => { if (await confirmAction('清除此多軌專案、音訊與全部復原紀錄？尚未下載的修改會遺失。裝置原檔、下載檔、母帶與歌詞不會刪除。')) clear() },
    cancel: () => cancelJob(), undo: () => changeHistory('undo'), redo: () => changeHistory('redo'),
    'add-track': () => command({ type: 'track.add', track: { name: `音軌 ${project.tracks.length + 1}` } }, '已新增空白音軌'),
    earlier: () => nudge(-1), later: () => nudge(1),
    'automation-add': addAutomationPoint, 'automation-apply': applyAutomationPoint,
    'automation-remove': () => clipCommand('clip.automation.remove', { index: automationIndex }, '已刪除中間音量點；相鄰點會平滑連接'),
    'automation-reset': () => clipCommand('clip.automation.reset', {}, '已重設句內音量為 100%；片段音量與淡入淡出仍保留'),
    move: () => { const clipId = selection?.clipId, toTrackId = el('clip-track').value; clipCommand('clip.move', { atSeconds: snap(Number(el('clip-at').value)), toTrackId }, '已套用片段位置'); selection = { trackId: toTrackId, clipId }; renderInspector() },
    trim: () => clipCommand('clip.trim', { startSeconds: Number(el('trim-start').value), endSeconds: Number(el('trim-end').value) }, '已裁切片段，原檔仍保留'),
    split: () => clipCommand('clip.split', { atSeconds: currentTime() }, '已在播放位置切開片段'),
    duplicate: () => clipCommand('clip.duplicate', {}, '已複製到片段後方'),
    delete: () => clipCommand('clip.remove', {}, '已刪除片段；可按復原找回'),
    fades: () => clipCommand('clip.update', { patch: { fadeInSeconds: Number(el('fade-in').value), fadeOutSeconds: Number(el('fade-out').value) } }, '已套用淡入淡出'),
    play, stop: () => { cancelJob('已停止目前工作'); stop({ rewind: true }); refreshControls() }, begin: () => { stop({ rewind: true }); refreshControls() },
    export: () => exportMix(), master: () => exportMix(true),
  }
  listen(root, 'click', event => {
    const action = event.target.closest('[data-daw]')
    if (action && !action.disabled) { run(() => actions[action.dataset.daw]?.()); return }
    const trackControl = event.target.closest('button[data-track-control]')
    if (trackControl && !trackControl.disabled) {
      run(() => { const track = project.tracks.find(t => t.id === trackControl.dataset.trackId); const key = trackControl.dataset.trackControl
        if (key === 'remove') command({ type: 'track.remove', trackId: track.id }, '已刪除音軌；可按復原找回')
        else command({ type: 'track.update', trackId: track.id, patch: { [key]: !track[key] } }, `${track.name}：已${track[key] ? '取消' : '啟用'}${key === 'mute' ? '靜音' : '獨聽'}`)
      }); return
    }
    const clip = event.target.closest('.daw-clip')
    if (clip) { if (!suppressClick) choose(clip.dataset.trackId, clip.dataset.clipId); suppressClick = false; return }
    const lane = event.target.closest('[data-seek-lane]')
    if (lane) { stop(); cursor = clamp((event.clientX - lane.getBoundingClientRect().left) / Number(el('zoom').value), 0, duration()); paintPlayhead(); refreshControls() }
  })
  listen(root, 'change', event => run(async () => {
    const target = event.target, id = target.id
    if (id === 'daw-audio-files') { try { await importFiles(target.files) } finally { target.value = '' } }
    else if (id === 'daw-project-file') { try { await openArchive(target.files?.[0]) } finally { target.value = '' } }
    else if (id === 'daw-name') command({ type: 'project.update', patch: { name: target.value.trim() } }, '已更新專案名稱')
    else if (id === 'daw-tempo') command({ type: 'project.update', patch: { tempo: Number(target.value) } }, '已更新拍格；錄音速度與音高不變')
    else if (id === 'daw-sample-rate') command({ type: 'project.update', patch: { sampleRate: Number(target.value) } }, '混音取樣率已更新，請重新產生混音')
    else if (id === 'daw-master-gain') command({ type: 'project.update', patch: { masterGainDb: Number(target.value) } }, '總混音音量已更新，試聽與輸出都會套用')
    else if (id === 'daw-clip-name') clipCommand('clip.update', { patch: { name: target.value.trim() } }, '已更新片段名稱')
    else if (id === 'daw-automation-point') { automationDrag = null; automationIndex = Number(target.value); renderAutomation() }
    else if (id === 'daw-clip-gain') clipCommand('clip.update', { patch: { gainDb: Number(target.value) } }, '已更新片段音量')
    else if (['daw-zoom', 'daw-grid', 'daw-snap'].includes(id)) { renderTracks(); paintPlayhead() }
    else if (id === 'daw-loop') { stop(); refreshControls() }
    else if (target.matches('input[data-track-control]')) command({ type: 'track.update', trackId: target.dataset.trackId, patch: { [target.dataset.trackControl]: Number(target.value) } }, '已更新音軌混音設定')
  }))
  listen(el('seek'), 'input', () => { const next = Number(el('seek').value); stop(); cursor = next; paintPlayhead(); refreshControls() })
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && automationDrag) { automationDrag = null; renderAutomation(); return }
    if (event.defaultPrevented || event.isComposing || event.target.matches('input,textarea,select,[contenteditable=true]')) return
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); changeHistory(event.shiftKey ? 'redo' : 'undo') }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); changeHistory('redo') }
    else if (event.code === 'Space' && !event.target.closest('button')) { event.preventDefault(); run(play) }
    else if (event.target.closest('.daw-clip') && ['ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); run(() => event.key.startsWith('Arrow') ? nudge(event.key === 'ArrowLeft' ? -1 : 1) : actions.delete()) }
  })
  listen(root, 'focusin', event => {
    const clip = event.target.closest('.daw-clip')
    if (clip && clip.dataset.clipId !== selection?.clipId) choose(clip.dataset.trackId, clip.dataset.clipId)
  })
  listen(root, 'pointerdown', event => {
    const point = event.target.closest('[data-automation-index]')
    if (point) {
      if ((event.button !== undefined && event.button !== 0) || job && ['import', 'open'].includes(job.kind)) return
      const item = selected(); if (!item) return
      event.preventDefault(); automationIndex = Number(point.dataset.automationIndex)
      automationDrag = { revision: project.revision, trackId: item.track.id, clipId: item.clip.id, index: automationIndex, pointerId: event.pointerId, points: getClipVolumeAutomation(item.clip), changed: false }
      el('automation-graph').setPointerCapture?.(event.pointerId)
      renderAutomation(); return
    }
    const clip = event.target.closest('.daw-clip')
    if (!clip || (event.button !== undefined && event.button !== 0) || job && ['import', 'open'].includes(job.kind)) return
    choose(clip.dataset.trackId, clip.dataset.clipId)
    drag = { trackId: clip.dataset.trackId, clipId: clip.dataset.clipId, x: event.clientX, at: selected().clip.atSeconds, moved: false }
  })
  listen(window, 'pointermove', event => {
    if (automationDrag) {
      if (automationDrag.pointerId !== event.pointerId) return
      const item = selected(), box = el('automation-graph').getBoundingClientRect()
      if (!item || !box.width || !box.height || project.revision !== automationDrag.revision) { automationDrag = null; renderAutomation(); return }
      const points = automationDrag.points, index = automationDrag.index
      let timeSeconds = points[index].timeSeconds
      if (index > 0 && index < points.length - 1) {
        const spacing = Math.min(1 / project.assets.find(asset => asset.id === item.clip.assetId).sampleRate, (points[index + 1].timeSeconds - points[index - 1].timeSeconds) / 4)
        timeSeconds = clamp(((event.clientX - box.left) / box.width * 320 - 16) / 288 * item.clip.durationSeconds, points[index - 1].timeSeconds + spacing, points[index + 1].timeSeconds - spacing)
      }
      points[index] = { timeSeconds, value: clamp((124 - (event.clientY - box.top) / box.height * 140) / 54, 0, DAW_LIMITS.maxAutomationGain) }
      automationDrag.changed = true; renderAutomation(points); return
    }
    if (!drag || Math.abs(event.clientX - drag.x) < 4 && !drag.moved) return
    drag.moved = true
    const clip = [...root.querySelectorAll('.daw-clip')].find(c => c.dataset.clipId === drag.clipId)
    if (clip) clip.style.left = `${snap(drag.at + (event.clientX - drag.x) / Number(el('zoom').value)) * Number(el('zoom').value)}px`
  })
  listen(window, 'pointerup', event => {
    if (automationDrag) {
      if (automationDrag.pointerId !== event.pointerId) return
      const previous = automationDrag; automationDrag = null
      if (previous.changed && previous.revision === project.revision && previous.clipId === selected()?.clip.id) {
        run(() => {
          if (previous.revision !== project.revision || previous.clipId !== selected()?.clip.id) { renderAutomation(); return }
          command({ type: 'clip.automation.update', trackId: previous.trackId, clipId: previous.clipId, index: previous.index, patch: previous.points[previous.index] }, '已調整句內音量；這次拖曳可一次復原')
        })
      } else renderAutomation()
      return
    }
    if (!drag) return
    const previous = drag; drag = null
    if (!previous.moved) return
    suppressClick = true; setTimeout(() => { suppressClick = false }, 0)
    run(() => { const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest('.daw-lane')
      command({ type: 'clip.move', trackId: previous.trackId, clipId: previous.clipId, toTrackId: target?.dataset.trackId || previous.trackId, atSeconds: snap(previous.at + (event.clientX - previous.x) / Number(el('zoom').value)) }, '已移動片段；這次拖曳可一次復原')
      selection = { trackId: target?.dataset.trackId || previous.trackId, clipId: previous.clipId }; renderInspector()
    }).finally(() => { renderTracks(); paintPlayhead() })
  })
  listen(window, 'pointercancel', () => { drag = null; automationDrag = null; renderAutomation(); renderTracks(); paintPlayhead() })
  listen(el('timeline'), 'dragover', event => { event.preventDefault(); el('timeline').dataset.drop = 'true' })
  listen(el('timeline'), 'dragleave', () => { el('timeline').dataset.drop = 'false' })
  listen(el('timeline'), 'drop', event => { event.preventDefault(); el('timeline').dataset.drop = 'false'; run(() => importFiles(event.dataTransfer?.files || [])) })
  listen(document, 'wf:mode-change', event => { if (event.detail?.mode !== 'editor') { automationDrag = null; renderAutomation(); stop(); if (job && ['render', 'transfer'].includes(job.kind)) cancelJob('已切換工作區；可回來繼續編輯') } })
  listen(window, 'beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = '' } })
  function destroy() {
    if (destroyed) return
    destroyed = true; cancelJob(); stop(); disposers.forEach(dispose => dispose()); buffers.clear(); files.clear(); mix = null
    if (context) { context.close().catch(() => {}); context = null }
  }
  listen(window, 'pagehide', event => { if (event.persisted) { cancelJob(); stop() } else destroy() })
  render()
  return { clear, stop, destroy, importFiles, openArchive, getProject: () => JSON.parse(JSON.stringify(project)) }
}
