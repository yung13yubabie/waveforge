import { createClient } from '@supabase/supabase-js'

// Probe before constructing auth: an expired stored session otherwise starts
// SDK refresh retries even when a paused project's hostname no longer exists.
export function createBackendConnection(url, key, onChange) {
  let client = null
  let pending = null
  let state = { status: 'unconfigured', message: '帳號服務尚未設定，母帶與分軌功能仍可使用。' }

  function update(status, message = '') {
    state = { status, message }
    onChange(state)
  }

  function connect() {
    if (client) return Promise.resolve(client)
    if (pending) return pending
    if (!url || !key) { onChange(state); return Promise.resolve(null) }
    update('checking', '正在連線帳號服務…')
    pending = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      try {
        const response = await fetch(`${url.replace(/\/$/, '')}/auth/v1/settings`, {
          headers: { apikey: key }, cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        await response.json()
        client = createClient(url, key)
        update('ready')
        return client
      } catch (error) {
        const detail = error.name === 'AbortError' ? '連線逾時' : error.message
        update('unavailable', `帳號服務暫時無法連線（${detail}）。母帶與分軌仍可使用；請稍後重試。`)
        return null
      } finally {
        clearTimeout(timer)
        pending = null
      }
    })()
    return pending
  }

  return { connect, get state() { return state } }
}
