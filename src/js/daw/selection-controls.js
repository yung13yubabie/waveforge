import { getProjectDuration, validateTimelineSelection } from './project.js'

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const equal = (a, b) => a?.startSeconds === b?.startSeconds && a?.endSeconds === b?.endSeconds
const timeLabel = value => `${Number(value.toFixed(3))} 秒`

/** UI only. getProject returns the live project reference; audio and history
 * belong to the caller. Call render after rebuilding timeline children or
 * changing job state, cancel on navigation, and destroy with the panel.
 * Numeric entry is exact; pointer/keyboard endpoints use the caller's grid. */
export function createTimelineSelectionControls({ root, getProject, isBusy = () => false,
  getZoom, snapTime = value => value, commitSelection, clearSelection,
  playSelection, exportSelection, onStatus = () => {} }) {
  const timeline = root?.querySelector('#daw-timeline')
  if (!timeline) throw new Error('Timeline selection requires #daw-timeline')
  for (const callback of [getProject, getZoom, commitSelection, clearSelection, playSelection, exportSelection]) {
    if (typeof callback !== 'function') throw new TypeError('Timeline selection requires its project and action callbacks')
  }
  const doc = root.ownerDocument, win = doc.defaultView
  const disposers = []
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options)
    disposers.push(() => target.removeEventListener(type, handler, options))
  }
  const node = (tag, className, text) => {
    const element = doc.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
  const bar = node('div', 'daw-selection-controls')
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', '時間軸範圍')
  const button = (action, text, label = text) => {
    const element = node('button', '', text)
    element.type = 'button'; element.dataset.rangeAction = action; element.setAttribute('aria-label', label)
    return element
  }
  const drawButton = button('draw', '選範圍', '在時間軸拖曳選取範圍')
  drawButton.setAttribute('aria-pressed', 'false')
  const summary = node('span', 'daw-selection-summary')
  summary.setAttribute('aria-live', 'polite'); summary.setAttribute('aria-atomic', 'true')
  const details = node('details', 'daw-selection-details')
  details.append(node('summary', '', '起訖秒數'))
  const fields = node('div', 'daw-selection-fields')
  const inputs = {}
  for (const [key, text] of [['startSeconds', '起點（秒）'], ['endSeconds', '終點（秒）']]) {
    const label = node('label', '', text), input = node('input')
    input.type = 'number'; input.min = '0'; input.step = 'any'; input.inputMode = 'decimal'
    input.dataset.rangeEndpoint = key; input.setAttribute('aria-label', `範圍${text}`)
    label.append(input); fields.append(label); inputs[key] = input
  }
  fields.append(button('apply', '套用'))
  details.append(fields)
  const actions = node('div', 'daw-selection-actions')
  actions.append(button('play', '試聽', '試聽選取範圍'), button('loop', '循環', '循環播放選取範圍'),
    button('export', '範圍 WAV', '匯出選取範圍 WAV'), button('clear', '清除', '清除時間軸範圍'))
  bar.append(drawButton, summary, details, actions)
  // Keep the arrangement at the top of the editor. Range commands live directly
  // below its canvas instead of adding another setup row above the ruler.
  timeline.after(bar)
  let destroyed = false, drawing = false, drag = null, pending = false, fieldOwner = null, fieldsDirty = false
  let suppressClick = false, clickTimer = null
  const busy = () => pending || isBusy()
  // The reference catches project replacement; the recipe catches same-revision
  // source/selection edits and undo branches, including in-place mutations.
  const owner = () => { const project = getProject(); return { project, recipe: JSON.stringify(project) } }
  const current = value => !destroyed && !root.hidden && root.isConnected && !busy() &&
    getProject() === value.project && JSON.stringify(getProject()) === value.recipe
  const valid = (selection, project = getProject()) => {
    if (!selection) return false
    try { validateTimelineSelection(selection, getProjectDuration(project), project.sampleRate); return true } catch { return false }
  }
  const take = event => { event.preventDefault(); event.stopImmediatePropagation() }
  const markClick = () => {
    suppressClick = true
    if (clickTimer !== null) win.clearTimeout(clickTimer)
    clickTimer = win.setTimeout(() => { suppressClick = false; clickTimer = null }, 0)
  }
  function release(previous) {
    if (!previous) return
    try { if (timeline.hasPointerCapture?.(previous.pointerId)) timeline.releasePointerCapture(previous.pointerId) } catch { /* Already cancelled by the browser. */ }
  }
  function resetDrag() { const previous = drag; drag = null; release(previous) }
  function cancel() {
    if (destroyed) return
    if (drag) markClick()
    resetDrag(); drawing = false; fieldsDirty = false; fieldOwner = null; render()
  }
  function fail(error) { if (!destroyed && error?.name !== 'AbortError') onStatus(error?.message || String(error), true) }
  function perform(callback) {
    if (destroyed || busy() || root.hidden || !root.isConnected) return
    pending = true
    try {
      const result = callback()
      if (result && typeof result.then === 'function') {
        render()
        Promise.resolve(result).catch(fail).finally(() => { pending = false; render() })
      } else { pending = false; render() }
    } catch (error) { pending = false; fail(error); render() }
  }
  function commit(range, captured) {
    if (!current(captured) || !valid(range) || equal(range, getProject().timelineSelection)) { render(); return }
    fieldsDirty = false; fieldOwner = null
    perform(() => commitSelection({ ...range }))
  }
  function paint(range = drag?.preview || getProject().timelineSelection) {
    const zoom = Number(getZoom()), show = valid(range) && Number.isFinite(zoom) && zoom > 0
    for (const lane of timeline.querySelectorAll('.daw-ruler-lane, .daw-lane')) {
      let overlay = lane.querySelector(':scope > .daw-timeline-selection')
      if (!show) { overlay?.remove(); continue }
      if (!overlay) {
        overlay = node('div', 'daw-timeline-selection'); overlay.setAttribute('aria-hidden', 'true'); lane.append(overlay)
      }
      overlay.style.left = `${range.startSeconds * zoom}px`
      overlay.style.width = `${(range.endSeconds - range.startSeconds) * zoom}px`
      overlay.dataset.preview = String(Boolean(drag))
    }
    // Only the ruler owns interactive handles; lanes retain clip interactions.
    timeline.classList.toggle('daw-selection-tight', show && range.endSeconds * zoom < 44)
    const ruler = timeline.querySelector('.daw-ruler-lane')
    if (!ruler) return
    for (const [endpoint, label] of [['startSeconds', '範圍起點'], ['endSeconds', '範圍終點']]) {
      let handle = ruler.querySelector(`[data-range-handle="${endpoint}"]`)
      if (!show) { handle?.remove(); continue }
      if (!handle) {
        handle = node('button', 'daw-selection-handle')
        handle.type = 'button'; handle.dataset.rangeHandle = endpoint; handle.setAttribute('role', 'slider')
        handle.setAttribute('aria-label', label); handle.setAttribute('aria-orientation', 'horizontal')
        ruler.append(handle)
      }
      const frame = 1 / getProject().sampleRate
      const edge = range[endpoint] * zoom
      const left = endpoint === 'startSeconds' ? Math.max(0, edge - 44) : edge
      handle.style.left = `${left}px`
      handle.style.setProperty('--daw-handle-mark', `${edge - left}px`)
      handle.disabled = busy()
      handle.setAttribute('aria-valuemin', String(endpoint === 'startSeconds' ? 0 : Math.min(getProjectDuration(getProject()), range.startSeconds + frame)))
      handle.setAttribute('aria-valuemax', String(endpoint === 'startSeconds' ? Math.max(0, range.endSeconds - frame) : getProjectDuration(getProject())))
      handle.setAttribute('aria-valuenow', String(range[endpoint]))
      handle.setAttribute('aria-valuetext', timeLabel(range[endpoint]))
    }
  }
  function render() {
    if (destroyed) return
    if (drag && (!current(drag.owner) || !drag.lane.isConnected || Number(getZoom()) !== drag.zoom)) resetDrag()
    const project = getProject(), range = project.timelineSelection, duration = getProjectDuration(project)
    const hasRange = valid(range), disabled = busy() || !duration
    if (disabled) drawing = false
    drawButton.setAttribute('aria-pressed', String(drawing)); drawButton.disabled = disabled
    timeline.classList.toggle('daw-selection-drawing', drawing)
    timeline.classList.toggle('daw-has-selection', hasRange || Boolean(drag))
    summary.textContent = drawing ? '拖曳選取 · Esc 取消' : hasRange ? `${timeLabel(range.startSeconds)} – ${timeLabel(range.endSeconds)}` : ''
    actions.hidden = !hasRange
    bar.querySelectorAll('button:not([data-range-action="draw"]), input').forEach(element => { element.disabled = disabled })
    for (const input of Object.values(inputs)) input.max = String(duration)
    if (!fieldsDirty || !fieldOwner || !current(fieldOwner)) {
      fieldsDirty = false; fieldOwner = null
      inputs.startSeconds.value = hasRange ? String(range.startSeconds) : '0'
      inputs.endSeconds.value = hasRange ? String(range.endSeconds) : String(duration)
    }
    paint()
  }
  function pointTime(clientX, lane) {
    // The live lane rect already includes horizontal scroll. Adding scrollLeft
    // a second time would make handles jump in a scrolled arrangement.
    return clamp(Number(snapTime((clientX - lane.getBoundingClientRect().left) / Number(getZoom()))), 0, getProjectDuration(getProject()))
  }
  function updatePreview(clientX) {
    if (!drag) return
    if (!current(drag.owner) || !drag.lane.isConnected || Number(getZoom()) !== drag.zoom) { resetDrag(); render(); return }
    drag.lastX = clientX
    const origin = drag.lane.getBoundingClientRect().left
    if (clientX === drag.firstX && origin === drag.firstLeft) {
      drag.preview = drag.endpoint ? { ...drag.original } : { startSeconds: drag.anchor, endSeconds: drag.anchor }
      paint(); return
    }
    const time = pointTime(clientX - drag.grabOffset, drag.lane)
    if (!Number.isFinite(time)) return
    if (drag.endpoint) {
      const range = { ...drag.original }, frame = 1 / getProject().sampleRate
      range[drag.endpoint] = drag.endpoint === 'startSeconds'
        ? clamp(time, 0, Math.max(0, range.endSeconds - frame))
        : clamp(time, Math.min(getProjectDuration(getProject()), range.startSeconds + frame), getProjectDuration(getProject()))
      drag.preview = range
    } else drag.preview = { startSeconds: Math.min(drag.anchor, time), endSeconds: Math.max(drag.anchor, time) }
    paint()
  }
  function applyFields() {
    const captured = fieldOwner || owner()
    if (!current(captured)) { fieldsDirty = false; render(); return }
    const range = { startSeconds: Number(inputs.startSeconds.value), endSeconds: Number(inputs.endSeconds.value) }
    if (!inputs.startSeconds.value.trim() || !inputs.endSeconds.value.trim() || !valid(range)) {
      onStatus('請填入有效起訖秒數；終點須晚於起點，且在專案長度內', true); return
    }
    commit(range, captured)
  }
  listen(bar, 'input', event => {
    if (!event.target.matches('[data-range-endpoint]')) return
    if (!fieldsDirty) fieldOwner = owner()
    fieldsDirty = true
  })
  listen(root, 'click', event => {
    const target = event.target.closest?.('[data-range-action]')
    if (target && bar.contains(target)) {
      take(event)
      if (target.disabled || busy()) return
      const action = target.dataset.rangeAction
      if (action === 'draw') { resetDrag(); drawing = !drawing; render(); return }
      if (action === 'apply') { applyFields(); return }
      if (!valid(getProject().timelineSelection)) return
      if (action === 'clear') { cancel(); perform(clearSelection) }
      if (action === 'play' || action === 'loop') perform(() => playSelection({ loop: action === 'loop' }))
      if (action === 'export') perform(exportSelection)
      return
    }
    const handle = event.target.closest?.('[data-range-handle]')
    if (handle && timeline.contains(handle) || timeline.contains(event.target) && (suppressClick || drawing && event.target.closest?.('.daw-ruler-lane, .daw-lane'))) take(event)
  }, true)
  listen(root, 'pointerdown', event => {
    const handle = event.target.closest?.('[data-range-handle]')
    const lane = event.target.closest?.('.daw-ruler-lane, .daw-lane')
    if (!lane || !timeline.contains(lane) || !handle && !drawing) return
    if (event.button !== undefined && event.button !== 0 || event.isPrimary === false) return
    take(event)
    if (drag || busy() || root.hidden || !getProjectDuration(getProject()) || handle?.disabled) return
    const zoom = Number(getZoom())
    if (!Number.isFinite(zoom) || zoom <= 0) return
    const captured = owner(), time = pointTime(event.clientX, lane)
    if (!Number.isFinite(time)) return
    drag = { owner: captured, lane, pointerId: event.pointerId, zoom, anchor: time, lastX: event.clientX,
      firstX: event.clientX, firstLeft: lane.getBoundingClientRect().left,
      grabOffset: handle ? event.clientX - lane.getBoundingClientRect().left - captured.project.timelineSelection[handle.dataset.rangeHandle] * zoom : 0,
      endpoint: handle?.dataset.rangeHandle, original: captured.project.timelineSelection ? { ...captured.project.timelineSelection } : null,
      preview: handle ? { ...captured.project.timelineSelection } : { startSeconds: time, endSeconds: time } }
    try { timeline.setPointerCapture?.(event.pointerId) } catch { /* Global listeners also cover mouse and touch. */ }
    handle?.focus({ preventScroll: true }); paint()
  }, true)
  listen(win, 'pointermove', event => {
    if (!drag || drag.pointerId !== event.pointerId) return
    take(event); updatePreview(event.clientX)
  }, true)
  listen(win, 'pointerup', event => {
    if (!drag || drag.pointerId !== event.pointerId) return
    take(event); updatePreview(event.clientX)
    if (!drag) return
    const previous = drag; markClick(); resetDrag()
    commit(previous.preview, previous.owner)
  }, true)
  listen(win, 'pointercancel', event => {
    if (!drag || drag.pointerId !== event.pointerId) return
    take(event); cancel()
  }, true)
  listen(timeline, 'lostpointercapture', event => { if (drag?.pointerId === event.pointerId) cancel() })
  listen(timeline, 'scroll', () => { if (drag) updatePreview(drag.lastX) })
  listen(root, 'keydown', event => {
    if (event.key === 'Escape' && (drag || drawing || fieldsDirty)) { take(event); cancel(); return }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'Enter' && bar.contains(event.target) && event.target.matches('[data-range-endpoint]')) { take(event); if (!busy()) applyFields(); return }
    const handle = event.target.closest?.('[data-range-handle]')
    if (!handle || !timeline.contains(handle) || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    take(event)
    if (busy() || handle.disabled || !valid(getProject().timelineSelection)) return
    const captured = owner(), range = { ...captured.project.timelineSelection }, endpoint = handle.dataset.rangeHandle
    const duration = getProjectDuration(captured.project), frame = 1 / captured.project.sampleRate
    const min = endpoint === 'startSeconds' ? 0 : Math.min(duration, range.startSeconds + frame)
    const max = endpoint === 'startSeconds' ? Math.max(0, range.endSeconds - frame) : duration
    let next = event.key === 'Home' ? min : event.key === 'End' ? max : range[endpoint]
    if (event.key.startsWith('Arrow')) {
      const direction = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 1
      // Discover the next grid point without rounding saved off-grid endpoints.
      for (let step = Math.max(frame, .001); step <= Math.max(duration * 2, 1); step *= 2) {
        const candidate = Number(snapTime(range[endpoint] + direction * step))
        if (Number.isFinite(candidate) && direction * (candidate - range[endpoint]) > 1e-12) { next = candidate; break }
      }
    }
    range[endpoint] = clamp(next, min, max)
    commit(range, captured)
    timeline.querySelector(`[data-range-handle="${endpoint}"]`)?.focus({ preventScroll: true })
  }, true)
  listen(win, 'blur', cancel)
  listen(win, 'pagehide', cancel)
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancel() })
  listen(doc, 'wf:mode-change', event => { if (event.detail?.mode !== 'editor') cancel() })
  function destroy() {
    if (destroyed) return
    resetDrag(); destroyed = true
    disposers.forEach(dispose => dispose())
    if (clickTimer !== null) win.clearTimeout(clickTimer)
    bar.remove()
    timeline.querySelectorAll('.daw-timeline-selection, .daw-selection-handle').forEach(element => element.remove())
    timeline.classList.remove('daw-selection-drawing', 'daw-has-selection', 'daw-selection-tight')
  }
  render()
  return { render, cancel, destroy }
}
