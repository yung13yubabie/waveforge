import { createProject, applyCommand, registerAudioBuffer, getProjectDuration, generateId, DAW_LIMITS, getClipVolumeAutomation, envelopeValueAt, getClipOriginalSource, CLIP_TRANSPOSE_ENGINE } from './project.js'
import { renderProject, getPendingNativeRenderBytes } from './render.js'
import { createSignalsmithPitchClient } from '../pitch/signalsmith-client.js'
import { planClipTranspose, renderClipTranspose } from './transpose.js'
import { ProjectHistory } from './history.js'
import { exportProjectArchive, importProjectArchive, archiveFileName, ARCHIVE_LIMITS } from './archive.js'
import { sha256Hex } from '../audio/sha256.js'
import { encodeWAV } from '../audio/wav.js'
import { decodeDawAsset } from './decode.js'
import { wavSampleRate } from '../audio/asset-decode.js'
import { planLyricRegion } from './lyric-region-planner.js'
import { planTimelineGainRegion, stageGainRegionDraft } from './gain-region-draft.js'
import { selectedRenderView } from './selection.js'
import { createTimelineSelectionControls } from './selection-controls.js'
import { createPitchAnalysisClient } from '../pitch/analysis-client.js'
import { midiToNote, midiToFrequency } from '../pitch/analysis.js'
import { planNoteCentering, combineNoteCenteringPlans, NOTE_CENTERING_LIMITS } from './note-centering.js'
import { getDawGridOrigin, snapDawGridTime, nextDawGridTime } from './grid.js'
import { createTempoControls } from './tempo-controls.js'
import { createMultiClipSelection, createClipSelectionHistory } from './multi-clip-selection.js'
import { createClipGroupControls } from './clip-group-controls.js'
import { describeClipGroup, planClipGroupDuplicate } from './clip-groups.js'

const FILE_LIMIT = 64 * 1024 * 1024
const abortError = () => new DOMException('已取消', 'AbortError')
const clamp = (n, min, max) => Math.min(max, Math.max(min, n))
export function formatDawTime(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
}
export function snapDawTime(seconds, tempo, beats = 1, enabled = true, originSeconds = 0, maxSeconds = 600) {
  return snapDawGridTime(seconds, tempo, beats, enabled, originSeconds, maxSeconds)
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
export function initDawPanel({ decodeAsset, onSendToMaster, beforePlayback, getLyricSelection, subscribeLyricSelection,
  confirmAction = message => window.confirm(message), downloadFile = download,
  AudioContextClass = globalThis.AudioContext, pitchClientFactory = createSignalsmithPitchClient,
  noteAnalysisClientFactory = createPitchAnalysisClient } = {}) {
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
  const clipSelection = createMultiClipSelection(), selectionHistory = createClipSelectionHistory()
  let buffers = new Map(), files = new Map()
  let saved = JSON.stringify(project), hasDownloaded = false, hasProjectDocument = false
  let selection = null, cursor = 0, mix = null, selectionMix = null, selectionControls = null, tempoControls = null, groupControls = null, job = null, generation = 0
  let replacement = null, replacementOwner = null, selectionVersion = 0, replacementReadBusy = false, pendingReplacementBytes = 0
  let pitchClient = null, transposeBusy = false, transposeVersion = 0, transposeControlOwner = null, pendingAudition = null
  let noteAnalyses = null, noteOwner = null, noteProposal = null, noteControlOwner = null, noteAnalysisClient = null, noteAnalysisBytes = 0, noteReference = null
  const operationLeases = new Set()
  let vocalTrackId = null, regionId = '', regionControlOwner = null, regionVersion = 0, lyricDraft = null, observedLyricKey = null
  let loadWorkPending = false, pendingLoadBytes = 0
  let context = null, source = null, frame = null, playback = null, destroyed = false
  let drag = null, suppressClick = false, automationDrag = null, automationIndex = 0, automationClipId = null
  const getContext = () => context ||= new AudioContextClass()
  const dirty = () => saved !== JSON.stringify(project)
  const selected = () => {
    if (clipSelection.refs.length > 1) return null
    const track = project.tracks.find(item => item.id === selection?.trackId)
    const clip = track?.clips.find(item => item.id === selection?.clipId)
    return clip ? { track, clip } : null
  }
  const duration = () => getProjectDuration(project)
  const gridStep = () => 60 / project.tempo * Number(el('grid').value)
  const snap = seconds => snapDawTime(seconds, project.tempo, Number(el('grid').value), el('snap').checked, getDawGridOrigin(project))
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
  const isSelected = (trackId, clipId) => clipSelection.refs.some(ref => ref.trackId === trackId && ref.clipId === clipId)
  const gridKey = () => JSON.stringify([project.tempo, getDawGridOrigin(project), el('grid').value, el('snap').checked, el('zoom').value])
  function rememberSelection() {
    selectionHistory.set(history.currentKey, clipSelection.snapshot())
    selectionHistory.prune(history.retainedKeys)
  }
  function syncSelection() { clipSelection.reconcile(project); selection = clipSelection.primary; rememberSelection() }
  function selectionChanged() {
    const hadDragPreview = Boolean(drag?.moved)
    // Move focus before the controls' cancel/render hides their subtree.
    if (clipSelection.refs.length < 2 && el('group-tools').contains(document.activeElement)) el('timeline').focus({ preventScroll: true })
    selectionVersion++; discardReplacement('已變更所選片段，待接受的試聽已取消')
    automationDrag = null; drag = null; groupControls?.cancel()
    selection = clipSelection.primary; rememberSelection(); stop()
    if (hadDragPreview) renderTracks()
    renderInspector(); paintPlayhead()
  }
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
    stopNoteReference()
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
    selectionControls?.cancel()
    if (!job) return
    const kind = job.kind
    job.controller.abort(); generation++; job = null
    if (kind === 'note-analysis') { noteAnalysisClient?.dispose(); noteAnalysisClient = null }
    if (['replacement', 'transpose', 'audition'].includes(kind)) { replacement = null; replacementOwner = null; stop(); renderReplacement() }
    status(message); refreshControls()
  }
  function invalidate() {
    discardReplacement()
    resetNoteCentering()
    automationDrag = null
    drag = null; groupControls?.cancel()
    stop()
    mix = null; selectionMix = null; selectionControls?.cancel()
    if (job && ['render', 'transfer', 'note-analysis', 'note-reference'].includes(job.kind)) cancelJob('設定已修改，請重新產生混音或分析')
  }
  function retainHistoryAssets() {
    const ids = history.retainedAssetIds()
    for (const id of buffers.keys()) if (!ids.has(id)) buffers.delete(id)
    for (const id of files.keys()) if (!ids.has(id)) files.delete(id)
  }
  function commit(next, label, nextSelection) {
    const rangeCleared = Boolean(project.timelineSelection && !next.timelineSelection && getProjectDuration(next) < project.timelineSelection.endSeconds)
    rememberSelection()
    history.push(next) // Validate before replacing state or invalidating playback.
    invalidate(); project = next
    retainHistoryAssets()
    if (nextSelection) clipSelection.restore(nextSelection)
    syncSelection()
    cursor = clamp(cursor, 0, duration())
    render(); status(label + (rangeCleared ? '；原選區已超出工程，已清除，可復原找回' : ''))
  }
  function command(value, label, nextSelection) {
    if (job && ['import', 'open'].includes(job.kind)) throw new Error('請等待匯入完成，或先取消目前工作')
    commit(applyCommand(project, value), label, nextSelection)
  }
  function clipCommand(type, extra, label) {
    const item = selected()
    if (!item) throw new Error('請先選取一個片段')
    command({ type, trackId: item.track.id, clipId: item.clip.id, ...extra }, label)
  }
  function changeHistory(direction) {
    if (job && ['import', 'open'].includes(job.kind)) return
    rememberSelection()
    const next = history[direction]()
    if (!next) return
    invalidate(); project = next
    const previousSelection = selectionHistory.get(history.currentKey)
    if (previousSelection) clipSelection.restore(previousSelection)
    syncSelection()
    cursor = clamp(cursor, 0, duration()); render(); status(direction === 'undo' ? '已復原上一步' : '已重做')
  }
  function refreshControls() {
    if (destroyed) return
    const locked = job && ['import', 'open'].includes(job.kind)
    const hasClips = duration() > 0
    button('undo').disabled = Boolean(locked || !history.canUndo)
    button('redo').disabled = Boolean(locked || !history.canRedo)
    for (const key of ['import', 'open', 'save', 'export', 'master']) button(key).disabled = Boolean(job || (key === 'save' && !project.tracks.length && !dirty() && !hasProjectDocument) || (['export', 'master'].includes(key) && !hasClips) || (key === 'master' && !onSendToMaster))
    button('play').disabled = Boolean(job || !hasClips)
    button('stop').disabled = !source && !noteReference && !job && cursor === 0
    button('cancel').hidden = !job
    button('add-track').disabled = Boolean(locked || project.tracks.length >= DAW_LIMITS.maxTracks)
    button('multi-select').disabled = Boolean(job || !project.tracks.some(track => track.clips.length))
    button('multi-select').setAttribute('aria-pressed', String(clipSelection.mode))
    el('clip-fields').disabled = Boolean(locked || !selected())
    for (const key of ['name', 'tempo', 'sample-rate', 'master-gain']) el(key).disabled = Boolean(locked)
    root.querySelectorAll('[data-track-control]').forEach(control => { control.disabled = Boolean(locked) })
    button('replace').disabled = Boolean(job || !selected())
    button('transpose-render').disabled = Boolean(job || transposeBusy || !selected())
    button('transpose-original').hidden = !selected()?.clip.transpose
    button('transpose-original').disabled = Boolean(locked || !selected()?.clip.transpose)
    button('note-center-analyze').disabled = Boolean(job || !selected())
    const targetCanHelp = noteProposal?.ok || ['invalid-target', 'transpose-out-of-range', 'stereo-target-disagreement'].includes(noteProposal?.reason)
    el('note-center-target').disabled = Boolean(job || !noteAnalyses || !targetCanHelp)
    button('note-center-reference').disabled = Boolean(job || !noteProposal?.ok)
    button('note-center-render').disabled = Boolean(job || !noteProposal?.ok || !noteProposal.canRecommendRender)
    el('replacement-offset').disabled = Boolean(job)
    for (const key of ['replacement-original', 'replacement-preview', 'replacement-confirm']) button(key).disabled = Boolean(job || !replacement?.project)
    button('replacement-cancel').disabled = false
    el('save-state').textContent = job?.kind === 'save' ? '正在打包…' : dirty() ? '有未下載的修改' : hasDownloaded ? '已交付下載；請確認存檔' : project.tracks.length || hasProjectDocument ? '已開啟工程' : '尚無修改'
    refreshRegionControls()
    selectionControls?.render()
    tempoControls?.render()
    groupControls?.render()
    root.setAttribute('aria-busy', String(Boolean(job)))
  }
  function renderInspector() {
    const item = selected()
    const group = clipSelection.refs.length > 1 ? describeClipGroup(project, clipSelection.refs) : null
    // Keep keyboard focus in the workspace when its contextual form disappears.
    const inspectorHadFocus = el('clip-fields').contains(document.activeElement)
    const groupHadFocus = el('group-tools').contains(document.activeElement)
    el('clip-fields').hidden = !item
    if (!item && inspectorHadFocus || !group && groupHadFocus) el('timeline').focus({ preventScroll: true })
    el('selection-title').textContent = group ? `已選 ${group.count} 個片段` : item ? item.clip.name : '選取片段以編輯'
    el('selection-range').textContent = group ? `${group.trackCount} 軌 · 保留軌道與間距` : item ? `${formatDawTime(item.clip.atSeconds)}–${formatDawTime(item.clip.atSeconds + item.clip.durationSeconds)}${item.clip.gainEnvelope ? '。保留裁切前的接縫曲線；重新套用淡入／淡出會替換它' : ''}` : clipSelection.mode ? '點選片段加入或取消選取' : '點選時間軸上的波形'
    if (item) {
      const { clip, track } = item
      for (const [key, value] of Object.entries({ 'clip-name': clip.name, 'clip-at': clip.atSeconds, 'trim-start': clip.atSeconds, 'trim-end': clip.atSeconds + clip.durationSeconds, 'clip-gain': clip.gainDb, 'fade-in': clip.fadeInSeconds, 'fade-out': clip.fadeOutSeconds })) el(key).value = typeof value === 'number' ? String(value) : value
      el('clip-track').replaceChildren(...project.tracks.map(t => { const option = node('option', '', t.name); option.value = t.id; return option }))
      el('clip-track').value = track.id
    }
    renderTransposeSettings(item)
    const noteKey = item ? `${project.id}:${project.revision}:${item.track.id}:${item.clip.id}:${selectionVersion}` : null
    if (noteKey !== noteControlOwner) { resetNoteCentering(); noteControlOwner = noteKey }
    renderRegions(item)
    renderAutomation()
    renderReplacement()
    root.querySelectorAll('.daw-clip').forEach(control => control.setAttribute('aria-pressed', String(isSelected(control.dataset.trackId, control.dataset.clipId))))
    refreshControls()
  }
  function readLyricSelection() {
    try { return getLyricSelection?.() || null } catch { return null }
  }
  function lyricSelectionKey(snapshot) {
    return snapshot ? JSON.stringify(snapshot) : ''
  }
  function renderLyricSelection() {
    const snapshot = readLyricSelection()
    el('region-lyric').textContent = snapshot?.ready
      ? `目前句子：「${snapshot.line.text}」· ${formatDawTime(snapshot.line.start)}–${formatDawTime(snapshot.line.end)}（歌詞原音檔：${snapshot.source.name}）${snapshot.line.confirmed ? '' : '。時間尚未確認，請先聽過再調整。'}`
      : snapshot?.blocker || '請先在歌詞工作區選取有完整時間、已連結原音檔的句子；也可直接手動輸入範圍。'
    return snapshot
  }
  function resetRegionMapping() {
    vocalTrackId = null; regionId = ''; regionControlOwner = null; lyricDraft = null; regionVersion++
    el('region-offset').value = ''; observedLyricKey = lyricSelectionKey(readLyricSelection())
  }
  function onLyricSelectionChange() {
    if (destroyed) return
    const snapshot = readLyricSelection(), key = lyricSelectionKey(snapshot)
    if (observedLyricKey !== null && key !== observedLyricKey) {
      const hadLyricDraft = Boolean(lyricDraft)
      if (hadLyricDraft) {
        regionVersion++; discardReplacement('歌詞或來源已修改，請重新核對並帶入句子')
        lyricDraft = null; el('region-start').value = ''; el('region-end').value = ''
        el('region-range').textContent = '歌詞已修改，請重新帶入句子，或手動填入時間軸範圍'
      }
      // An offset is a relationship between sources. Never reuse it after an
      // external session/selection change that could introduce a new clock.
      el('region-offset').value = ''
    }
    observedLyricKey = key; renderLyricSelection(); refreshRegionControls()
  }
  function regionSettingsKey() {
    return JSON.stringify([vocalTrackId, regionId, lyricDraft?.key || '', lyricDraft ? el('region-offset').value : '', ...['select', 'label', 'start', 'end', 'gain', 'fade-in', 'fade-out'].map(id => el(`region-${id}`).value)])
  }
  function regionNumbers() {
    const number = id => {
      const value = el(`region-${id}`).value
      if (!value.trim() || !Number.isFinite(Number(value))) throw new Error('請填入區間的起點、終點、保留音量與邊緣平滑數值')
      return Number(value)
    }
    return { startSeconds: number('start'), endSeconds: number('end'), gain: number('gain') / 100,
      fadeInSeconds: number('fade-in') / 1000, fadeOutSeconds: number('fade-out') / 1000, label: el('region-label').value.trim() }
  }
  function refreshRegionControls() {
    const item = selected(), region = item?.clip.gainRegions?.find(region => region.id === regionId)
    const locked = Boolean(job)
    button('region-designate').disabled = locked || !item || vocalTrackId === item.track.id
    button('region-prepare').disabled = locked || !item || !region && vocalTrackId !== item.track.id
    button('region-use-lyric').disabled = locked || !item || vocalTrackId !== item.track.id || !readLyricSelection()?.ready
    button('region-remove').disabled = locked || !region
    button('region-reset').disabled = locked || !item?.clip.gainRegions?.length
    el('region-select').disabled = locked || !item
  }
  function renderRegions(item) {
    if (vocalTrackId && !project.tracks.some(track => track.id === vocalTrackId)) vocalTrackId = null
    const regions = item?.clip.gainRegions || []
    const key = item ? `${project.id}:${project.revision}:${item.track.id}:${item.clip.id}` : null
    if (key !== regionControlOwner) {
      regionControlOwner = key; regionVersion++; lyricDraft = null
      if (!regions.some(region => region.id === regionId)) regionId = ''
      const region = regions.find(region => region.id === regionId)
      el('region-select').replaceChildren(...[node('option', '', '新增區間'), ...regions.map((region, index) => {
        const option = node('option', '', `${region.label || `區間 ${index + 1}`} · ${region.gain === 0 ? '靜音' : `${Number((region.gain * 100).toFixed(2))}%`}`)
        option.value = region.id; return option
      })])
      el('region-select').firstElementChild.value = ''; el('region-select').value = regionId
      for (const [id, value] of Object.entries({ label: region?.label || '', start: item ? item.clip.atSeconds + (region?.startSeconds || 0) : '',
        end: item ? item.clip.atSeconds + (region?.endSeconds ?? item.clip.durationSeconds) : '', gain: (region?.gain ?? 0) * 100,
        'fade-in': (region?.fadeInSeconds ?? .01) * 1000, 'fade-out': (region?.fadeOutSeconds ?? .01) * 1000 })) el(`region-${id}`).value = String(value)
      el('region-range').textContent = region ? `${formatDawTime(item.clip.atSeconds + region.startSeconds)}–${formatDawTime(item.clip.atSeconds + region.endSeconds)} · 已接受${region.attenuationEnvelope ? '。保留裁切前的邊緣形狀；修改時間或平滑會重新設定邊緣。' : ''}` : '可手動填入時間軸範圍；跨片段會一起處理指定音軌'
    }
    el('region-title').textContent = `人聲局部消音${regions.length ? ` · ${regions.length}` : ''}`
    const designated = project.tracks.find(track => track.id === vocalTrackId)
    el('region-track').textContent = designated ? `指定人聲軌：${designated.name}${item?.track.id !== vocalTrackId ? '；請選取該軌片段，或重新指定' : ''}` : '新增區間前，先指定目前音軌為已分離的人聲'
    button('region-designate').textContent = item && item.track.id === vocalTrackId ? '已指定此人聲軌' : '指定為獨立人聲軌'
    button('region-prepare').textContent = regionId ? '試聽區間修改' : '準備 A/B 試聽'
    renderLyricSelection()
  }
  function designateVocalTrack() {
    const item = selected(); if (!item) throw new Error('請先選取已分離人聲軌上的片段')
    discardReplacement(); vocalTrackId = item.track.id; regionVersion++; lyricDraft = null
    el('region-offset').value = ''; renderRegions(item); refreshControls()
    status(`已指定「${item.track.name}」；此功能會降低該軌範圍內的全部聲音，請確認是獨立人聲`)
  }
  function useLyricRegion() {
    const item = selected(), snapshot = readLyricSelection()
    if (!item || vocalTrackId !== item.track.id) throw new Error('請先指定並選取獨立人聲軌')
    const raw = el('region-offset').value
    if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error('請先核對兩個音檔的起點，明確填入對齊秒數；相同起點請填 0')
    const timelineOffsetSeconds = Number(raw)
    const plan = planLyricRegion(project, snapshot, { trackId: vocalTrackId, timelineOffsetSeconds })
    discardReplacement(); regionId = ''; regionVersion++
    el('region-select').value = ''
    lyricDraft = { snapshot, key: lyricSelectionKey(snapshot), timelineOffsetSeconds }
    observedLyricKey = lyricDraft.key
    el('region-start').value = String(plan.timelineRange.startSeconds); el('region-end').value = String(plan.timelineRange.endSeconds)
    el('region-label').value = snapshot.line.text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, DAW_LIMITS.maxGainRegionLabel)
    el('region-range').textContent = `已帶入整句，可手動修正到單字範圍。${describeRegionPlan(plan)}`
    button('region-prepare').textContent = '準備 A/B 試聽'; refreshControls()
    status('已帶入歌詞整句時間；請確認起點與終點，再準備 A/B 試聽')
  }
  function describeRegionPlan(plan) {
    return `${formatDawTime(plan.timelineRange.startSeconds)}–${formatDawTime(plan.timelineRange.endSeconds)} · ${plan.intersections.length} 片段${plan.gaps.length ? `；${plan.gaps.length} 段空白不處理（${plan.gaps.map(gap => `${formatDawTime(gap.startSeconds)}–${formatDawTime(gap.endSeconds)}`).join('、')}）` : ''}`
  }
  function prepareGainRegions() {
    if (job && !['replacement', 'transpose', 'audition'].includes(job.kind)) throw new Error('請先等待或取消目前工作')
    const item = selected()
    if (!item || !regionId && vocalTrackId !== item.track.id) throw new Error('請先指定目前音軌為已分離的人聲')
    const settings = regionNumbers()
    let plan
    if (lyricDraft) {
      if (lyricDraft.key !== lyricSelectionKey(readLyricSelection())) throw new Error('歌詞或來源已修改，請重新帶入句子')
      if (Number(el('region-offset').value) !== lyricDraft.timelineOffsetSeconds || !el('region-offset').value.trim()) throw new Error('對齊已修改，請重新帶入歌詞句子')
      plan = planLyricRegion(project, lyricDraft.snapshot, { trackId: item.track.id, timelineOffsetSeconds: lyricDraft.timelineOffsetSeconds,
        startSeconds: settings.startSeconds - lyricDraft.timelineOffsetSeconds, endSeconds: settings.endSeconds - lyricDraft.timelineOffsetSeconds })
    } else plan = planTimelineGainRegion(project, item.track.id, settings.startSeconds, settings.endSeconds)
    const next = stageGainRegionDraft(project, plan, settings, { clipId: item.clip.id, regionId })
    if (regionId) plan = { ...plan, intersections: plan.intersections.filter(range => range.clipId === item.clip.id), gaps: [], completeCoverage: true, coveredDurationSeconds: settings.endSeconds - settings.startSeconds }
    discardReplacement(); stop()
    if (retainedBytes() + JSON.stringify(next).length * 4 > DAW_LIMITS.maxCombinedBytes) throw new Error('區間試聽超出記憶體預算；請先下載並精簡專案')
    const owner = { ...captureReplacementOwner(), regionVersion, settingsKey: regionSettingsKey(), ...(lyricDraft ? { lyricKey: lyricDraft.key } : {}) }
    replacement = { kind: 'gain-regions', owner, project: next, buffers, files, mix: null, plan, settings, regionId }
    el('region-details').open = true; renderReplacement(); refreshControls()
    status('區間已準備，請 A/B 試聽後接受；目前播放與下載仍使用已接受的專案')
  }
  function appendRegionCues(container, clip) {
    for (const region of clip.gainRegions || []) {
      const cue = node('span', 'daw-region-cue')
      cue.style.left = `${region.startSeconds / clip.durationSeconds * 100}%`
      cue.style.width = `${(region.endSeconds - region.startSeconds) / clip.durationSeconds * 100}%`
      cue.dataset.regionId = region.id; cue.setAttribute('aria-hidden', 'true')
      cue.title = `${region.label || '人聲區間'} · ${region.gain === 0 ? '靜音' : `${Number((region.gain * 100).toFixed(2))}%`}`
      container.append(cue)
    }
  }
  function renderRegionReview() {
    const staged = replacement, review = el('replacement-review')
    review.dataset.kind = 'gain-regions'; review.setAttribute('aria-label', '待接受的人聲局部消音')
    el('region-details').append(review)
    button('replacement-original').textContent = 'A 原混音'; button('replacement-preview').textContent = 'B 區間處理後'
    button('replacement-confirm').textContent = '接受區間'; button('replacement-cancel').textContent = '取消'
    button('replacement-confirm').setAttribute('aria-describedby', 'daw-region-warning')
    const track = project.tracks.find(track => track.id === staged.owner.trackId)
    el('replacement-summary').textContent = `「${track.name}」${staged.settings.gain === 0 ? '靜音' : `保留 ${Number((staged.settings.gain * 100).toFixed(2))}% 音量`}。${describeRegionPlan(staged.plan)}。尚未接受。`
    el('replacement-audition-help').textContent = 'A/B 都播放這段範圍的完整混音；B 只改這條音軌的區間。接受前，一般播放、工程與 WAV 仍使用原設定。'
    const graph = node('div', 'daw-region-preview-wave'), start = staged.plan.timelineRange.startSeconds, length = staged.plan.timelineRange.endSeconds - start
    for (const range of staged.plan.intersections) {
      const clip = track.clips.find(clip => clip.id === range.clipId)
      const piece = node('div', 'daw-region-preview-piece')
      piece.style.left = `${(clip.atSeconds + range.startSeconds - start) / length * 100}%`
      piece.style.width = `${(range.endSeconds - range.startSeconds) / length * 100}%`
      piece.append(waveform({ ...clip, offsetSeconds: clip.offsetSeconds + range.startSeconds, durationSeconds: range.endSeconds - range.startSeconds }))
      graph.append(piece)
    }
    el('replacement-wave').append(graph)
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
  function waveform(clip, sourceBuffers = buffers) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 160 50'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('class', 'daw-wave'); svg.setAttribute('aria-hidden', 'true')
    const buffer = sourceBuffers.get(clip.assetId)
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
    const gridOrigin = getDawGridOrigin(project)
    timeline.style.setProperty('--daw-grid-origin', `${(gridOrigin % gridStep()) * rate}px`)
    const rulerLabel = node('span', 'daw-ruler-label', '音軌 / 秒')
    const rulerLane = node('div', 'daw-ruler-lane'); rulerLane.dataset.seekLane = 'true'
    const tickSize = seconds > 120 ? 10 : 5
    for (let sec = 0; sec <= seconds; sec += tickSize) { const tick = node('span', 'daw-tick', formatDawTime(sec).slice(0, 5)); tick.style.left = `${sec * rate}px`; rulerLane.append(tick) }
    if (gridOrigin > 0 && gridOrigin <= seconds) {
      const marker = node('span', 'daw-grid-origin-marker', '拍點')
      marker.style.left = `${gridOrigin * rate}px`; marker.dataset.gridOrigin = String(gridOrigin)
      marker.setAttribute('aria-label', `拍格參考點 ${gridOrigin} 秒`)
      rulerLane.append(marker)
    }
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
        control.setAttribute('aria-label', `${track.name}，${clip.name}，${formatDawTime(clip.atSeconds)} 至 ${formatDawTime(clip.atSeconds + clip.durationSeconds)}${clip.gainRegions?.length ? `，${clip.gainRegions.length} 個局部消音區間` : ''}。左右方向鍵移動`)
        control.setAttribute('aria-pressed', String(isSelected(track.id, clip.id))); control.append(node('span', 'daw-clip-name', clip.name), waveform(clip));
        appendRegionCues(control, clip); lane.append(control)
      }
      lane.append(node('i', 'daw-playhead')); row.append(controls, lane); return row
    })
    el('tracks').replaceChildren(...rows); el('empty').hidden = project.tracks.length > 0
    if (focusKey) ([...root.querySelectorAll('.daw-clip')].find(item => item.dataset.clipId === focusKey) || el('timeline')).focus({ preventScroll: true })
    if (focusTrack) ([...root.querySelectorAll('[data-track-control]')].find(item => item.dataset.trackId === focusTrack.id && item.dataset.trackControl === focusTrack.control) || button('add-track')).focus({ preventScroll: true })
    selectionControls?.render()
  }
  function render() {
    el('name').value = project.name; el('tempo').value = String(project.tempo); el('sample-rate').value = String(project.sampleRate); el('master-gain').value = String(project.masterGainDb)
    el('summary').textContent = `${project.tracks.length} 軌 · ${project.tracks.reduce((sum, track) => sum + track.clips.length, 0)} 片段 · ${formatDawTime(duration())}`
    el('summary').title = el('summary').textContent
    el('seek').max = String(duration()); el('seek').disabled = !duration()
    if (!mix) el('render-info').textContent = '尚未產生目前版本的混音；峰值過載時會停止 WAV 輸出'
    renderTracks(); renderInspector(); paintPlayhead()
  }
  async function withJob(kind, work) {
    if (job) throw new Error('另一項工作正在進行；請等待或先取消')
    const current = { kind, controller: new AbortController(), generation: ++generation, buffers: new Set(), mixBuffers: new Set(), extraBytes: 0 }
    operationLeases.add(current)
    job = current; refreshControls()
    const isCurrent = () => !destroyed && !current.controller.signal.aborted && current.generation === generation
    const check = () => { if (!isCurrent()) throw abortError() }
    const retainBuffer = (buffer, nativeMix = false) => {
      current.buffers.add(buffer); if (nativeMix) current.mixBuffers.add(buffer)
    }
    const reserveBytes = (bytes, message = '目前工作超出編輯器的保守記憶體預算') => {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || retainedBytes() - current.extraBytes + bytes > DAW_LIMITS.maxCombinedBytes) throw new Error(message)
      current.extraBytes = bytes
    }
    try { const result = await work({ signal: current.controller.signal, isCurrent, check, retainBuffer, reserveBytes }); check(); return result }
    finally { operationLeases.delete(current); if (job === current) { job = null; refreshControls() } }
  }
  async function decode(bytes, metadata, signal, trackNative) {
    let timer, aborted
    const cancelled = new Promise((_, reject) => { aborted = () => reject(abortError()); signal.addEventListener('abort', aborted, { once: true }) })
    try {
      const decoder = decodeAsset || decodeDawAsset
      const operation = Promise.resolve(decoder(bytes, metadata, { signal }))
      // The shared decoder rejects promptly on Abort, but its native promise
      // still owns audio. Injected decoders expose their own settlement here.
      trackNative?.(typeof decoder.whenIdle === 'function' ? decoder.whenIdle() : operation.then(() => {}, () => {}))
      const result = await Promise.race([
        operation, cancelled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('音檔解碼逾時；原專案仍保留')), 30000) }),
      ])
      return result?.buffer?.getChannelData ? result.buffer : result
    } finally { clearTimeout(timer); signal.removeEventListener('abort', aborted) }
  }
  function reserveLoad(bytes) {
    if (loadWorkPending) throw new Error('上一批音檔或工程仍在讀取或背景解碼，請稍候再試；原專案仍保留')
    let reservedBytes = 0, nativeSettled = true, finished = false
    const set = value => {
      if (!Number.isSafeInteger(value) || value < 0 || retainedBytes() - reservedBytes + value > DAW_LIMITS.maxCombinedBytes) throw new Error('讀取工作會超出記憶體預算；請先下載並清理舊專案')
      pendingLoadBytes += value - reservedBytes; reservedBytes = value
    }
    set(bytes); loadWorkPending = true
    const release = () => { pendingLoadBytes -= reservedBytes; reservedBytes = 0; loadWorkPending = false }
    return {
      set,
      add(bytes) { set(reservedBytes + bytes) },
      trackNative(settlement) {
        nativeSettled = false
        // Its output size is unknown until decode returns. Reserve the maximum
        // accepted PCM allowance against OTHER work while it is native-owned.
        // A codec may internally allocate more; this is not a native hard cap.
        const nativeAllowance = DAW_LIMITS.maxDecodedBytes
        pendingLoadBytes += nativeAllowance
        settlement.then(() => {
          pendingLoadBytes -= nativeAllowance; nativeSettled = true
          if (finished) release()
        })
      },
      finish() {
        // UI cancellation is not the settlement of unabortable native work.
        finished = true
        if (nativeSettled) release()
      },
    }
  }
  async function importFiles(inputFiles) {
    const list = [...inputFiles]
    if (!list.length) return
    if (loadWorkPending) throw new Error('上一批音檔或工程仍在讀取或背景解碼，請稍候再試；原專案仍保留')
    discardReplacement()
    return withJob('import', async ({ signal, check }) => {
      if (project.tracks.length + list.length > DAW_LIMITS.maxTracks) throw new Error('最多 16 軌；請先刪除不需要的音軌')
      for (const file of list) if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_LIMIT) throw new Error(`${file.name}：原檔須介於 1 byte 與 64 MiB 之間`)
      let next = project, nextSelection = selection
      const nextBuffers = new Map(buffers), nextFiles = new Map(files)
      const inputBytes = list.reduce((sum, file) => sum + file.size, 0)
      const transientBytes = 2 * Math.max(...list.map(file => file.size))
      if (inputBytes + transientBytes + retainedBytes() > DAW_LIMITS.maxCombinedBytes) throw new Error('匯入會超出記憶體預算；請先下載並清理舊專案')
      const reservation = reserveLoad(inputBytes + transientBytes)
      try {
        for (let i = 0; i < list.length; i++) {
          const file = list[i]; status(`正在解碼 ${i + 1}/${list.length}：${file.name}`)
          const bytes = await file.arrayBuffer(); check()
          const hash = await sha256Hex(bytes); check()
          const buffer = await decode(bytes, { name: file.name }, signal, reservation.trackNative); check()
          const bufferBytes = buffer.length * buffer.numberOfChannels * 4
          if (retainedBytes() + bufferBytes > DAW_LIMITS.maxCombinedBytes) throw new Error('音檔解碼後超出記憶體預算；原專案仍保留')
          const registered = registerAudioBuffer(next, nextBuffers, buffer, { name: file.name, hash })
          reservation.add(bufferBytes)
          next = registered.project; nextFiles.set(registered.asset.id, file)
          const trackId = generateId('track'), clipId = generateId('clip')
          next = applyCommand(next, { type: 'track.add', track: { id: trackId, name: file.name } })
          next = applyCommand(next, { type: 'clip.add', trackId, clip: { id: clipId, assetId: registered.asset.id, name: file.name } })
          if (i === list.length - 1) nextSelection = { trackId, clipId }
        }
        check(); rememberSelection(); history.push(next); invalidate(); project = next; buffers = nextBuffers; files = nextFiles
        clipSelection.setMode(false); if (nextSelection) clipSelection.select(nextSelection); syncSelection()
        retainHistoryAssets(); cursor = 0; render(); status(`已匯入 ${list.length} 個音檔，各自從 0 秒開始。可復原整批匯入`)
      } finally {
        // Cancel/Clear only retire UI ownership. Unabortable reads, hashes and
        // native decode keep their bytes reserved until actual settlement.
        reservation.finish()
      }
    })
  }
  const cachedMixBytes = () => mix ? mix.buffer.length * mix.buffer.numberOfChannels * 4 : 0
  const metadataBytes = () => history.bytes * 2 + JSON.stringify(project).length * 2 + selectionHistory.bytes * 2
  const replacementBytes = () => replacement ? (replacement.kind === 'gain-regions' ? 0 : replacement.buffer.length * replacement.buffer.numberOfChannels * 4 + replacement.file.size) +
    (replacement.mix ? replacement.mix.buffer.length * replacement.mix.buffer.numberOfChannels * 4 : 0) + JSON.stringify(replacement.registeredProject || replacement.project).length * 4 : 0
  const pcmBytes = buffer => buffer ? buffer.length * buffer.numberOfChannels * 4 : 0
  function operationAndNativeCopyBytes() {
    // Web Audio can keep an acquired immutable mix while getChannelData lazily
    // materializes another full copy. Reserve one extra copy conservatively,
    // even before playback; a tiny exported range does not make it a tiny copy.
    const heldMixes = new Set([mix?.buffer, replacement?.mix?.buffer, pendingAudition?.staged?.mix?.buffer, source?.buffer].filter(Boolean))
    const counted = new Set([...buffers.values(), mix?.buffer, replacement?.buffer, replacement?.mix?.buffer,
      ...(pendingAudition?.staged?.buffers?.values() || []), pendingAudition?.staged?.mix?.buffer].filter(Boolean))
    let bytes = 0
    for (const lease of operationLeases) {
      bytes += lease.extraBytes
      for (const buffer of lease.buffers) if (!counted.has(buffer)) { counted.add(buffer); bytes += pcmBytes(buffer) }
      for (const buffer of lease.mixBuffers) heldMixes.add(buffer)
    }
    for (const buffer of heldMixes) bytes += pcmBytes(buffer)
    return bytes
  }
  const retainedBytes = () => decodedBytes(buffers) + [...files.values()].reduce((sum, file) => sum + file.size, 0) + cachedMixBytes() + metadataBytes() + replacementBytes() + pendingReplacementBytes + pendingLoadBytes + noteAnalysisBytes + getPendingNativeRenderBytes() +
    (pendingAudition && replacement !== pendingAudition.staged ? pendingAudition.bytes : 0) + operationAndNativeCopyBytes()
  function captureReplacementOwner() {
    const item = selected()
    if (!item) throw new Error('請先選取要替換的一個片段')
    return { snapshot: project, trackId: item.track.id, clipId: item.clip.id, sourceId: item.clip.assetId, selectionVersion }
  }
  function checkReplacementOwner(owner) {
    if (destroyed || owner.snapshot !== project || owner.selectionVersion !== selectionVersion ||
      owner.trackId !== selection?.trackId || owner.clipId !== selection?.clipId || owner.sourceId !== selected()?.clip.assetId ||
      owner.transposeVersion !== undefined && (owner.transposeVersion !== transposeVersion || owner.settingsKey !== transposeSettingsKey()) ||
      owner.noteCenterTarget !== undefined && owner.noteCenterTarget !== el('note-center-target').value ||
      owner.regionVersion !== undefined && (owner.regionVersion !== regionVersion || owner.settingsKey !== regionSettingsKey() || owner.lyricKey !== undefined && owner.lyricKey !== lyricSelectionKey(readLyricSelection()))) throw abortError()
  }
  function discardReplacement(message) {
    const present = replacement || replacementOwner || job && ['replacement', 'transpose', 'audition'].includes(job.kind)
    replacement = null; replacementOwner = null
    if (job && ['replacement', 'transpose', 'audition'].includes(job.kind)) cancelJob(message)
    if (present) { stop(); renderReplacement(); refreshControls(); if (message) status(message) }
  }
  function replacementOffset() {
    const value = el('replacement-offset').value
    if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('請填入有效的新錄音起點（0 秒以上）；原片段保持不變')
    return Number(value)
  }
  function replacementProject(staged, offsetSeconds) {
    checkReplacementOwner(staged.owner)
    return applyCommand(staged.registeredProject, { type: 'clip.replaceSource', trackId: staged.owner.trackId,
      clipId: staged.owner.clipId, assetId: staged.asset.id, offsetSeconds, ...(staged.transpose ? { transpose: staged.transpose } : {}) })
  }
  function renderReplacement() {
    const item = selected(), asset = item && project.assets.find(asset => asset.id === item.clip.assetId)
    el('current-source').textContent = item ? `目前錄音：${asset.name} · ${asset.sampleRate / 1000} kHz · 原檔 ${formatDawTime(item.clip.offsetSeconds)} 起，共 ${formatDawTime(item.clip.durationSeconds)}` : ''
    const review = el('replacement-review'), wasTranspose = review.dataset.kind === 'transpose', wasRegion = review.dataset.kind === 'gain-regions'
    const reviewHadFocus = review.contains(document.activeElement)
    review.hidden = !replacement
    if (!replacement && reviewHadFocus) {
      const command = wasRegion ? 'region-prepare' : wasTranspose ? 'transpose-render' : 'replace'
      const target = button(command).disabled ? el(wasRegion ? 'region-details' : wasTranspose ? 'transpose-details' : 'replacement-details').querySelector('summary') : button(command)
      target.focus({ preventScroll: true })
    }
    el('replacement-wave').replaceChildren()
    if (!replacement) { el('replacement-summary').textContent = ''; return }
    if (replacement.kind === 'gain-regions') { renderRegionReview(); return }
    const transposed = replacement.kind === 'transpose'
    review.dataset.kind = replacement.kind || 'replacement'
    el(transposed ? 'transpose-details' : 'replacement-details').append(review)
    review.setAttribute('aria-label', transposed ? '待接受的片段移調' : '待確認的替換錄音')
    button('replacement-original').textContent = 'A 原錄音混音'
    el('replacement-audition-help').textContent = '試聽此片段範圍的完整混音，包含其他音軌。確認前，一般播放與下載仍使用原錄音。'
    button('replacement-confirm').setAttribute('aria-describedby', 'daw-replacement-privacy')
    button('replacement-preview').textContent = transposed ? 'B 處理後混音' : 'B 替換後混音'
    button('replacement-confirm').textContent = transposed ? '接受移調' : '確認替換錄音'
    button('replacement-cancel').textContent = transposed ? '取消' : '取消替換'
    const clip = replacement.project?.tracks.find(track => track.id === replacement.owner.trackId)?.clips.find(clip => clip.id === replacement.owner.clipId)
    const target = selected().clip
    el('replacement-summary').textContent = `待替換「${target.name}」：${asset.name} → ${replacement.file.name}（${replacement.buffer.sampleRate / 1000} kHz，${formatDawTime(replacement.buffer.duration)}）。時間軸 ${formatDawTime(target.atSeconds)}–${formatDawTime(target.atSeconds + target.durationSeconds)}。${clip ? `新錄音使用 ${formatDawTime(clip.offsetSeconds)}–${formatDawTime(clip.offsetSeconds + clip.durationSeconds)}，尚未套用。` : '起點或長度無效，請修正起點後再試。'}`
    if (transposed) {
      const m = replacement.metadata, signed = n => `${n > 0 ? '+' : ''}${n}`
      el('replacement-summary').textContent = `${signed(m.semitones)} 半音 · 共振峰 ${signed(m.formantSemitones)} · ${m.formantCompensation ? '近似補償' : '無補償'} · ${replacement.buffer.sampleRate / 1000} kHz。尚未套用。${m.outputPeak > 1 ? '來源峰值超過 0 dBFS，未截幅；若混音也過載，請取消並保留原音，降低片段或總音量後重新產生試聽。' : ''}`
    }
    if (clip) el('replacement-wave').append(waveform(clip, replacement.buffers))
  }
  function renderTransposeSettings(item) {
    // Prefill only when the source/selection actually changes; ordinary UI
    // rerenders must not overwrite a pending edit to the visible settings.
    const key = item ? `${item.track.id}:${item.clip.id}:${item.clip.assetId}` : null
    if (key === transposeControlOwner) return
    transposeControlOwner = key; transposeVersion++
    const t = item?.clip.transpose
    for (const [id, value] of Object.entries({ semitones: t?.semitones ?? 0, cents: t?.cents ?? 0, formants: t?.formantSemitones ?? 0 })) el(`transpose-${id}`).value = String(value)
    el('transpose-compensation').checked = t?.formantCompensation ?? false
    el('transpose-source').textContent = `先 A/B 試聽，再接受；可回到原音${t ? '。再產生會從原音開始' : ''}`
  }
  function restoreTransposeOriginal() {
    const item = selected()
    if (!item?.clip.transpose) throw new Error('此片段沒有可回復的移調原音')
    const source = project.assets.find(asset => asset.id === item.clip.transpose.sourceAssetId)
    const original = getClipOriginalSource(item.clip, source.sampleRate)
    const hadFocus = document.activeElement === button('transpose-original')
    clipCommand('clip.replaceSource', original, '已回到保留原音；位置、長度、音量曲線仍保留，可復原／重做')
    if (hadFocus) (button('transpose-render').disabled ? el('transpose-details').querySelector('summary') : button('transpose-render')).focus({ preventScroll: true })
  }
  function transposeSettings() {
    const number = id => {
      const raw = el(`transpose-${id}`).value
      if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error('請填入有效的移調與共振峰數值')
      return Number(raw)
    }
    const semitones = number('semitones'), cents = number('cents'), formantSemitones = number('formants')
    if (Math.abs(semitones) > 2 || Math.abs(cents) > 100 || Math.abs(semitones + cents / 100) > 2) throw new Error('半音與音分合計須在 ±2 半音內')
    if (Math.abs(formantSemitones) > 2) throw new Error('共振峰須在 ±2 半音內')
    return { semitones, cents, formantSemitones, formantCompensation: el('transpose-compensation').checked }
  }
  // Include uncommitted input text. Accept cannot adopt a result that disagrees
  // with controls, even if a browser has not emitted change/blur yet.
  function transposeSettingsKey() {
    return JSON.stringify(['semitones', 'cents', 'formants', 'compensation'].map(id => {
      const input = el(`transpose-${id}`); return input.type === 'checkbox' ? input.checked : input.value
    }))
  }
  function stopNoteReference() {
    if (!noteReference) return
    const held = noteReference; noteReference = null
    clearTimeout(held.timer); held.oscillator.onended = null
    try { held.oscillator.stop() } catch { /* Already ended. */ }
    held.oscillator.disconnect(); held.gain.disconnect()
  }
  function resetNoteCentering() {
    noteAnalysisClient?.dispose(); noteAnalysisClient = null; stopNoteReference()
    noteAnalyses = null; noteOwner = null; noteProposal = null
    el('note-center-result').textContent = '尚未分析'
    el('note-center-target').value = 'nearest'
    refreshControls()
  }
  function noteCurrentOwner(channel = 0) {
    const owner = captureReplacementOwner()
    return { ...owner, sourceBuffer: buffers.get(owner.sourceId), channel }
  }
  function updateNoteProposal() {
    if (!noteAnalyses || !noteOwner) return
    const item = selected(), raw = el('note-center-target').value
    const targetMidi = raw === 'nearest' ? null : Number(raw)
    const current = noteCurrentOwner()
    noteProposal = combineNoteCenteringPlans(noteAnalyses.map((analysis, channel) =>
      planNoteCentering(analysis, { clip: item.clip, owner: { ...noteOwner, channel }, currentOwner: { ...current, channel }, targetMidi })))
    if (!noteProposal.ok) el('note-center-result').textContent = noteProposal.message
    else {
      const cents = noteProposal.correctionCents, direction = cents < 0 ? '降低' : '提高'
      el('note-center-result').textContent = `估計中心 ${midiToNote(noteProposal.centerMidi)} · ${noteProposal.centerHz.toFixed(1)} Hz\n目標 ${noteProposal.targetNote}：整段${direction} ${Math.abs(cents).toFixed(1)} 音分${noteProposal.nearTarget ? '\n已很接近，建議保留目前聲音' : '\n產生後請 A/B 試聽，尚未改變聲音'}`
    }
    refreshControls()
  }
  async function analyzeNoteCenter() {
    if (job) throw new Error('請先等待或取消目前工作')
    discardReplacement(); resetNoteCentering()
    const owner = noteCurrentOwner(), clip = selected().clip, input = owner.sourceBuffer
    if (!input || ![44100, 48000, 96000].includes(input.sampleRate) || ![1, 2].includes(input.numberOfChannels)) throw new Error('單音分析支援 44.1／48／96 kHz 的單聲道或立體聲錄音')
    if (clip.durationSeconds < NOTE_CENTERING_LIMITS.minDurationSeconds || clip.durationSeconds > NOTE_CENTERING_LIMITS.maxDurationSeconds) throw new Error('先剪出 0.35–30 秒的穩定單音片段')
    // Only one source channel is copied/transferred at a time. Reserve its PCM,
    // analysis work arrays and both channels' small contour results until done.
    const reserve = Math.ceil(clip.durationSeconds * input.sampleRate) * 4 + 6 * 1024 * 1024
    if (retainedBytes() + reserve > DAW_LIMITS.maxCombinedBytes) throw new Error('單音分析超出記憶體預算，請先保存工程並精簡素材')
    stop(); noteAnalysisBytes += reserve
    let analysisClient = null
    try {
      await withJob('note-analysis', async request => {
        request.retainBuffer(input)
        const check = () => { request.check(); checkReplacementOwner(owner); if (buffers.get(owner.sourceId) !== input) throw abortError() }
        analysisClient = noteAnalysisClientFactory(); noteAnalysisClient = analysisClient
        const client = analysisClient, analyses = []
        for (let channel = 0; channel < input.numberOfChannels; channel++) {
          check()
          analyses.push(await client.analyze(input, { start: clip.offsetSeconds, duration: clip.durationSeconds, channel, signal: request.signal,
            onProgress: value => { if (!request.signal.aborted) status(`正在估計單音：聲道 ${channel + 1}/${input.numberOfChannels} · ${Math.round((value.progress || 0) * 100)}%`) } }))
          check()
        }
        noteOwner = owner; noteAnalyses = analyses; updateNoteProposal()
        status(noteProposal.ok ? '單音估計完成；請核對目標音，產生候選後先 A/B 聽過' : '此片段不適合自動建議；原音保持不變')
      })
    } finally {
      analysisClient?.dispose(); if (noteAnalysisClient === analysisClient) noteAnalysisClient = null
      noteAnalysisBytes -= reserve; refreshControls()
    }
  }
  async function prepareCenteredNote() {
    if (!noteAnalyses || !noteOwner) throw new Error('請先估計目前片段的單音')
    updateNoteProposal()
    if (!noteProposal?.ok || !noteProposal.canRecommendRender) throw new Error(noteProposal?.message || '估計已很接近目標，建議先保留目前聲音')
    const settings = noteProposal.settings
    discardReplacement(); transposeVersion++
    for (const [key, value] of Object.entries({ semitones: settings.semitones, cents: settings.cents, formants: settings.formantSemitones })) el(`transpose-${key}`).value = String(value)
    el('transpose-compensation').checked = settings.formantCompensation
    await prepareTranspose({ noteCenterTarget: el('note-center-target').value })
  }
  async function playNoteReference() {
    updateNoteProposal()
    if (!noteProposal?.ok) throw new Error('請先取得有效的單音與目標音')
    // A reference oscillator needs selection identity, never source PCM.
    // resume()/beforePlayback may remain pending after Cancel or Clear.
    const owner = captureReplacementOwner(), target = noteProposal.targetMidi
    stop()
    await withJob('note-reference', async request => {
      await beforePlayback?.(); request.check(); checkReplacementOwner(owner)
      const ctx = getContext(); await ctx.resume(); request.check(); checkReplacementOwner(owner)
      if (noteProposal?.targetMidi !== target) throw abortError()
      const oscillator = ctx.createOscillator(), gain = ctx.createGain(), now = ctx.currentTime
      oscillator.type = 'sine'; oscillator.frequency.value = midiToFrequency(target)
      gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(.035, now + .02)
      gain.gain.setValueAtTime(.035, now + .75); gain.gain.linearRampToValueAtTime(0, now + .8)
      oscillator.connect(gain); gain.connect(ctx.destination)
      const held = { oscillator, gain, timer: null }; noteReference = held
      oscillator.onended = () => { if (noteReference === held) { stopNoteReference(); refreshControls() } }
      oscillator.start(now); oscillator.stop(now + .81)
      held.timer = setTimeout(() => { if (noteReference === held) { stopNoteReference(); refreshControls() } }, 1500)
      status(`正在播放目標參考音 ${midiToNote(target)}；原音保持不變`)
    })
  }
  async function prepareTranspose({ noteCenterTarget } = {}) {
    if (job && !['replacement', 'transpose', 'audition'].includes(job.kind)) throw new Error('請先等待或取消目前工作')
    discardReplacement()
    if (transposeBusy || replacementReadBusy) throw new Error('上一份音訊仍在整理，請稍候再試')
    const owner = { ...captureReplacementOwner(), transposeVersion, settingsKey: transposeSettingsKey(), ...(noteCenterTarget !== undefined ? { noteCenterTarget } : {}) }
    const settings = transposeSettings(), clip = selected().clip
    const sourceAsset = project.assets.find(asset => asset.id === (clip.transpose?.sourceAssetId || clip.assetId))
    if (sourceAsset.decodeBackend === 'generated-float32-wav') throw new Error('此舊處理素材沒有原音連結；請先選擇原錄音，避免疊加移調')
    const originalSource = getClipOriginalSource(clip, sourceAsset.sampleRate)
    const input = buffers.get(originalSource.assetId), originalClip = { ...clip, ...originalSource }
    const plan = planClipTranspose(input, originalClip, settings)
    const transpose = { version: 1, engine: CLIP_TRANSPOSE_ENGINE, sourceAssetId: originalSource.assetId,
      sourceOffsetSeconds: originalClip.offsetSeconds, sourceDurationSeconds: clip.durationSeconds,
      cropFirstFrame: plan.first, cropLastFrame: plan.last, ...settings }
    if (buffers.size >= DAW_LIMITS.maxAssets || decodedBytes(buffers) + plan.pcmBytes > DAW_LIMITS.maxDecodedBytes) throw new Error('原音與復原素材已達上限；請先下載工程並另開精簡專案')
    if (retainedBytes() + plan.reservedBytes > DAW_LIMITS.maxCombinedBytes) throw new Error('移調會超出記憶體預算；請先下載工程，或使用較短片段')
    const sourceToken = JSON.stringify([project.id, project.revision, owner.trackId, owner.clipId, owner.sourceId, owner.selectionVersion, owner.transposeVersion, owner.settingsKey])
    stop()
    transposeBusy = true; pendingReplacementBytes += plan.reservedBytes
    try {
      return await withJob('transpose', async ({ signal, check }) => {
        const checkOwner = () => { check(); checkReplacementOwner(owner) }
        pitchClient ||= pitchClientFactory()
        status('正在本機產生移調試聽…')
        const generated = await renderClipTranspose(plan, { client: pitchClient, settings, signal, sourceToken, check: checkOwner,
          createBuffer: (channels, length, rate) => getContext().createBuffer(channels, length, rate),
          onProgress: value => { if (!signal.aborted) status(`正在本機移調：${Math.round(value * 100)}%`) } })
        checkOwner()
        const original = sourceAsset
        const name = `${original.name.replace(/\.[^.]+$/, '').slice(0, 80)}-transpose.wav`
        const file = new File([generated.bytes], name, { type: 'audio/wav' })
        const nextBuffers = new Map(buffers), nextFiles = new Map(files)
        const registered = registerAudioBuffer(project, nextBuffers, generated.buffer, { name, hash: generated.hash,
          sourceSampleRate: generated.buffer.sampleRate, decodeBackend: 'generated-float32-wav' })
        nextFiles.set(registered.asset.id, file)
        const staged = { kind: 'transpose', owner, file, buffer: generated.buffer, asset: registered.asset,
          registeredProject: registered.project, buffers: nextBuffers, files: nextFiles, mix: null,
          offsetSeconds: generated.offsetSeconds, metadata: generated.metadata, transpose }
        staged.project = replacementProject(staged, staged.offsetSeconds)
        checkOwner(); replacement = staged
        el('transpose-details').open = true; renderReplacement(); refreshControls()
        status('移調已產生，請 A/B 試聽後接受；原片段與下載仍保持不變')
      })
    } finally { pendingReplacementBytes -= plan.reservedBytes; transposeBusy = false; refreshControls() }
  }
  async function prepareReplacement(file, owner = captureReplacementOwner()) {
    if (!file) return
    if (job && !['replacement', 'transpose', 'audition'].includes(job.kind)) throw new Error('請先等待或取消目前工作')
    discardReplacement(); checkReplacementOwner(owner)
    if (replacementReadBusy) throw new Error('上一份替換錄音仍在讀取或驗證，請稍候再試；原片段保持不變')
    if (loadWorkPending) throw new Error('上一批音檔或工程仍在讀取或背景解碼，請稍候再試；原專案仍保留')
    const offsetSeconds = replacementOffset()
    stop()
    return withJob('replacement', async ({ signal, check }) => {
      const checkOwner = () => { check(); checkReplacementOwner(owner) }
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > FILE_LIMIT) throw new Error('替換錄音須介於 1 byte 與 64 MiB；原片段保持不變')
      if (buffers.size >= DAW_LIMITS.maxAssets) throw new Error('原音與復原素材已達 64 份；請先下載工程並另開精簡專案')
      if (retainedBytes() + file.size * 3 > DAW_LIMITS.maxCombinedBytes) throw new Error('替換錄音會超出記憶體預算；請先下載工程，並使用較短的錄音')
      status(`正在本機讀取替換錄音：${file.name}`)
      // File reads and hashes cannot be aborted. Retain their reservation even
      // after Cancel, and reject another replacement read until they settle.
      // Other operations include this reservation in their memory checks.
      const reservation = reserveLoad(file.size * 3)
      try {
        let bytes, hash
        replacementReadBusy = true
        try {
          bytes = await file.arrayBuffer(); checkOwner()
          if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size) throw new Error('替換錄音讀取不完整；原片段保持不變')
          hash = await sha256Hex(bytes); checkOwner()
        } finally { replacementReadBusy = false }
        const sourceSampleRate = wavSampleRate(bytes)
        const buffer = await decode(bytes, { name: file.name }, signal, reservation.trackNative); checkOwner()
        if (retainedBytes() + buffer.length * buffer.numberOfChannels * 4 > DAW_LIMITS.maxCombinedBytes) throw new Error('替換錄音解碼後超出記憶體預算；原片段保持不變')
        const nextBuffers = new Map(buffers), nextFiles = new Map(files)
        const registered = registerAudioBuffer(project, nextBuffers, buffer, { name: file.name, hash, sourceSampleRate,
          decodeBackend: sourceSampleRate ? 'native-rate-wav' : 'browser-rate-fallback' })
        if (sourceSampleRate !== null && buffer.sampleRate !== sourceSampleRate) throw new Error('替換 WAV 未保留原始取樣率；原片段保持不變')
        nextFiles.set(registered.asset.id, file)
        const staged = { owner, file, buffer, asset: registered.asset, registeredProject: registered.project, buffers: nextBuffers, files: nextFiles, mix: null }
        staged.project = replacementProject(staged, offsetSeconds)
        checkOwner(); replacement = staged
        el('replacement-details').open = true
        renderReplacement(); refreshControls()
        status('替換錄音已備妥，請試聽並確認；目前專案與下載仍使用原錄音')
      } finally { reservation.finish() }
    })
  }
  function updateReplacementOffset() {
    if (!replacement || ['transpose', 'gain-regions'].includes(replacement.kind)) return
    if (job?.kind === 'audition') cancelJob('起點已修改，請重新選擇替換錄音')
    if (!replacement) return
    stop(); replacement.mix = null; replacement.project = null
    try { replacement.project = replacementProject(replacement, replacementOffset()) }
    finally { renderReplacement(); refreshControls() }
  }
  function confirmReplacement() {
    if (job) throw new Error('請等待試聽準備完成，或先取消目前工作')
    if (!replacement) throw new Error('請先選擇並準備要接受的試聽')
    checkReplacementOwner(replacement.owner)
    // Re-read the visible field so uncommitted keyboard edits cannot confirm a
    // different offset than the one the user sees. Validation is still atomic.
    const next = replacement.kind === 'gain-regions' ? replacement.project : replacementProject(replacement, replacement.kind === 'transpose' ? replacement.offsetSeconds : replacementOffset())
    if (retainedBytes() > DAW_LIMITS.maxCombinedBytes) throw new Error('接受音訊會超出記憶體預算；原片段保持不變')
    const staged = replacement
    history.push(next)
    invalidate(); project = next; buffers = staged.buffers; files = staged.files
    retainHistoryAssets(); render(); status(staged.kind === 'gain-regions' ? '已接受人聲區間；播放、WAV 與工程都會套用。可一次復原，原音仍保留' : staged.kind === 'transpose' ? '已接受移調，位置、長度與音量曲線保持不變；可復原／重做，原錄音仍保留' : '已替換錄音，位置、長度與音量曲線保持不變；可復原／重做。ZIP 可能包含完整新舊錄音')
  }
  async function previewReplacement(useReplacement) {
    if (pendingAudition) throw new Error('上一份試聽仍在結束，請稍候再試')
    if (!replacement?.project) throw new Error('請先選擇有效的設定並準備試聽')
    const staged = replacement
    checkReplacementOwner(staged.owner)
    // Input events can precede change/blur; always preview the displayed range.
    if (staged.kind !== 'gain-regions') {
      const offset = staged.kind === 'transpose' ? staged.offsetSeconds : replacementOffset()
      if (staged.project.tracks.find(track => track.id === staged.owner.trackId).clips.find(clip => clip.id === staged.owner.clipId).offsetSeconds !== offset) updateReplacementOffset()
    }
    stop()
    // beforePlayback/resume can outlive Cancel; keep the staged map's retained
    // data counted until this asynchronous chain actually settles. Native work
    // retains its own ledger separately if its cancellation wins a race.
    const reserved = decodedBytes(staged.buffers) + [...staged.files.values()].reduce((sum, file) => sum + file.size, 0) + replacementBytes()
    const audition = { staged, bytes: reserved }; pendingAudition = audition
    try { await withJob('audition', async request => {
      const check = () => { request.check(); checkReplacementOwner(staged.owner); if (replacement !== staged) throw abortError() }
      await beforePlayback?.(); check()
      const ctx = getContext(); await ctx.resume(); check()
      let result
      if (useReplacement) {
        if (!staged.mix) {
          const renderBytes = Math.ceil(duration() * project.sampleRate) * 2 * 4
          if (retainedBytes() + renderBytes * 2 > DAW_LIMITS.maxCombinedBytes) throw new Error('替換試聽與瀏覽器混音副本會超出記憶體預算；請縮短錄音或時間軸')
          status(staged.kind === 'gain-regions' ? '正在準備人聲區間混音試聽；尚未接受…' : '正在準備替換後的混音試聽；尚未套用…')
          const rendered = await renderProject(staged.project, staged.buffers, { signal: request.signal, isCurrent: () => replacement === staged && project === staged.owner.snapshot && selectionVersion === staged.owner.selectionVersion })
          check(); staged.mix = rendered
        }
        result = staged.mix
      } else result = await getMix({ ...request, check })
      request.retainBuffer(result.buffer, true)
      check()
      assertSafePlayback(result)
      const clip = selected().clip, start = staged.kind === 'gain-regions' ? staged.plan.timelineRange.startSeconds : clip.atSeconds, end = staged.kind === 'gain-regions' ? Math.min(duration(), staged.plan.timelineRange.endSeconds) : start + clip.durationSeconds
      source = ctx.createBufferSource(); source.buffer = result.buffer; source.connect(ctx.destination)
      playback = { start, end, loop: false, started: ctx.currentTime }; cursor = start
      const activeSource = source
      source.onended = () => { if (source === activeSource) { cursor = end; source.disconnect(); source = null; playback = null; button('play').textContent = '播放混音'; refreshControls(); paintPlayhead() } }
      source.start(0, start, end - start); button('play').textContent = '暫停'
      status(useReplacement ? `B：正在試聽${staged.kind === 'gain-regions' ? '人聲區間調整' : staged.kind === 'transpose' ? '處理' : '替換'}後的完整混音；尚未確認套用` : 'A：正在試聽目前原錄音的完整混音')
      paintPlayhead()
    }) } finally { if (pendingAudition === audition) pendingAudition = null; refreshControls() }
  }
  async function openArchive(file) {
    if (!file) return
    if (loadWorkPending) throw new Error('上一批音檔或工程仍在讀取或背景解碼，請稍候再試；原專案仍保留')
    if ((dirty() || project.assets.length) && !await confirmAction('開啟工程會取代此多軌專案與復原紀錄。尚未下載的修改將遺失；要繼續嗎？')) return
    discardReplacement()
    return withJob('open', async ({ signal, check }) => {
      const beforeLoadBytes = retainedBytes()
      // Before the manifest is trusted, only bounded headers and its two JSON
      // representations may be read. The importer supplies the decoded estimate
      // before it starts reading or decoding any media entry.
      const reservation = reserveLoad(Math.min(file.size, ARCHIVE_LIMITS.archiveBytes) + 2 * ARCHIVE_LIMITS.manifestBytes)
      try {
        status('正在檢查工程與原始音檔…')
        const restored = await importProjectArchive(file, { signal,
          decodeAsset: (bytes, metadata, options) => decode(bytes, metadata, options.signal, reservation.trackNative),
          retainedBytes: beforeLoadBytes,
          onMemoryBudget: bytes => reservation.set(bytes + 2 * ARCHIVE_LIMITS.manifestBytes),
          onProgress: value => { check(); status(`正在還原工程：${value.phase} ${value.completed}/${value.total}`) },
        })
        check(); const nextHistory = new ProjectHistory(restored.project)
        invalidate(); project = restored.project; files = restored.files; buffers = restored.buffers; history = nextHistory
        clipSelection.reset(); selectionHistory.clear(); syncSelection()
        saved = JSON.stringify(project); hasDownloaded = false; hasProjectDocument = true; cursor = 0; resetRegionMapping()
        // A restored document has no selected clips. Do not carry an old
        // focused clip/control ID into renderTracks, which would focus and
        // select a same-ID replacement from the new document.
        if (!root.hidden && el('timeline').contains(document.activeElement)) el('timeline').focus({ preventScroll: true })
        render(); status('工程已還原，音檔、剪輯與混音設定可繼續修改')
      } finally { reservation.finish() }
    })
  }
  async function getMix({ signal, check, retainBuffer }) {
    if (mix) { retainBuffer?.(mix.buffer, true); return mix }
    const snapshot = project
    const renderBytes = Math.ceil(duration() * project.sampleRate) * 2 * 4
    if (retainedBytes() + renderBytes * 2 > DAW_LIMITS.maxCombinedBytes) throw new Error('原檔、復原音訊、混音與瀏覽器副本合計超出記憶體預算；請縮短時間軸或降低混音取樣率')
    status('正在合成目前專案混音…')
    const result = await renderProject(snapshot, buffers, { signal, isCurrent: () => !destroyed && project === snapshot })
    check(); if (project !== snapshot) throw abortError()
    mix = result; retainBuffer?.(result.buffer, true)
    const db = value => Number.isFinite(value) ? `${value.toFixed(2)} dBFS` : '−∞ dBFS'
    el('render-info').textContent = `第 ${result.revision} 版 · ${project.sampleRate / 1000} kHz · 採樣峰值 ${db(result.peaks?.samplePeakDb ?? 20 * Math.log10(result.peak))} · 估計 True Peak（4×）${db(result.peaks?.truePeakDb)}。${result.peak > 1 || result.peaks?.truePeakDb > 0 ? '有過載，請降低總混音音量後重試' : 'WAV 輸出不會自動增減音量'}`
    return result
  }
  function assertSafePlayback(result) {
    if (result.peak > 1 || result.peaks?.samplePeakDb > 0 || result.peaks?.truePeakDb > 0) {
      const guidance = replacement?.kind === 'transpose'
        ? '請取消並保留原音，降低片段或總音量後重新產生試聽'
        : '請降低片段或總混音音量後重新試聽'
      throw new Error(`混音峰值超過 0 dBFS，已停止試聽；未自動截幅或降低音量。${guidance}`)
    }
  }
  async function getSelectionMix(request) {
    const snapshot = project, full = await getMix(request)
    request.check()
    if (!selectionMix || selectionMix.snapshot !== snapshot || selectionMix.view.buffer !== full.buffer) {
      const view = await selectedRenderView(snapshot, full, { signal: request.signal,
        isCurrent: () => request.isCurrent() && project === snapshot && mix === full })
      request.check()
      const description = { ...view }; delete description.channels
      selectionMix = { snapshot, view: description }
    }
    const view = selectionMix.view
    // AudioBufferSourceNode.start() acquires buffer contents and may detach
    // earlier getChannelData arrays. Cache metadata/peaks, then reacquire views
    // for each use; never export channel views retained across playback.
    const channels = Array.from({ length: view.buffer.numberOfChannels }, (_, index) => {
      const data = view.buffer.getChannelData(index)
      if (!(data instanceof Float32Array) || data.length !== view.buffer.length) throw new Error('選區混音樣本不可用，請重新產生')
      return data.subarray(view.firstFrame, view.lastFrame)
    })
    return { ...view, channels }
  }
  async function play({ rangeOnly = false, loopRange = false } = {}) {
    if (noteReference) stopNoteReference()
    if (source) { stop(); if (!rangeOnly) return }
    if (!duration() || root.hidden) return
    await withJob('render', async request => {
      await beforePlayback?.(); request.check()
      const ctx = getContext(); await ctx.resume(); request.check()
      const result = rangeOnly ? await getSelectionMix(request) : await getMix(request); request.check()
      assertSafePlayback(result)
      const item = selected(), group = clipSelection.refs.length > 1 ? describeClipGroup(project, clipSelection.refs) : null
      const looping = rangeOnly ? loopRange : el('loop').checked
      if (looping && !rangeOnly && !item && !group) throw new Error('循環試聽前請先選取片段')
      const start = rangeOnly ? result.startSeconds : looping ? group?.startSeconds ?? item.clip.atSeconds : cursor >= duration() ? 0 : cursor
      const end = rangeOnly ? result.endSeconds : looping ? group?.endSeconds ?? item.clip.atSeconds + item.clip.durationSeconds : duration()
      source = ctx.createBufferSource(); source.buffer = result.buffer; source.connect(ctx.destination)
      playback = { start, end, loop: looping, started: ctx.currentTime }; cursor = start
      if (looping) { source.loop = true; source.loopStart = start; source.loopEnd = end }
      const activeSource = source
      source.onended = () => { if (source === activeSource) { cursor = end; source.disconnect(); source = null; playback = null; if (frame !== null) cancelAnimationFrame(frame); frame = null; button('play').textContent = '播放混音'; refreshControls(); paintPlayhead() } }
      if (looping) source.start(0, start); else source.start(0, start, end - start)
      button('play').textContent = '暫停'
      status(rangeOnly ? (looping ? '正在循環時間軸選區的完整混音' : '正在播放時間軸選區的完整混音') : looping ? '正在循環所選片段的完整混音' : '正在播放目前專案混音'); paintPlayhead()
    })
  }
  async function exportMix(toMaster = false, rangeOnly = false) {
    if (toMaster && rangeOnly) throw new Error('送往母帶目前使用完整混音；選區可另存 WAV')
    const transferred = await withJob(toMaster ? 'transfer' : 'render', async request => {
      const result = rangeOnly ? await getSelectionMix(request) : await getMix(request); request.check()
      const bitDepth = toMaster ? 24 : Number(el('bit-depth').value)
      const encodedBytes = (rangeOnly ? result.length : result.buffer.length) * result.buffer.numberOfChannels * bitDepth / 8 + 44
      request.reserveBytes(encodedBytes * 2, 'WAV 編碼會超出編輯器的保守記憶體預算（含下載副本）；請縮短時間軸或降低混音取樣率')
      if (toMaster) {
        const accepted = await onSendToMaster(result.buffer, { name: project.name, revision: project.revision, signal: request.signal, isCurrent: request.isCurrent })
        request.check()
        if (accepted !== true) throw new Error('母帶頁尚未確認載入成功；多軌工程仍保留')
        status('已將完整混音送往母帶處理')
        return true
      }
      else {
        if (result.peak > 1 || result.peaks?.samplePeakDb > 0 || result.peaks?.truePeakDb > 0) throw new Error('混音採樣峰值或估計 True Peak 超過 0 dBFS，已停止 WAV 輸出。請降低「總混音音量」後重新試聽／匯出')
        const channels = rangeOnly ? result.channels : Array.from({ length: result.buffer.numberOfChannels }, (_, index) => result.buffer.getChannelData(index))
        const wav = encodeWAV(channels, result.buffer.sampleRate, Number(el('bit-depth').value))
        // Let a Cancel/edit queued during synchronous encoding win before the
        // external download handoff. Original PCM and project remain untouched.
        await new Promise(resolve => setTimeout(resolve, 0)); request.check()
        const suffix = rangeOnly ? `range-${result.firstFrame}-${result.lastFrame}` : 'mix'
        downloadFile(new Blob([wav], { type: 'audio/wav' }), `${project.name.replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'mix'}-${suffix}.wav`)
        status(`已交付下載：${rangeOnly ? `時間軸選區 ${formatDawTime(result.startSeconds)}–${formatDawTime(result.endSeconds)}` : '完整立體聲混音'} WAV · ${result.buffer.sampleRate / 1000} kHz · ${el('bit-depth').value}-bit；工程仍留在本頁`)
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
      downloadFile(blob, archiveFileName(snapshot)); saved = snapshotJson; hasDownloaded = true; hasProjectDocument = true
      status(project === snapshot ? '工程已交付下載，請確認檔案已存好。分享 ZIP 也會分享其中完整原始音檔' : '已下載開始打包時的版本；後續修改尚未保存，請再下載一次')
    })
  }
  function clear() {
    discardReplacement(); cancelJob(); stop({ rewind: true }); generation++
    project = createProject({ name: '未命名專案' }); history = new ProjectHistory(project)
    buffers.clear(); files.clear(); mix = null; selectionMix = null; clipSelection.reset(); selectionHistory.clear(); syncSelection(); drag = null; groupControls?.cancel(); saved = JSON.stringify(project); hasDownloaded = false; hasProjectDocument = false; resetRegionMapping()
    el('audio-files').value = ''; el('project-file').value = ''; el('replacement-file').value = ''; el('replacement-offset').value = '0'; render(); status('已清除此多軌專案與復原紀錄。裝置上的原檔與下載檔仍保留')
  }
  function choose(trackId, clipId, options = {}) {
    const clip = project.tracks.find(track => track.id === trackId)?.clips.find(clip => clip.id === clipId)
    if (!clip) return
    automationDrag = null
    const version = clipSelection.version
    clipSelection.select({ trackId, clipId }, options)
    if (clipSelection.version !== version) selectionChanged()
    stop(); cursor = clip.atSeconds; renderInspector(); paintPlayhead()
  }
  function setMultiMode(enabled) {
    clipSelection.setMode(enabled); selectionChanged()
    status(enabled ? '多選已開啟；點選片段加入或取消，整組保留間距與音軌' : '已結束多選')
  }
  function groupContextCurrent(context) {
    return !destroyed && !root.hidden && !job && context.owner.projectId === project.id && context.owner.revision === project.revision &&
      context.owner.selectionVersion === clipSelection.version && context.owner.sourceVersion === generation &&
      JSON.stringify(context.refs) === JSON.stringify(clipSelection.refs)
  }
  function moveGroupTo(atSeconds, context) {
    if (!groupContextCurrent(context)) throw abortError()
    const group = describeClipGroup(project, context.refs), deltaSeconds = atSeconds - group.startSeconds
    if (!deltaSeconds) return
    try {
      command({ type: 'clips.move', refs: context.refs, deltaSeconds, allowOverlap: context.allowOverlap }, `已移動 ${group.count} 個片段；可一次復原`)
    } catch (error) {
      if (error.code === 'CLIP_GROUP_OVERLAP') error.message = `會和同軌其他片段重疊（${error.overlaps.length} 處）；位置未改變。若要疊加聲音，請勾選「這次允許重疊」後套用數字位置`
      throw error
    }
  }
  function nudgeGroup(direction, context) {
    if (!groupContextCurrent(context)) throw abortError()
    const group = describeClipGroup(project, context.refs), maximum = group.startSeconds + group.maxDeltaSeconds
    const atSeconds = el('snap').checked
      ? nextDawGridTime(group.startSeconds, direction, project.tempo, Number(el('grid').value), getDawGridOrigin(project), maximum)
      : clamp(group.startSeconds + direction * .01, 0, maximum)
    moveGroupTo(atSeconds, context)
  }
  function captureGroupContext() {
    return { refs: clipSelection.refs, allowOverlap: false, owner: { projectId: project.id, revision: project.revision, selectionVersion: clipSelection.version, sourceVersion: generation } }
  }
  function duplicateGroup(context) {
    if (!groupContextCurrent(context)) throw abortError()
    if (project.tracks.reduce((sum, track) => sum + track.clips.length, 0) + context.refs.length > DAW_LIMITS.maxClips) throw new Error('複製後會超過 256 個片段；目前工程保持不變')
    if (describeClipGroup(project, context.refs).durationSeconds + duration() > DAW_LIMITS.maxDurationSeconds) throw new Error('複製到尾端會超過 10 分鐘；目前工程保持不變')
    const plan = planClipGroupDuplicate(project, context.refs, { snapEnabled: el('snap').checked, gridBeats: Number(el('grid').value) })
    const newIds = context.refs.map(() => generateId('clip')), refs = context.refs.map((ref, index) => ({ trackId: ref.trackId, clipId: newIds[index] }))
    command({ type: 'clips.duplicate', refs: context.refs, deltaSeconds: plan.deltaSeconds, newIds }, `已複製 ${refs.length} 個片段到專案尾端；原音檔共用，不增加音訊副本`, { mode: true, refs, primary: refs.at(-1) })
  }
  function removeGroup(context) {
    if (!groupContextCurrent(context)) throw abortError()
    command({ type: 'clips.remove', refs: context.refs }, `已刪除 ${context.refs.length} 個片段；可一次復原，原音檔仍保留`)
  }
  function nudge(direction) {
    const item = selected(); if (!item) return
    const maximum = DAW_LIMITS.maxDurationSeconds - item.clip.durationSeconds
    const atSeconds = el('snap').checked
      ? nextDawGridTime(item.clip.atSeconds, direction, project.tempo, Number(el('grid').value), getDawGridOrigin(project), maximum)
      : clamp(item.clip.atSeconds + direction * .01, 0, maximum)
    if (atSeconds === item.clip.atSeconds) { status(direction < 0 ? '已到時間軸起點' : '已到工程長度上限'); return }
    clipCommand('clip.move', { atSeconds }, direction < 0 ? '已把片段提早' : '已把片段延後')
  }
  const actions = {
    'multi-select': () => setMultiMode(!clipSelection.mode),
    'note-center-analyze': analyzeNoteCenter, 'note-center-render': prepareCenteredNote, 'note-center-reference': playNoteReference,
    'region-designate': designateVocalTrack, 'region-use-lyric': useLyricRegion, 'region-prepare': prepareGainRegions,
    'region-remove': () => clipCommand('clip.gainRegion.remove', { regionId }, '已刪除此人聲區間；可復原'),
    'region-reset': () => clipCommand('clip.gainRegion.reset', {}, '已清除此片段的人聲區間；可一次復原'),
    'transpose-render': prepareTranspose, 'transpose-original': restoreTransposeOriginal,
    replace: () => { discardReplacement(); replacementOwner = captureReplacementOwner(); el('replacement-file').click() },
    'replacement-confirm': confirmReplacement, 'replacement-cancel': () => discardReplacement('已取消；原片段保持不變'),
    'replacement-original': () => previewReplacement(false), 'replacement-preview': () => previewReplacement(true),
    import: () => el('audio-files').click(), open: () => el('project-file').click(), save: saveArchive,
    clear: async () => { if (await confirmAction('清除此多軌專案、音訊與全部復原紀錄？尚未下載的修改會遺失。裝置原檔、下載檔、母帶與歌詞不會刪除。')) clear() },
    cancel: () => cancelJob(), undo: () => changeHistory('undo'), redo: () => changeHistory('redo'),
    'add-track': () => command({ type: 'track.add', track: { name: `音軌 ${project.tracks.length + 1}` } }, '已新增空白音軌'),
    earlier: () => nudge(-1), later: () => nudge(1),
    'automation-add': addAutomationPoint, 'automation-apply': applyAutomationPoint,
    'automation-remove': () => clipCommand('clip.automation.remove', { index: automationIndex }, '已刪除中間音量點；相鄰點會平滑連接'),
    'automation-reset': () => clipCommand('clip.automation.reset', {}, '已重設句內音量為 100%；片段音量與淡入淡出仍保留'),
    move: () => { const item = selected(); if (!item) return; const ref = { trackId: el('clip-track').value, clipId: item.clip.id }; command({ type: 'clip.move', trackId: item.track.id, clipId: item.clip.id, atSeconds: snap(Number(el('clip-at').value)), toTrackId: ref.trackId }, '已套用片段位置', { mode: false, refs: [ref], primary: ref }) },
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
    if (clip) { if (drag) return; if (!suppressClick) choose(clip.dataset.trackId, clip.dataset.clipId, { toggle: event.shiftKey || clipSelection.mode }); suppressClick = false; return }
    const lane = event.target.closest('[data-seek-lane]')
    if (lane) { stop(); cursor = clamp((event.clientX - lane.getBoundingClientRect().left) / Number(el('zoom').value), 0, duration()); paintPlayhead(); refreshControls() }
  })
  listen(root, 'change', event => run(async () => {
    const target = event.target, id = target.id
    if (id === 'daw-audio-files') { try { await importFiles(target.files) } finally { target.value = '' } }
    else if (id === 'daw-replacement-file') {
      const owner = replacementOwner; replacementOwner = null
      try { if (owner && target.files?.[0]) await prepareReplacement(target.files[0], owner) } finally { target.value = '' }
    }
    else if (id === 'daw-region-select') { discardReplacement(); regionId = target.value; regionControlOwner = null; renderRegions(selected()); refreshControls() }
    else if (id === 'daw-replacement-offset') updateReplacementOffset()
    else if (id === 'daw-note-center-target') { discardReplacement('目標音已修改，請重新產生試聽'); stopNoteReference(); updateNoteProposal() }
    else if (id === 'daw-project-file') { try { await openArchive(target.files?.[0]) } finally { target.value = '' } }
    else if (id === 'daw-name') command({ type: 'project.update', patch: { name: target.value.trim() } }, '已更新專案名稱')
    else if (id === 'daw-tempo') command({ type: 'project.update', patch: { tempo: Number(target.value) } }, '已更新拍格；錄音速度與音高不變')
    else if (id === 'daw-sample-rate') command({ type: 'project.update', patch: { sampleRate: Number(target.value) } }, '混音取樣率已更新，請重新產生混音')
    else if (id === 'daw-master-gain') command({ type: 'project.update', patch: { masterGainDb: Number(target.value) } }, '總混音音量已更新，試聽與輸出都會套用')
    else if (id === 'daw-clip-name') clipCommand('clip.update', { patch: { name: target.value.trim() } }, '已更新片段名稱')
    else if (id === 'daw-automation-point') { automationDrag = null; automationIndex = Number(target.value); renderAutomation() }
    else if (id === 'daw-clip-gain') clipCommand('clip.update', { patch: { gainDb: Number(target.value) } }, '已更新片段音量')
    else if (['daw-zoom', 'daw-grid', 'daw-snap'].includes(id)) { drag = null; groupControls?.cancel(); renderTracks(); paintPlayhead() }
    else if (id === 'daw-loop') { stop(); refreshControls() }
    else if (target.matches('input[data-track-control]')) command({ type: 'track.update', trackId: target.dataset.trackId, patch: { [target.dataset.trackControl]: Number(target.value) } }, '已更新音軌混音設定')
  }))
  for (const eventName of ['input', 'change']) listen(root, eventName, event => {
    if (event.target.id?.startsWith('daw-region-') && event.target.matches('input')) {
      regionVersion++
      if (replacement?.kind === 'gain-regions') discardReplacement('區間設定已修改，請重新準備試聽')
      if (event.target.id === 'daw-region-offset' && lyricDraft) {
        lyricDraft = null; el('region-start').value = ''; el('region-end').value = '';
        el('region-range').textContent = '對齊已修改，請重新帶入歌詞句子，或手動填入時間軸範圍'
      }
    }
    if (event.target.id?.startsWith('daw-transpose-')) {
      resetNoteCentering()
      transposeVersion++
      if (replacement?.kind === 'transpose' || job?.kind === 'transpose') discardReplacement('移調設定已修改，請重新產生試聽')
    }
  })
  listen(el('seek'), 'input', () => { const next = Number(el('seek').value); stop(); cursor = next; paintPlayhead(); refreshControls() })
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); drag = null; renderTracks(); paintPlayhead(); status('已取消拖曳；片段位置保持不變'); return }
    if (event.key === 'Escape' && automationDrag) { automationDrag = null; renderAutomation(); return }
    if (event.defaultPrevented || event.isComposing || event.target.matches('input,textarea,select,[contenteditable=true]')) return
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape' && clipSelection.mode) { event.preventDefault(); setMultiMode(false) }
    else if (mod && event.key.toLowerCase() === 'a' && el('timeline').contains(event.target)) { event.preventDefault(); if (!job) { clipSelection.selectAll(project); selectionChanged() } }
    else if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); changeHistory(event.shiftKey ? 'redo' : 'undo') }
    else if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); changeHistory('redo') }
    else if (event.code === 'Space' && !event.target.closest('button,summary')) { event.preventDefault(); run(play) }
    else if ((event.target.closest('.daw-clip') || event.target === el('timeline') && clipSelection.refs.length > 1) && ['ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(event.key)) {
      event.preventDefault()
      if (clipSelection.refs.length > 1) {
        const context = captureGroupContext()
        run(() => event.key.startsWith('Arrow') ? nudgeGroup(event.key === 'ArrowLeft' ? -1 : 1, context) : removeGroup(context))
      } else run(() => event.key.startsWith('Arrow') ? nudge(event.key === 'ArrowLeft' ? -1 : 1) : actions.delete())
    }
  })
  listen(root, 'focusin', event => {
    const clip = event.target.closest('.daw-clip')
    if (clip && !drag && !clipSelection.mode && clip.dataset.clipId !== selection?.clipId) choose(clip.dataset.trackId, clip.dataset.clipId)
  })
  listen(root, 'pointerdown', event => {
    // A second touch/pen must not replace the first gesture's owner or leave
    // its preview positions behind. Other pointer types can also be primary.
    if (event.isPrimary === false || drag && drag.pointerId !== event.pointerId || automationDrag && automationDrag.pointerId !== event.pointerId) return
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
    const ref = { trackId: clip.dataset.trackId, clipId: clip.dataset.clipId }, additive = event.shiftKey || clipSelection.mode
    const toggleOnRelease = additive && isSelected(ref.trackId, ref.clipId)
    if (!toggleOnRelease) choose(ref.trackId, ref.clipId, { additive })
    const group = describeClipGroup(project, clipSelection.refs)
    drag = { ...ref, x: event.clientX, pointerId: event.pointerId, at: group.startSeconds, moved: false,
      context: captureGroupContext(), grid: gridKey(), minDelta: group.minDeltaSeconds, maxDelta: group.maxDeltaSeconds,
      toggleOnRelease, group: group.count > 1 }
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
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!groupContextCurrent(drag.context) || drag.grid !== gridKey()) { drag = null; renderTracks(); return }
    if (Math.abs(event.clientX - drag.x) < 4 && !drag.moved) return
    drag.moved = true
    const rate = Number(el('zoom').value)
    drag.deltaSeconds = clamp(snap(drag.at + (event.clientX - drag.x) / rate) - drag.at, drag.minDelta, drag.maxDelta)
    for (const ref of drag.context.refs) {
      const clip = [...root.querySelectorAll('.daw-clip')].find(c => c.dataset.clipId === ref.clipId)
      const original = project.tracks.find(track => track.id === ref.trackId)?.clips.find(clip => clip.id === ref.clipId)
      if (clip && original) clip.style.left = `${(original.atSeconds + drag.deltaSeconds) * rate}px`
    }
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
    if (!drag || event.pointerId !== drag.pointerId) return
    const previous = drag; drag = null
    suppressClick = true; setTimeout(() => { suppressClick = false }, 0)
    if (!groupContextCurrent(previous.context) || previous.grid !== gridKey()) { renderTracks(); return }
    if (!previous.moved) {
      if (previous.toggleOnRelease) choose(previous.trackId, previous.clipId, { toggle: true })
      return
    }
    run(() => {
      if (!groupContextCurrent(previous.context) || previous.grid !== gridKey()) return
      if (previous.group) { moveGroupTo(previous.at + previous.deltaSeconds, previous.context); return }
      const target = document.elementFromPoint?.(event.clientX, event.clientY)?.closest('.daw-lane')
      const ref = { trackId: target?.dataset.trackId || previous.trackId, clipId: previous.clipId }
      command({ type: 'clip.move', trackId: previous.trackId, clipId: previous.clipId, toTrackId: ref.trackId, atSeconds: previous.at + previous.deltaSeconds }, '已移動片段；這次拖曳可一次復原', { mode: clipSelection.mode, refs: [ref], primary: ref })
    }).finally(() => { renderTracks(); paintPlayhead() })
  })
  listen(window, 'pointercancel', event => {
    let cancelled = false
    if (drag && (event.pointerId === undefined || drag.pointerId === event.pointerId)) { drag = null; cancelled = true }
    if (automationDrag && (event.pointerId === undefined || automationDrag.pointerId === event.pointerId)) { automationDrag = null; cancelled = true }
    if (cancelled) { renderAutomation(); renderTracks(); paintPlayhead() }
  })
  listen(el('timeline'), 'dragover', event => { event.preventDefault(); el('timeline').dataset.drop = 'true' })
  listen(el('timeline'), 'dragleave', () => { el('timeline').dataset.drop = 'false' })
  listen(el('timeline'), 'drop', event => { event.preventDefault(); el('timeline').dataset.drop = 'false'; run(() => importFiles(event.dataTransfer?.files || [])) })
  listen(document, 'wf:mode-change', event => { if (event.detail?.mode !== 'editor') { drag = null; groupControls?.cancel(); selectionControls?.cancel(); tempoControls?.cancel(); resetNoteCentering(); selectionVersion++; discardReplacement('已切換工作區，待接受的試聽已取消'); automationDrag = null; renderAutomation(); renderTracks(); stop(); if (job && ['render', 'transfer', 'note-analysis', 'note-reference'].includes(job.kind)) cancelJob('已切換工作區；可回來繼續編輯') } })
  listen(window, 'beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = '' } })
  function destroy() {
    if (destroyed) return
    destroyed = true; drag = null; discardReplacement(); cancelJob(); resetNoteCentering(); pitchClient?.dispose(); selectionControls?.destroy(); tempoControls?.destroy(); groupControls?.destroy(); clipSelection.reset(); selectionHistory.clear(); stop(); disposers.forEach(dispose => dispose()); buffers.clear(); files.clear(); mix = null; selectionMix = null
    if (context) { context.close().catch(() => {}); context = null }
  }
  listen(window, 'pagehide', event => { if (event.persisted) { drag = null; groupControls?.cancel(); selectionControls?.cancel(); tempoControls?.cancel(); resetNoteCentering(); selectionVersion++; discardReplacement(); cancelJob(); renderTracks(); stop() } else destroy() })
  observedLyricKey = lyricSelectionKey(readLyricSelection())
  if (subscribeLyricSelection) {
    const unsubscribe = subscribeLyricSelection(onLyricSelectionChange)
    if (typeof unsubscribe === 'function') disposers.push(unsubscribe)
  }
  selectionControls = createTimelineSelectionControls({ root, getProject: () => project, isBusy: () => Boolean(job),
    getZoom: () => Number(el('zoom').value), snapTime: snap,
    commitSelection: range => command({ type: 'timelineSelection.set', selection: range }, '已設定時間軸選區；可試聽、循環或另存 WAV'),
    clearSelection: () => command({ type: 'timelineSelection.clear' }, '已清除時間軸選區；片段與聲音保持不變'),
    playSelection: ({ loop = false } = {}) => run(() => play({ rangeOnly: true, loopRange: loop })),
    exportSelection: () => run(() => exportMix(false, true)), onStatus: status })
  tempoControls = createTempoControls({ root: el('tempo-tools'), getProject: () => project,
    isBusy: () => Boolean(job), getCurrentTime: currentTime,
    applyGridPatch: patch => command({ type: 'project.update', patch }, '已更新拍格；錄音速度與音高不變'), onStatus: status })
  groupControls = createClipGroupControls({ host: el('group-tools'), getProject: () => project,
    getSelection: () => clipSelection, isBusy: () => Boolean(job), getOwnerVersion: () => generation,
    getGridInfo: () => ({ stepSeconds: el('snap').checked ? gridStep() : .01, snapEnabled: el('snap').checked, version: gridKey() }),
    moveTo: moveGroupTo, nudge: nudgeGroup, duplicateToEnd: duplicateGroup, remove: removeGroup,
    clear: context => { if (groupContextCurrent(context)) { clipSelection.clear(); selectionChanged() } },
    exit: context => { if (groupContextCurrent(context)) setMultiMode(false) }, onStatus: status })
  rememberSelection()
  for (let midi = 24; midi <= 95; midi++) {
    const option = node('option', '', midiToNote(midi)); option.value = String(midi); el('note-center-target').append(option)
  }
  render()
  return { prepareGainRegions, analyzeNoteCenter, prepareCenteredNote, clear, stop, destroy, importFiles, openArchive, prepareReplacement, prepareTranspose, confirmReplacement, getProject: () => JSON.parse(JSON.stringify(project)) }
}
