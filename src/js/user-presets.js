// User preset storage — saves chain snapshots (engine.serialize()) to
// localStorage so users can recall their own settings, alongside the 39
// built-ins. Not sensitive data; localStorage is fine and CSP-permitted.

const KEY = 'wf_user_presets'

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    const obj = raw ? JSON.parse(raw) : {}
    return (obj && typeof obj === 'object') ? obj : {}
  } catch {
    return {}   // corrupt/blocked storage → behave as empty, never throw
  }
}

function write(obj) {
  try { localStorage.setItem(KEY, JSON.stringify(obj)); return true }
  catch { return false }   // quota/blocked → report failure, don't throw
}

// Sorted list of saved preset names.
export function listUserPresets() {
  return Object.keys(read()).sort((a, b) => a.localeCompare(b))
}

export function saveUserPreset(name, snapshot) {
  const trimmed = String(name ?? '').trim().slice(0, 60)
  if (!trimmed) return false
  const all = read()
  all[trimmed] = snapshot
  return write(all)
}

export function getUserPreset(name) {
  return read()[name] ?? null
}

export function removeUserPreset(name) {
  const all = read()
  if (!(name in all)) return false
  delete all[name]
  return write(all)
}
