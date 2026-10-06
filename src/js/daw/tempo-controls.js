import { DAW_LIMITS } from './project.js'
import { createTapTempo, TAP_TEMPO_LIMITS } from './tap-tempo.js'

const withinTempoRange = value => Number.isFinite(value) && value >= TAP_TEMPO_LIMITS.minTempo && value <= TAP_TEMPO_LIMITS.maxTempo

/** Mount in a dedicated host. The caller owns audio, history and the live project.
 * applyGridPatch({ tempo? , gridOriginSeconds? }) is one explicit project command.
 * Call render on project/job changes, cancel on navigation, destroy on teardown.
 * No project changes are made while collecting taps or editing the origin field. */
export function createTempoControls({ root, getProject, isBusy = () => false,
  getCurrentTime, applyGridPatch, onStatus = () => {}, now = () => performance.now() }) {
  if (!root?.ownerDocument) throw new TypeError('Tempo controls require a host')
  for (const callback of [getProject, isBusy, getCurrentTime, applyGridPatch, onStatus, now]) {
    if (typeof callback !== 'function') throw new TypeError('Tempo controls require their project and action callbacks')
  }
  const doc = root.ownerDocument, win = doc.defaultView, disposers = []
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
  const buttons = {}
  const button = (action, text, label = text) => {
    const element = node('button', '', text)
    element.type = 'button'; element.dataset.tempoAction = action; element.setAttribute('aria-label', label)
    buttons[action] = element
    return element
  }
  const details = node('details', 'daw-tempo-controls')
  details.append(node('summary', '', '拍速與對齊'))
  const body = node('div', 'daw-tempo-body')
  body.append(node('p', 'daw-tempo-help', '跟著聽到的拍點連點至少 5 下。只改拍格，不改錄音速度'))
  const tapRow = node('div', 'daw-tempo-tap-row')
  tapRow.append(button('tap', '跟拍', '跟著音樂拍點，估算 BPM'))
  buttons.tap.title = '點擊，或聚焦後按空白鍵／Enter；每拍一下'
  const status = node('span', 'daw-tempo-status')
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true')
  tapRow.append(status, button('reset', '重拍'))
  const candidateRow = node('div', 'daw-tempo-candidate-row')
  const candidate = node('output', 'daw-tempo-candidate')
  candidate.setAttribute('aria-label', '候選 BPM')
  candidateRow.append(candidate, button('half', '½', '候選 BPM 減半'), button('double', '×2', '候選 BPM 加倍'), button('apply', '套用 BPM'))
  const originDetails = node('details', 'daw-tempo-origin-details')
  originDetails.append(node('summary', '', '拍點對齊'))
  const originRow = node('div', 'daw-tempo-origin-row'), label = node('label', '', '參考拍點（秒）'), origin = node('input')
  origin.type = 'number'; origin.min = '0'; origin.max = String(DAW_LIMITS.maxDurationSeconds); origin.step = 'any'; origin.inputMode = 'decimal'
  origin.dataset.tempoOrigin = ''; origin.setAttribute('aria-label', '參考拍點位置（秒）')
  label.append(origin)
  originRow.append(label, button('apply-origin', '套用拍點'), button('use-position', '用播放位置', '將目前播放位置設為參考拍點'), button('reset-origin', '歸零', '將參考拍點歸零'))
  originDetails.append(originRow)
  body.append(tapRow, candidateRow, originDetails); details.append(body); root.append(details)

  const tapping = createTapTempo({ now }), pressed = new Set()
  let destroyed = false, pending = false, active = true, candidateOwner = null, fieldOwner = null, lastOwner = null
  let fieldsDirty = false, multiplier = 1, localError = '', operation = 0
  const snapshot = () => {
    const project = getProject()
    return { project, id: project.id, revision: project.revision, tempo: project.tempo, origin: project.gridOriginSeconds ?? 0 }
  }
  const owns = captured => {
    const current = snapshot()
    return captured && captured.project === current.project && captured.id === current.id && captured.revision === current.revision &&
      captured.tempo === current.tempo && captured.origin === current.origin
  }
  const visible = () => active && root.isConnected && !root.closest('[hidden]') && !root.closest('details:not([open])') && details.open && !doc.hidden
  const busy = () => pending || isBusy()
  const canInteract = () => !destroyed && visible() && !busy()
  const validOrigin = value => Number.isFinite(value) && value >= 0 && value <= DAW_LIMITS.maxDurationSeconds
  const candidateBpm = () => { const state = tapping.getState(); return state.status === 'ready' ? Math.round(state.bpm * multiplier * 10) / 10 : null }
  function clearDrafts() {
    tapping.reset(); candidateOwner = null; fieldOwner = null; fieldsDirty = false; multiplier = 1; localError = ''; pressed.clear()
  }
  function cancel() {
    if (destroyed) return
    operation++; clearDrafts(); render()
  }
  function report(error) {
    localError = error?.message || String(error)
    onStatus(localError, true)
  }
  function render() {
    if (destroyed) return
    if (lastOwner && !owns(lastOwner) || !visible() || isBusy()) clearDrafts()
    lastOwner = snapshot()
    const state = tapping.getState(), bpm = candidateBpm(), disabled = !canInteract()
    if (!fieldsDirty || !owns(fieldOwner)) {
      fieldsDirty = false; fieldOwner = null; origin.value = String(lastOwner.origin)
    }
    for (const element of [...Object.values(buttons), origin]) element.disabled = disabled
    buttons.reset.disabled = disabled || !state.tapCount
    candidateRow.hidden = bpm === null
    candidate.textContent = bpm === null ? '' : `${bpm} BPM`
    buttons.half.hidden = bpm === null || !withinTempoRange(bpm / 2)
    buttons.double.hidden = bpm === null || !withinTempoRange(bpm * 2)
    buttons.apply.disabled = disabled || bpm === null || bpm === lastOwner.tempo
    buttons['reset-origin'].disabled = disabled || lastOwner.origin === 0
    if (localError) status.textContent = localError
    else if (state.status === 'ready') status.textContent = `${state.tapCount} 下 · 拍距差 ${Math.round(state.spreadMs)} ms`
    else if (state.status === 'irregular') status.textContent = '拍點還不穩，請重拍或繼續跟拍'
    else if (state.status === 'out-of-range') status.textContent = '拍速超出 20–300 BPM，請重拍'
    else status.textContent = state.tapCount ? `${state.tapCount} / ${TAP_TEMPO_LIMITS.minTaps} 下` : '至少 5 下'
    status.dataset.error = String(Boolean(localError) || ['irregular', 'out-of-range'].includes(state.status))
  }
  function tap() {
    if (!canInteract()) { render(); return }
    if (!candidateOwner || !owns(candidateOwner)) { clearDrafts(); candidateOwner = snapshot(); lastOwner = candidateOwner }
    localError = ''; multiplier = 1
    tapping.tap(); render()
  }
  function apply(patch, captured) {
    if (!canInteract() || !owns(captured)) { cancel(); return }
    const project = getProject()
    if ('tempo' in patch && (!withinTempoRange(patch.tempo) || patch.tempo === project.tempo) ||
      'gridOriginSeconds' in patch && (!validOrigin(patch.gridOriginSeconds) || patch.gridOriginSeconds === (project.gridOriginSeconds ?? 0))) return
    // Consume before calling the owner, including synchronous render re-entry.
    clearDrafts(); pending = true
    const token = ++operation
    try {
      const result = applyGridPatch(patch)
      if (result && typeof result.then === 'function') {
        render()
        Promise.resolve(result).catch(error => {
          if (!destroyed && token === operation && error?.name !== 'AbortError') report(error)
        }).finally(() => { pending = false; render() })
      } else { pending = false; render() }
    } catch (error) {
      pending = false
      if (error?.name !== 'AbortError') report(error)
      render()
    }
  }
  function applyOrigin() {
    if (!originDetails.open) return
    const captured = fieldOwner || snapshot()
    if (!canInteract() || !owns(captured)) { cancel(); return }
    const value = Number(origin.value)
    if (!origin.value.trim() || !validOrigin(value)) {
      report(new Error(`參考拍點須為 0–${DAW_LIMITS.maxDurationSeconds} 秒`)); render(); return
    }
    apply({ gridOriginSeconds: value }, captured)
  }
  const take = event => { event.preventDefault(); event.stopPropagation() }
  listen(details, 'click', event => {
    const target = event.target.closest?.('[data-tempo-action]')
    if (!target || !details.contains(target)) return
    take(event)
    if (target.disabled || !canInteract()) { render(); return }
    const action = target.dataset.tempoAction
    if (action === 'tap') { tap(); return }
    if (action === 'reset') { cancel(); return }
    if (action === 'apply') { const bpm = candidateBpm(); if (bpm !== null) apply({ tempo: bpm }, candidateOwner); return }
    if (action === 'half' || action === 'double') {
      if (!owns(candidateOwner)) { cancel(); return }
      const factor = action === 'half' ? .5 : 2, bpm = candidateBpm()
      if (bpm !== null && withinTempoRange(bpm * factor)) { multiplier *= factor; render() }
      return
    }
    if (!originDetails.open) return
    if (action === 'apply-origin') { applyOrigin(); return }
    if (action === 'reset-origin') { apply({ gridOriginSeconds: 0 }, snapshot()); return }
    if (action === 'use-position') {
      const captured = snapshot(), value = getCurrentTime()
      if (!validOrigin(value)) { report(new Error('目前播放位置無效')); render(); return }
      apply({ gridOriginSeconds: value }, captured)
    }
  })
  listen(origin, 'input', () => {
    if (!canInteract() || !originDetails.open) { render(); return }
    if (!fieldsDirty) fieldOwner = snapshot()
    fieldsDirty = true; localError = ''
  })
  listen(details, 'keydown', event => {
    if (event.key === 'Escape') { take(event); cancel(); details.open = false; return }
    if (event.target === origin && event.key === 'Enter') { take(event); if (!event.repeat) applyOrigin(); return }
    if (event.target !== buttons.tap || ![' ', 'Enter'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
    take(event)
    if (event.repeat || pressed.has(event.key)) return
    tap(); pressed.add(event.key)
  })
  listen(details, 'keyup', event => {
    if (event.target !== buttons.tap || ![' ', 'Enter'].includes(event.key)) return
    take(event); pressed.delete(event.key)
  })
  listen(buttons.tap, 'blur', () => pressed.clear())
  listen(doc, 'toggle', event => {
    if (event.target === details) { if (!details.open) cancel(); else render() }
    else if (event.target?.tagName === 'DETAILS' && event.target.contains(root)) { if (!event.target.open) cancel(); else render() }
    else if (event.target === originDetails && !originDetails.open) { fieldOwner = null; fieldsDirty = false; render() }
  }, true)
  listen(win, 'blur', cancel)
  listen(win, 'pagehide', cancel)
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancel(); else render() })
  listen(doc, 'wf:mode-change', event => { active = event.detail?.mode === 'editor'; if (!active) { details.open = false; cancel() } else render() })
  function destroy() {
    if (destroyed) return
    destroyed = true; operation++; clearDrafts(); disposers.forEach(dispose => dispose()); details.remove()
  }
  render()
  return { render, cancel, destroy }
}
