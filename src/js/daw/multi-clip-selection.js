/** Ephemeral clip IDs only. This state never belongs in a saved project. */
export const MULTI_CLIP_SELECTION_LIMITS = Object.freeze({ clips: 256, historyEntries: 100, historyBytes: 256 * 1024 })

const fail = message => { throw new TypeError(`DAW clip selection: ${message}`) }
const sameRef = (a, b) => a?.trackId === b?.trackId && a?.clipId === b?.clipId
const refKey = ref => `${ref.trackId}/${ref.clipId}`
const copyRef = ref => ref ? { trackId: ref.trackId, clipId: ref.clipId } : null
function plainFields(value, fields, label) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be plain metadata`)
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key)))) fail(`${label} has unsupported fields`)
}
function validRef(value) {
  plainFields(value, ['trackId', 'clipId'], 'clip reference')
  for (const key of ['trackId', 'clipId']) {
    if (typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value[key])) fail(`${key} is invalid`)
  }
  return copyRef(value)
}
function copySnapshot(value) {
  plainFields(value, ['mode', 'refs', 'primary'], 'snapshot')
  if (typeof value.mode !== 'boolean') fail('mode must be a boolean')
  if (!Array.isArray(value.refs) || Object.getPrototypeOf(value.refs) !== Array.prototype || value.refs.length > MULTI_CLIP_SELECTION_LIMITS.clips) fail('selection exceeds the 256 clip limit')
  const refs = [], seen = new Set()
  for (let index = 0; index < value.refs.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value.refs, String(index))
    if (!descriptor || !('value' in descriptor)) fail('clip references must be plain entries')
    const ref = validRef(descriptor.value), key = refKey(ref)
    if (seen.has(key)) fail('duplicate clip reference')
    seen.add(key); refs.push(ref)
  }
  if (Reflect.ownKeys(value.refs).length !== value.refs.length + 1) fail('clip references have unsupported fields')
  const primary = value.primary === null ? null : validRef(value.primary)
  if (refs.length ? !primary || !seen.has(refKey(primary)) : primary !== null) fail('primary must belong to the selection')
  if (!value.mode && refs.length > 1) fail('multiple clips require selection mode')
  return { mode: value.mode, refs, primary }
}
function liveRefs(project) {
  if (!project || !Array.isArray(project.tracks) || project.tracks.length > 16) fail('requires a live bounded project')
  const refs = [], seen = new Set()
  for (const track of project.tracks) {
    if (!track || !Array.isArray(track.clips)) fail('requires live track clips')
    for (const clip of track.clips) {
      const ref = validRef({ trackId: track.id, clipId: clip?.id }), key = refKey(ref)
      if (seen.has(key)) fail('duplicate live clip reference')
      seen.add(key); refs.push(ref)
      if (refs.length > MULTI_CLIP_SELECTION_LIMITS.clips) fail('selection exceeds the 256 clip limit')
    }
  }
  return refs
}

/** Each effective change increments version. reset() also invalidates owners
 * when replacing a project with one whose IDs happen to be identical.
 * Snapshot/restore intentionally exclude version and all project references. */
export function createMultiClipSelection() {
  let state = { mode: false, refs: [], primary: null }, version = 0
  const snapshot = () => ({ mode: state.mode, refs: state.refs.map(copyRef), primary: copyRef(state.primary) })
  function replace(next, force = false) {
    if (force || JSON.stringify(next) !== JSON.stringify(state)) { state = next; version++ }
    return snapshot()
  }
  return {
    get mode() { return state.mode },
    get refs() { return state.refs.map(copyRef) },
    get primary() { return copyRef(state.primary) },
    get version() { return version },
    snapshot,
    restore(value) { return replace(copySnapshot(value)) },
    setMode(mode) {
      if (typeof mode !== 'boolean') fail('mode must be a boolean')
      return replace({ mode, refs: mode ? state.refs : state.primary ? [state.primary] : [], primary: state.primary })
    },
    select(value, { additive = false, toggle = false } = {}) {
      const ref = validRef(value)
      if (typeof additive !== 'boolean' || typeof toggle !== 'boolean') fail('selection options must be booleans')
      if (!additive && !toggle) return replace({ mode: state.mode, refs: [ref], primary: ref })
      const exists = state.refs.some(item => sameRef(item, ref))
      const refs = toggle && exists ? state.refs.filter(item => !sameRef(item, ref)) : exists ? [...state.refs] : [...state.refs, ref]
      if (refs.length > MULTI_CLIP_SELECTION_LIMITS.clips) fail('selection exceeds the 256 clip limit')
      const primary = toggle && exists ? sameRef(state.primary, ref) ? refs.at(-1) || null : state.primary : ref
      return replace({ mode: true, refs, primary })
    },
    selectAll(project) {
      const refs = liveRefs(project)
      const primary = refs.find(ref => sameRef(ref, state.primary)) || refs[0] || null
      return replace({ mode: true, refs, primary })
    },
    clear() { return replace({ mode: state.mode, refs: [], primary: null }) },
    reconcile(project) {
      const available = new Set(liveRefs(project).map(refKey)), refs = state.refs.filter(ref => available.has(refKey(ref)))
      const primary = refs.find(ref => sameRef(ref, state.primary)) || refs.at(-1) || null
      return replace({ mode: state.mode, refs, primary })
    },
    reset() { return replace({ mode: false, refs: [], primary: null }, true) },
  }
}

/** Optional selection sidecar for the caller's opaque history keys. Eviction
 * affects only this UI state, never project Undo. No project JSON or audio is
 * accepted. Missing keys deliberately return null for the caller to reconcile. */
export function createClipSelectionHistory({ maxEntries = MULTI_CLIP_SELECTION_LIMITS.historyEntries,
  maxBytes = MULTI_CLIP_SELECTION_LIMITS.historyBytes } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > MULTI_CLIP_SELECTION_LIMITS.historyEntries ||
      !Number.isInteger(maxBytes) || maxBytes < 2 || maxBytes > MULTI_CLIP_SELECTION_LIMITS.historyBytes) fail('invalid history budget')
  const entries = new Map(), encoder = new TextEncoder()
  let bytes = 2
  const validKey = key => {
    if (!(typeof key === 'string' && key.length > 0 && key.length <= 128) && !(typeof key === 'number' && Number.isSafeInteger(key))) fail('history key must be a bounded opaque string or integer')
  }
  const recount = () => { bytes = 2; for (const entry of entries.values()) bytes += entry.bytes + 1; if (entries.size) bytes-- }
  return {
    get size() { return entries.size },
    get bytes() { return bytes },
    set(key, value) {
      validKey(key)
      const snapshot = copySnapshot(value)
      const size = encoder.encode(JSON.stringify({ key, snapshot })).byteLength
      entries.delete(key); entries.set(key, { snapshot, bytes: size }); recount()
      while (entries.size > maxEntries || bytes > maxBytes) { entries.delete(entries.keys().next().value); recount() }
      return entries.has(key)
    },
    get(key) { validKey(key); const entry = entries.get(key); return entry ? copySnapshot(entry.snapshot) : null },
    prune(retainedKeys) {
      const retained = new Set(retainedKeys)
      for (const key of entries.keys()) if (!retained.has(key)) entries.delete(key)
      recount()
    },
    clear() { entries.clear(); recount() },
  }
}
