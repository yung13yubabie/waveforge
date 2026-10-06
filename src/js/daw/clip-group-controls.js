import { DAW_LIMITS } from './project.js'

const timeLabel = value => `${Number(value.toFixed(3))} 秒`
const keyOf = ref => `${ref.trackId}/${ref.clipId}`

/** Contextual UI only. The caller owns atomic commands, overlap validation,
 * grid geometry and history. Re-render after source/selection/job changes;
 * cancel on navigation or project replacement, destroy with the panel.
 * Callbacks receive detached IDs and a captured owner, never mutable UI state. */
export function createClipGroupControls({ host, getProject, getSelection, isBusy = () => false,
  getGridInfo = () => ({}), getOwnerVersion = () => 0,
  moveTo, nudge, duplicateToEnd, remove, clear, exit, onStatus = () => {} }) {
  if (!host?.ownerDocument) throw new TypeError('Clip group controls require a dedicated inspector host')
  for (const callback of [getProject, getSelection, isBusy, getGridInfo, getOwnerVersion, moveTo, nudge, duplicateToEnd, remove, clear, exit, onStatus]) {
    if (typeof callback !== 'function') throw new TypeError('Clip group controls require project, selection and action callbacks')
  }
  const doc = host.ownerDocument, disposers = []
  const node = (tag, className, text) => {
    const element = doc.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
  const listen = (target, type, handler) => {
    target.addEventListener(type, handler)
    disposers.push(() => target.removeEventListener(type, handler))
  }
  const bar = node('div', 'daw-clip-group-controls')
  bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', '所選片段')
  const summary = node('p', 'daw-group-summary')
  summary.setAttribute('aria-live', 'polite'); summary.setAttribute('aria-atomic', 'true')
  const fields = node('div', 'daw-group-fields')
  const targetLabel = node('label', '', '最早起點（秒）'), target = node('input')
  target.type = 'number'; target.min = '0'; target.step = 'any'; target.inputMode = 'decimal'
  target.dataset.groupTarget = ''; target.setAttribute('aria-label', '所選片段最早起點（秒）')
  targetLabel.append(target)
  const button = (action, text, label = text) => {
    const element = node('button', '', text)
    element.type = 'button'; element.dataset.groupAction = action; element.setAttribute('aria-label', label)
    return element
  }
  const move = button('move', '移動所選')
  fields.append(targetLabel, move)
  const nudges = node('div', 'daw-group-nudges')
  const previous = button('nudge-left', '←', '向前微移所選片段'), next = button('nudge-right', '→', '向後微移所選片段')
  const gridSummary = node('span', 'daw-group-grid-summary')
  nudges.append(previous, next, gridSummary)
  const overlapLabel = node('label', 'daw-group-overlap'), overlap = node('input')
  overlap.type = 'checkbox'; overlap.checked = false; overlap.dataset.groupOverlap = ''
  overlapLabel.append(overlap, doc.createTextNode('這次允許重疊'))
  const actions = node('div', 'daw-group-actions')
  actions.append(button('duplicate', '複製到尾端'), button('remove', '刪除所選'),
    button('clear', '清除選取'), button('exit', '結束多選'))
  const help = node('p', 'daw-help', '整組保留軌道與間距；複製接在專案尾端。未勾選時，移動不會蓋到同軌其他片段。')
  bar.append(summary, fields, nudges, overlapLabel, actions, help); host.append(bar)

  let destroyed = false, generation = 0, pending = null, renderedOwner = null, fieldOwner = null, dirty = false, nextProjectToken = 0, pressed = null
  // Weak keys distinguish same-ID/same-revision replacements without keeping
  // an old project alive through a cancelled, indefinitely pending promise.
  const projectTokens = new WeakMap()
  const busy = () => Boolean(pending) || isBusy()
  function selection() {
    const state = getSelection(), refs = state?.refs
    if (!Array.isArray(refs) || refs.length > 256 || !Number.isSafeInteger(state.version) || state.version < 0) return null
    const seen = new Set(), copy = []
    for (const ref of refs) {
      if (!ref || Object.getPrototypeOf(ref) !== Object.prototype ||
          typeof ref.trackId !== 'string' || typeof ref.clipId !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref.trackId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref.clipId)) return null
      const key = keyOf(ref)
      if (seen.has(key)) return null
      seen.add(key); copy.push({ trackId: ref.trackId, clipId: ref.clipId })
    }
    return { version: state.version, refs: copy }
  }
  function owner() {
    const project = getProject(), selected = selection(), grid = getGridInfo() || {}
    if (project && typeof project === 'object' && !projectTokens.has(project)) projectTokens.set(project, ++nextProjectToken)
    return { projectToken: project && typeof project === 'object' ? projectTokens.get(project) : null,
      projectId: project?.id, revision: project?.revision,
      selectionVersion: selected?.version, refs: selected?.refs || [],
      selectionKey: selected ? JSON.stringify(selected.refs) : null,
      gridKey: JSON.stringify({ stepSeconds: grid.stepSeconds, snapEnabled: grid.snapEnabled, version: grid.version }),
      sourceVersion: getOwnerVersion(), generation }
  }
  function sameOwner(a, b) {
    return Boolean(a && b && a.projectToken === b.projectToken && a.projectId === b.projectId && a.revision === b.revision &&
      a.selectionVersion === b.selectionVersion && a.selectionKey === b.selectionKey && a.gridKey === b.gridKey &&
      a.sourceVersion === b.sourceVersion && a.generation === b.generation)
  }
  const current = captured => !destroyed && host.isConnected && !host.closest('[hidden]') && sameOwner(captured, owner())
  function bounds(captured) {
    const project = getProject()
    if (!project || projectTokens.get(project) !== captured?.projectToken || !Array.isArray(project.tracks) || captured.refs.length < 2 || !captured.selectionKey) return null
    let start = Infinity, end = -Infinity
    for (const ref of captured.refs) {
      const clip = project.tracks.find(track => track.id === ref.trackId)?.clips.find(item => item.id === ref.clipId)
      if (!clip || !Number.isFinite(clip.atSeconds) || !Number.isFinite(clip.durationSeconds) || clip.atSeconds < 0 || clip.durationSeconds <= 0) return null
      start = Math.min(start, clip.atSeconds); end = Math.max(end, clip.atSeconds + clip.durationSeconds)
    }
    return end <= DAW_LIMITS.maxDurationSeconds ? { start, end, span: end - start } : null
  }
  function resetDraft() { dirty = false; fieldOwner = null; overlap.checked = false; target.removeAttribute('aria-invalid') }
  function render() {
    if (destroyed) return
    const captured = owner(), range = bounds(captured), changed = !sameOwner(renderedOwner, captured)
    if (changed || busy()) resetDraft()
    renderedOwner = captured
    host.hidden = !range
    if (!range) { summary.textContent = ''; return }
    summary.textContent = `已選 ${captured.refs.length} 個片段 · ${timeLabel(range.start)} – ${timeLabel(range.end)}（跨度 ${timeLabel(range.span)}）`
    if (!dirty) target.value = String(range.start)
    target.max = String(Math.max(0, DAW_LIMITS.maxDurationSeconds - range.span))
    const grid = getGridInfo() || {}
    gridSummary.textContent = grid.snapEnabled ? '依目前拍格微移' : Number.isFinite(grid.stepSeconds) && grid.stepSeconds > 0 ? `每次 ${timeLabel(grid.stepSeconds)}` : '依目前步長微移'
    for (const control of bar.querySelectorAll('button, input')) control.disabled = busy()
  }
  function report(error, captured) {
    if (current(captured) && error?.name !== 'AbortError') onStatus(error?.message || String(error), true)
  }
  function perform(callback, captured, allowOverlap = false) {
    if (!current(captured) || busy() || !bounds(captured)) { resetDraft(); render(); return }
    const token = {}; pending = token
    const context = { refs: captured.refs.map(ref => ({ ...ref })), allowOverlap,
      owner: { ...captured, refs: captured.refs.map(ref => ({ ...ref })) } }
    resetDraft()
    try {
      const result = callback(context)
      if (result && typeof result.then === 'function') {
        render()
        Promise.resolve(result).catch(error => report(error, captured)).finally(() => {
          if (pending === token) { pending = null; render() }
        })
      } else { pending = null; render() }
    } catch (error) { pending = null; report(error, captured); render() }
  }
  function applyTarget() {
    const captured = fieldOwner || renderedOwner
    if (!current(captured) || busy()) { resetDraft(); render(); return }
    const range = bounds(captured), value = Number(target.value)
    if (!target.value.trim() || !Number.isFinite(value) || value < 0 || !range || value + range.span > DAW_LIMITS.maxDurationSeconds) {
      target.setAttribute('aria-invalid', 'true'); onStatus('請填入有效起點，整組須在 0–600 秒內', true); return
    }
    target.removeAttribute('aria-invalid')
    if (value === range.start) { resetDraft(); render(); return }
    perform(context => moveTo(value, context), captured, overlap.checked)
  }
  listen(target, 'input', () => {
    if (!current(renderedOwner) || busy()) { resetDraft(); render(); return }
    if (!dirty) fieldOwner = renderedOwner
    dirty = true; target.removeAttribute('aria-invalid')
  })
  listen(overlap, 'change', () => {
    if (!current(renderedOwner) || busy()) { resetDraft(); render() }
  })
  listen(bar, 'pointerdown', event => {
    const control = event.target.closest?.('[data-group-action]')
    if (control && bar.contains(control) && (event.button === undefined || event.button === 0) && event.isPrimary !== false) pressed = { control, owner: renderedOwner }
  })
  listen(bar, 'pointercancel', () => { if (pressed) pressed.owner = null })
  listen(bar, 'click', event => {
    const control = event.target.closest?.('[data-group-action]')
    if (!control || !bar.contains(control)) return
    event.preventDefault(); event.stopPropagation()
    const captured = pressed?.control === control ? pressed.owner : renderedOwner
    pressed = null
    if (control.disabled || busy()) return
    if (!current(captured)) { resetDraft(); render(); return }
    const action = control.dataset.groupAction
    if (action === 'move') applyTarget()
    else if (action === 'nudge-left' || action === 'nudge-right') perform(context => nudge(action === 'nudge-left' ? -1 : 1, context), captured, overlap.checked)
    else if (action === 'duplicate') perform(duplicateToEnd, captured)
    else if (action === 'remove') perform(remove, captured)
    else if (action === 'clear') perform(clear, captured)
    else if (action === 'exit') perform(exit, captured)
  })
  listen(bar, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() }
    else if (event.key === 'Enter' && event.target === target) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) applyTarget() }
    else if (event.key === 'Enter' || event.key === ' ') {
      const control = event.target.closest?.('[data-group-action]')
      if (!control || !bar.contains(control)) return
      if (event.repeat) { event.preventDefault(); event.stopPropagation() }
      else pressed = { control, owner: renderedOwner }
    }
  })
  function cancel() {
    if (destroyed) return
    generation++; pending = null; resetDraft(); render()
  }
  function destroy() {
    if (destroyed) return
    destroyed = true; generation++; pending = null
    for (const dispose of disposers) dispose()
    bar.remove(); host.hidden = true; renderedOwner = null; fieldOwner = null; pressed = null
  }
  render()
  return { render, cancel, destroy }
}
