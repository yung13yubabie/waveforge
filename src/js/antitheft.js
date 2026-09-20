import { getAudioDuration, extractAudioSample } from './antitheft/scan-audio.js'
/**
 * Anti-Theft Detection — Supabase Auth + ACRCloud 音訊指紋比對
 *
 * 模式：
 *   SUPABASE_CONFIGURED=false → 訪客模式（localStorage ACR key，Demo 掃描結果）
 *   SUPABASE_CONFIGURED=true  → 完整模式（Supabase 帳號 + Edge Function 呼叫 ACRCloud）
 */

import { createBackendConnection } from './backend-connection.js'
import { SUPABASE_URL, SUPABASE_ANON_KEY, ACR_EDGE_FN, SUPABASE_CONFIGURED } from './config.js'
import { renderResults } from './antitheft/results-view.js'

let supabase = null
const backend = createBackendConnection(SUPABASE_URL, SUPABASE_ANON_KEY, renderBackendState)

// ── Auth state ────────────────────────────────────────────
let currentUser = null     // { id, email } | null
let acrAccessKey = ''
let acrAccessSecret = ''
let spotifyClientId = ''
let spotifyClientSecret = ''
let emailNotify = true

// ── Works library (in-memory; synced to DB in live mode) ──
const works = []   // [{ id, name, file, fingerprint, lastScan, results }]
let activeWorkId = null

// ── Helpers ───────────────────────────────────────────────
// ── Auth overlay ──────────────────────────────────────────
export function checkAuthOverlay() {
  const overlay  = document.getElementById('auth-required-overlay')
  const infoEl   = document.getElementById('auth-user-info')
  const loginBtn = document.getElementById('auth-login-pill')
  const settingsBtn = document.getElementById('settings-auth-btn')
  const avatarEl = document.getElementById('auth-avatar')

  const shouldBlock = SUPABASE_CONFIGURED && !currentUser
  if (overlay) overlay.classList.toggle('visible', shouldBlock)

  if (currentUser) {
    const initial = (currentUser.email?.[0] ?? '?').toUpperCase()
    if (infoEl)     infoEl.textContent = currentUser.email ?? ''
    if (avatarEl)   { avatarEl.hidden = false; avatarEl.textContent = initial }
    if (loginBtn)   loginBtn.hidden = true
    if (settingsBtn) settingsBtn.textContent = '登出'
  } else {
    if (infoEl) infoEl.textContent = backend.state.status === 'unavailable'
      ? '帳號服務暫時無法連線' : SUPABASE_CONFIGURED ? '未登入' : '訪客模式'
    if (avatarEl)   avatarEl.hidden = true
    if (loginBtn)   loginBtn.hidden = false
    if (settingsBtn) settingsBtn.textContent = '登入 / 註冊'
    const menu = document.getElementById('auth-menu')
    if (menu) menu.hidden = true   // close dropdown on logout
  }
}

// ── Supabase auth methods ─────────────────────────────────
async function signInGoogle() {
  if (!supabase) throw new Error(backend.state.message)
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  })
  if (error) throw error
}

async function signOut() {
  if (!supabase) return
  try {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
  } catch (error) {
    const info = document.getElementById('auth-user-info')
    if (info) info.textContent = `登出失敗：${error.message}`
  }
}

function clearAccountData() {
  acrAccessKey = ''
  acrAccessSecret = ''
  spotifyClientId = ''
  spotifyClientSecret = ''
  emailNotify = true
  works.length = 0
  activeWorkId = null
  for (const id of ['acr-api-key', 'acr-api-secret', 'spotify-client-id', 'spotify-client-secret']) {
    const input = document.getElementById(id)
    if (input) input.value = ''
  }
  const notify = document.getElementById('email-notify-toggle')
  if (notify) notify.checked = true
  setKeyStatus('acr-key-status', '', '')
  setKeyStatus('spotify-key-status', '', '')
  renderWorksList()
  renderResults(null)
  for (const [id, text] of Object.entries({
    'scan-track-name': '選擇作品開始掃描', 'scan-status-text': '等待中',
    'scan-matches-count': '—', 'scan-last-time': '—', 'scan-results-count': '0 筆',
  })) {
    const element = document.getElementById(id)
    if (element) element.textContent = text
  }
  const provenance = document.getElementById('scan-provenance')
  if (provenance) { provenance.hidden = true; provenance.textContent = '' }
}

// ── Load user settings from Supabase ─────────────────────
async function loadUserSettings(userId) {
  if (!supabase) return
  const { data } = await supabase
    .from('user_settings')
    .select('acr_access_key, acr_access_secret, acr_host, email_notify, spotify_client_id, spotify_client_secret')
    .eq('user_id', userId)
    .single()

  if (currentUser?.id !== userId) return
  if (data) {
    acrAccessKey        = data.acr_access_key ?? ''
    acrAccessSecret     = data.acr_access_secret ?? ''
    spotifyClientId     = data.spotify_client_id ?? ''
    spotifyClientSecret = data.spotify_client_secret ?? ''
    emailNotify         = data.email_notify ?? true

    const keyInput   = document.getElementById('acr-api-key')
    const secretInput = document.getElementById('acr-api-secret')
    const hostSelect = document.getElementById('acr-host')
    const spIdInput  = document.getElementById('spotify-client-id')
    const spSecInput = document.getElementById('spotify-client-secret')
    const notifyToggle = document.getElementById('email-notify-toggle')
    if (keyInput && acrAccessKey) keyInput.value = acrAccessKey
    if (secretInput && acrAccessSecret) secretInput.value = '••••••••••••'
    if (hostSelect && data.acr_host) hostSelect.value = data.acr_host
    if (spIdInput && spotifyClientId) spIdInput.value = spotifyClientId
    if (spSecInput && spotifyClientSecret) spSecInput.value = '••••••••••••'
    if (notifyToggle) notifyToggle.checked = emailNotify

    // Reflect persisted state so the user can see it's saved on their account
    if (acrAccessKey && acrAccessSecret) {
      setKeyStatus('acr-key-status', '✓ 已儲存於你的帳號', 'saved')
    }
    if (spotifyClientId && spotifyClientSecret) {
      setKeyStatus('spotify-key-status', '✓ 已儲存於你的帳號', 'saved')
    }
  }
}

// ── Load user's works from Supabase DB ────────────────────
async function loadWorksFromDB() {
  if (!supabase || !currentUser) return
  const userId = currentUser.id
  const { data, error } = await supabase
    .from('works')
    .select('id, name, fingerprint_ok, last_scan')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (currentUser?.id !== userId || error || !data) return

  // Merge DB works with in-memory (avoid duplicates by id)
  for (const dbWork of data) {
    const existing = works.find(w => w.id === dbWork.id)
    if (!existing) {
      works.unshift({
        id:          dbWork.id,
        name:        dbWork.name,
        file:        null,
        fingerprint: dbWork.fingerprint_ok,
        lastScan:    dbWork.last_scan,
        results:     [],
      })
    }
  }
  renderWorksList()
}

// ── Persistent status line helper ─────────────────────────
function setKeyStatus(id, text, state) {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = `api-key-status ${state}`   // state: saved | error | pending
}

// Race a promise against a timeout so a hung request (network stall or the
// supabase-js auth-lock deadlock) surfaces as an error instead of leaving the
// UI pinned on "儲存中…" forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}逾時，請檢查網路後重試`)), ms)),
  ])
}

const SAVE_TIMEOUT_MS = 15000

// ── Save ACRCloud settings ────────────────────────────────
async function saveSettings() {
  const keyInput    = document.getElementById('acr-api-key')
  const secretInput = document.getElementById('acr-api-secret')
  const saveBtn     = document.getElementById('acr-key-save')

  const newKey    = keyInput?.value?.trim() ?? ''
  const newSecret = secretInput?.value?.trim() ?? ''
  if (!newKey) { setKeyStatus('acr-key-status', '請先貼上 Access Key', 'error'); return }

  acrAccessKey    = newKey
  if (newSecret && newSecret !== '••••••••••••') acrAccessSecret = newSecret

  // Live mode requires login BEFORE we touch the UI's saving state — these
  // are synchronous guards, no need to disable the button for them.
  if (SUPABASE_CONFIGURED && !currentUser) {
    setKeyStatus('acr-key-status', '請先登入帳號再儲存（登入後金鑰才會綁定帳號）', 'error')
    return
  }
  if (SUPABASE_CONFIGURED && !acrAccessSecret) {
    setKeyStatus('acr-key-status', '請一併填入 Access Secret', 'error')
    return
  }

  if (saveBtn) saveBtn.disabled = true   // guard against re-entry / double-click
  // try/catch so a thrown or timed-out request can never leave the UI with no
  // feedback ("沒反應" / stuck on "儲存中…"). Every path ends in a visible status.
  try {
    if (SUPABASE_CONFIGURED) {
      setKeyStatus('acr-key-status', '儲存中…', 'pending')
      const acrHost = document.getElementById('acr-host')?.value || 'identify-ap-southeast-1.acrcloud.com'
      const { error } = await withTimeout(
        supabase.from('user_settings').upsert({
          user_id:           currentUser.id,
          acr_access_key:    acrAccessKey,
          acr_access_secret: acrAccessSecret,
          acr_host:          acrHost,
        }, { onConflict: 'user_id' }),
        SAVE_TIMEOUT_MS, '儲存',
      )
      if (error) {
        setKeyStatus('acr-key-status', `儲存失敗：${error.message}`, 'error')
        console.error('[user_settings upsert]', error)
        return
      }
      // Read-after-write: prove the row is actually there (catches any
      // silent RLS filtering) so "已儲存" is never a lie.
      setKeyStatus('acr-key-status', '驗證中…', 'pending')
      const { data: check, error: readErr } = await withTimeout(
        supabase.from('user_settings').select('acr_access_key').eq('user_id', currentUser.id).single(),
        SAVE_TIMEOUT_MS, '回讀驗證',
      )
      if (readErr || !check?.acr_access_key) {
        setKeyStatus('acr-key-status', `寫入後回讀失敗，金鑰可能未存入：${readErr?.message ?? '無資料'}`, 'error')
        console.error('[user_settings read-after-write]', readErr)
        return
      }
      setKeyStatus('acr-key-status', '✓ 已確認存入你的帳號（跨裝置同步）', 'saved')
    } else {
      // Guest mode (no Supabase configured) → only the (non-sensitive) access
      // key persists locally; the Secret stays in memory for this session only.
      localStorage.setItem('acr-api-key', acrAccessKey)
      setKeyStatus('acr-key-status', '✓ 已存於本機（訪客模式，Secret 僅此分頁有效）', 'saved')
    }
    if (saveBtn) {
      saveBtn.textContent = '已儲存 ✓'
      saveBtn.classList.add('saved')
      setTimeout(() => { saveBtn.textContent = '儲存'; saveBtn.classList.remove('saved') }, 2000)
    }
  } catch (err) {
    setKeyStatus('acr-key-status', `儲存失敗：${err.message}`, 'error')
    console.error('[saveSettings]', err)
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

// ── Save Spotify credentials ──────────────────────────────
async function saveSpotifySettings() {
  const idInput  = document.getElementById('spotify-client-id')
  const secInput = document.getElementById('spotify-client-secret')
  const saveBtn  = document.getElementById('spotify-key-save')

  const newId  = idInput?.value?.trim() ?? ''
  const newSec = secInput?.value?.trim() ?? ''
  if (newId) spotifyClientId = newId
  if (newSec && newSec !== '••••••••••••') spotifyClientSecret = newSec

  if (!(supabase && currentUser)) {
    // Spotify enrichment runs in the Edge Function → requires live mode + login.
    setKeyStatus('spotify-key-status', '需先登入帳號才能儲存（Spotify 增強在伺服器端執行）', 'error')
    return
  }

  if (saveBtn) saveBtn.disabled = true
  try {
    setKeyStatus('spotify-key-status', '儲存中…', 'pending')
    const { error } = await withTimeout(
      supabase.from('user_settings').upsert({
        user_id:               currentUser.id,
        spotify_client_id:     spotifyClientId || null,
        spotify_client_secret: spotifyClientSecret || null,
      }, { onConflict: 'user_id' }),
      SAVE_TIMEOUT_MS, '儲存',
    )
    if (error) {
      setKeyStatus('spotify-key-status', `儲存失敗：${error.message}`, 'error')
      console.error('[spotify settings upsert]', error)
      return
    }
    setKeyStatus('spotify-key-status', '✓ 已儲存至你的帳號（選填增強）', 'saved')
    if (saveBtn) {
      saveBtn.textContent = '已儲存 ✓'
      saveBtn.classList.add('saved')
      setTimeout(() => { saveBtn.textContent = '儲存'; saveBtn.classList.remove('saved') }, 2000)
    }
  } catch (err) {
    setKeyStatus('spotify-key-status', `儲存失敗：${err.message}`, 'error')
    console.error('[saveSpotifySettings]', err)
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

// ── Save email notification preference ───────────────────
async function saveEmailNotify(val) {
  emailNotify = val
  if (supabase && currentUser) {
    await supabase.from('user_settings').upsert({
      user_id:      currentUser.id,
      email_notify: val,
    })
  }
}

// ── Upload original work ──────────────────────────────────
async function handleWorksUpload(file) {
  const id = `work-${Date.now()}`
  const work = {
    id,
    name:        file.name.replace(/\.[^.]+$/, ''),
    file,
    fingerprint: false,
    lastScan:    null,
    results:     [],
  }
  works.unshift(work)
  renderWorksList()

  if (supabase && currentUser) {
    // Save to DB. Do NOT send our temp string id — works.id is a uuid column,
    // so `work-<timestamp>` is rejected (22P02) and the work would never
    // persist, which then makes the Edge Function's ownership check 403 and
    // ACRCloud is never called. Let Postgres generate the uuid and read it back.
    const { data, error } = await supabase.from('works').insert({
      user_id:        currentUser.id,
      name:           work.name,
      file_size_bytes: file.size,
      fingerprint_ok: false,
    }).select('id').single()

    if (error) {
      // Surface it — a swallowed error here is exactly why scans silently
      // failed to reach ACRCloud (no matching works row to authorize).
      console.error('[works insert]', error)
      const statusEl = document.getElementById('scan-status-text')
      if (statusEl) statusEl.textContent = `作品未存入資料庫：${error.message} — 掃描需要它，請重新登入後重試`
    } else if (data) {
      work.id = data.id   // swap temp string id → real uuid so scanning works
      renderWorksList()
    }
  }

  // NOTE: real fingerprint extraction is not implemented yet.
  // fingerprint stays false and the UI says「已建立作品記錄」— never claim
  // a fingerprint exists when none was extracted. When ACRCloud custom
  // fingerprint upload lands, set fingerprint_ok=true only on API success.
}

// Summarize a result list by type for the provenance banner.
function summarizeResults(list) {
  const exact = list.filter(r => r.source !== '翻唱')
  const cover = list.filter(r => r.source === '翻唱')
  const parts = []
  if (exact.length) parts.push(`${exact.length} 筆原曲（指紋）`)
  if (cover.length) parts.push(`${cover.length} 筆翻唱`)
  const strong = exact.some(r => r.similarity >= 98)
  return { text: parts.join(' + ') || '無匹配', strong }
}

// ── Scan provenance banner (real vs demo evidence) ────────
function setProvenance(text, state) {
  const el = document.getElementById('scan-provenance')
  if (!el) return
  el.hidden = false
  el.textContent = text
  el.className = `scan-provenance ${state}`   // real | demo | pending | error
}

// ACRCloud recommends 10–20s to identify; 15s mono 16kHz keeps the upload
// well under its size limit (code 3016 = file too large).
const SCAN_SAMPLE_SEC = 15

// POST one audio sample to the ACRCloud Edge Function. Returns the parsed
// JSON ({ results, acrStatus }) or throws with a readable message.
async function postAcrScan(workId, sampleDataUrl) {
  const session = (await supabase.auth.getSession()).data.session
  const res = await fetch(ACR_EDGE_FN, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${session?.access_token}`,
    },
    body: JSON.stringify({ work_id: workId, audio_base64: sampleDataUrl }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
  return json
}

// Merge scan results across segments, de-duplicating by acrid (fallback title).
function dedupeResults(existing, incoming) {
  const seen = new Set(existing.map(r => r.acrid || `${r.title}|${r.artist}`))
  for (const r of incoming) {
    const k = r.acrid || `${r.title}|${r.artist}`
    if (!seen.has(k)) { seen.add(k); existing.push(r) }
  }
  return existing
}

// ── Complete scan: sweep several segments across the whole track ──
// One 15s sample identifies a track, but a thief may lift only a section
// (e.g. just the hook). Sampling multiple points across the song catches
// partial reuse. De-dupes matches across segments.
async function scanWorkComplete(work) {
  if (radarScanning) return
  const statusEl = document.getElementById('scan-status-text')
  const countEl  = document.getElementById('scan-results-count')

  if (!acrAccessKey) { if (statusEl) statusEl.textContent = '請先在設定中填入 ACRCloud Access Key'; return }
  if (!(SUPABASE_CONFIGURED && currentUser && work.file)) {
    if (statusEl) statusEl.textContent = '完整掃描需登入 + 該作品音訊在本分頁（重新整理後遺失請重傳）'
    return
  }

  radarScanning = true
  setProvenance('完整掃描中…', 'pending')

  try {
    const t0 = performance.now()
    // Probe the duration by decoding a tiny sample first.
    const dur = await getAudioDuration(work.file)
    // Segment start offsets: step through the track by SCAN_SAMPLE_SEC, capped
    // to a sane number of segments so a long track can't burn the API quota.
    const MAX_SEGMENTS = 8
    const step = Math.max(SCAN_SAMPLE_SEC, dur / MAX_SEGMENTS)
    const offsets = []
    for (let o = 0; o < dur - 1 && offsets.length < MAX_SEGMENTS; o += step) offsets.push(Math.floor(o))
    if (offsets.length === 0) offsets.push(0)

    const merged = []
    let lastCode = null
    for (let i = 0; i < offsets.length; i++) {
      if (statusEl) statusEl.textContent = `完整掃描中… 第 ${i + 1}/${offsets.length} 段（${offsets[i]}s 起）`
      setProvenance(`完整掃描中… 第 ${i + 1}/${offsets.length} 段`, 'pending')
      const sample = await extractAudioSample(work.file, SCAN_SAMPLE_SEC, offsets[i])
      const json = await postAcrScan(work.id, sample)
      lastCode = json.acrStatus?.code ?? lastCode
      dedupeResults(merged, json.results ?? [])
      // Update results live as segments complete
      work.results = merged
      if (countEl) countEl.textContent = `${merged.length} 筆`
      renderResults(work)
    }

    radarScanning = false
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
    const now = new Date()
    work.lastScan = now.toISOString()
    const sum = summarizeResults(merged)
    const warn = sum.strong ? '　⚠ 有 100% 完全相同，高度疑似盜用' : ''
    setProvenance(`完整掃描 ✓ 掃了 ${offsets.length} 段（覆蓋約 ${Math.round(dur)}s，${elapsed}s）：${sum.text}${warn}`, 'real')
    if (statusEl) statusEl.textContent = `完成 · ${now.toLocaleDateString('zh-TW')}`
    const matchesEl = document.getElementById('scan-matches-count')
    const trackNameEl = document.getElementById('scan-track-name')
    if (trackNameEl) trackNameEl.textContent = work.name
    if (matchesEl) matchesEl.textContent = merged.length
    renderResults(work)
    renderWorksList()
  } catch (err) {
    radarScanning = false
    const hint = /3001|Invalid Access Key/i.test(err.message)
      ? '（金鑰有效但區域選錯 — 到設定改「ACRCloud 區域」）' : ''
    setProvenance(`完整掃描失敗：${err.message}${hint}`, 'error')
    if (statusEl) statusEl.textContent = `掃描失敗：${err.message}${hint}`
    console.error('[ACRCloud complete scan]', err)
  }
}

// ── Scan a work ───────────────────────────────────────────
async function scanWork(work) {
  if (radarScanning) return  // already scanning

  const statusEl = document.getElementById('scan-status-text')
  const countEl  = document.getElementById('scan-results-count')
  const scanBtn  = document.querySelector(`.work-scan-btn[data-id="${work.id}"]`)

  if (!acrAccessKey) {
    if (statusEl) statusEl.textContent = '請先在設定中填入 ACRCloud Access Key'
    return
  }

  // Live mode with a DB-restored work: the audio only exists in the browser
  // session that uploaded it. Refuse clearly instead of falling into demo —
  // silently showing demo data on a real account is dishonest.
  if (SUPABASE_CONFIGURED && currentUser && !work.file) {
    if (statusEl) statusEl.textContent = '此作品的音訊檔不在本分頁（重新整理後遺失）— 請重新上傳同一檔案再掃描'
    return
  }

  radarScanning = true
  if (statusEl) statusEl.textContent = '掃描中...'
  if (scanBtn)  { scanBtn.classList.add('scanning'); scanBtn.textContent = '掃描中...' }
  setProvenance('掃描中…', 'pending')

  try {
    let results
    let provenance   // 掃描證據：真實掃描顯示 ACR 回應碼 + 耗時；demo 明確標示
    let isReal = false

    if (SUPABASE_CONFIGURED && currentUser && work.file) {
      // ── Live mode: call Supabase Edge Function ────────
      const t0 = performance.now()
      const sample = await extractAudioSample(work.file, SCAN_SAMPLE_SEC)
      // Measure only the base64 payload (strip the "data:...;base64," prefix)
      const b64 = sample.slice(sample.indexOf(',') + 1)
      const sampleKB = Math.round((b64.length * 0.75) / 1024)  // base64 → bytes
      const json = await postAcrScan(work.id, sample)
      results = json.results ?? []
      isReal = true
      const elapsed = ((performance.now() - t0) / 1000).toFixed(1)
      const code = json.acrStatus?.code
      const msg  = json.acrStatus?.msg ?? ''
      // code 0 = 有匹配；1001 = 已掃描、無匹配（都是真實掃描的證明）
      const sum = summarizeResults(results)
      const codeNote = code === 1001 ? '無匹配' : code === 0 ? sum.text : (msg || '未知')
      const warn = sum.strong ? '　⚠ 有 100% 完全相同，高度疑似盜用' : ''
      provenance = `真實掃描 ✓ ${SCAN_SAMPLE_SEC}s 樣本 → ACRCloud（${elapsed}s，code ${code ?? '?'}）：${codeNote}${warn}`
    } else {
      // ── Demo mode: stub results, clearly labelled as Demo ─
      await new Promise(r => setTimeout(r, 3000))
      const modeNote = SUPABASE_CONFIGURED ? '（需登入帳號）' : '（需設定 Supabase）'
      results = [
        { similarity: 94, title: `[示範資料] 非真實掃描結果 ${modeNote}`, artist: '—', platform: 'Demo', url: '#' },
        { similarity: 81, title: '[示範資料] 完成後端設定後才會執行真實 ACRCloud 比對', artist: '—', platform: 'Demo', url: '#' },
      ]
      provenance = '⚠ 示範資料 — 這不是真實掃描（未登入或未設定後端）'
    }

    radarScanning = false
    const now = new Date()
    setProvenance(provenance, isReal ? 'real' : 'demo')
    if (statusEl) statusEl.textContent = `完成 · ${now.toLocaleDateString('zh-TW')}`
    if (scanBtn)  { scanBtn.classList.remove('scanning'); scanBtn.textContent = '重新掃描' }

    work.results  = results
    work.lastScan = now.toISOString()

    const trackNameEl = document.getElementById('scan-track-name')
    const matchesEl   = document.getElementById('scan-matches-count')
    const lastTimeEl  = document.getElementById('scan-last-time')
    if (trackNameEl) trackNameEl.textContent = work.name
    if (matchesEl)   matchesEl.textContent   = results.length
    if (lastTimeEl)  lastTimeEl.textContent  = now.toLocaleDateString('zh-TW')
    if (countEl) countEl.textContent = `${results.length} 筆`

    renderResults(work)
    renderWorksList()

  } catch (err) {
    radarScanning = false
    // code 3001 = the key is valid but sent to the wrong regional host.
    const hint = /3001|Invalid Access Key/i.test(err.message)
      ? '（金鑰有效但區域選錯 — 到設定把「ACRCloud 區域」改成你專案頁顯示的 Host 再存一次）'
      : ''
    if (statusEl) statusEl.textContent = `掃描失敗：${err.message}${hint}`
    setProvenance(`掃描失敗：${err.message}${hint}`, 'error')
    if (scanBtn)  { scanBtn.classList.remove('scanning'); scanBtn.textContent = '重試' }
    console.error('[ACRCloud scan]', err)
  }
}

// ── Render helpers ────────────────────────────────────────

// Build one result row element.
function renderWorksList() {
  const listEl = document.getElementById('works-list')
  if (!listEl) return

  if (!works.length) {
    listEl.innerHTML = `
      <div class="works-empty">
        <div class="works-empty-icon">♪</div>
        <div class="works-empty-text">點擊「+ 新增」上傳您的原創作品，建立作品記錄後即可執行 ACRCloud 比對掃描（需設定後端）。</div>
      </div>`
    return
  }

  const fragment = document.createDocumentFragment()
  for (const w of works) {
    const card = document.createElement('div')
    card.className = `work-card${w.id === activeWorkId ? ' active' : ''}`
    card.dataset.id = w.id

    const title = document.createElement('div')
    title.className = 'work-card-title'
    title.textContent = w.name   // textContent → XSS-safe
    title.title       = w.name

    const meta = document.createElement('div')
    meta.className = 'work-card-meta'
    const fpDot = document.createElement('div')
    fpDot.className = 'work-card-fp'
    const dot = document.createElement('div')
    dot.className = `fp-dot${w.fingerprint ? ' ok' : ''}`
    const fpLabel = document.createElement('span')
    // Honest status: fingerprint=true only after a REAL extraction succeeds
    // (not yet implemented) — until then the record exists but no fingerprint.
    fpLabel.textContent = w.fingerprint ? '指紋已建立' : '已建立作品記錄'
    fpDot.append(dot, fpLabel)
    const scanTime = document.createElement('span')
    scanTime.textContent = w.lastScan
      ? `· ${new Date(w.lastScan).toLocaleDateString('zh-TW')}`
      : '· 未掃描'
    meta.append(fpDot, scanTime)

    const actions = document.createElement('div')
    actions.className = 'work-card-actions'

    const scanBtn = document.createElement('button')
    scanBtn.className = 'work-scan-btn'
    scanBtn.dataset.id = w.id
    scanBtn.textContent = w.results?.length ? '重新掃描' : '快速掃描'
    scanBtn.setAttribute('data-tooltip', '取樣前 15 秒比對 ACRCloud（最快）')
    scanBtn.addEventListener('click', e => {
      e.stopPropagation()
      scanWork(w)
    })

    const fullScanBtn = document.createElement('button')
    fullScanBtn.className = 'work-scan-btn full'
    fullScanBtn.textContent = '完整掃描'
    fullScanBtn.setAttribute('data-tooltip', '掃描整首多個段落，抓得到只被偷一段（副歌）的盜用')
    fullScanBtn.addEventListener('click', e => {
      e.stopPropagation()
      scanWorkComplete(w)
    })

    const delBtn = document.createElement('button')
    delBtn.className = 'work-del-btn'
    delBtn.dataset.del = w.id
    delBtn.setAttribute('aria-label', '刪除')
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', async e => {
      e.stopPropagation()
      const idx = works.findIndex(x => x.id === w.id)
      if (idx !== -1) works.splice(idx, 1)
      if (supabase && currentUser) {
        await supabase.from('works').delete().eq('id', w.id)
      }
      renderWorksList()
    })

    actions.append(scanBtn, fullScanBtn, delBtn)
    card.append(title, meta, actions)

    card.addEventListener('click', () => {
      activeWorkId = w.id
      const trackNameEl  = document.getElementById('scan-track-name')
      const matchesEl    = document.getElementById('scan-matches-count')
      const lastTimeEl   = document.getElementById('scan-last-time')
      const st           = document.getElementById('scan-status-text')
      if (trackNameEl) trackNameEl.textContent = w.name
      if (st) st.textContent = w.lastScan
        ? `上次掃描 ${new Date(w.lastScan).toLocaleDateString('zh-TW')}`
        : '未掃描'
      if (matchesEl) matchesEl.textContent = w.results?.length ?? '—'
      if (lastTimeEl) lastTimeEl.textContent = w.lastScan
        ? new Date(w.lastScan).toLocaleDateString('zh-TW')
        : '—'
      const countEl = document.getElementById('scan-results-count')
      if (countEl) countEl.textContent = `${w.results?.length ?? 0} 筆`
      renderResults(w)
      renderWorksList()
    })

    fragment.appendChild(card)
  }

  listEl.replaceChildren(fragment)
}

// ── Radar canvas animation ────────────────────────────────
let radarAnim    = null
let radarScanning = false

function startRadar() {
  const canvas = document.getElementById('acr-radar-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height, CX = W / 2, CY = H / 2, R = W / 2 - 8
  let angle = 0

  function draw() {
    ctx.clearRect(0, 0, W, H)

    // Background circle
    ctx.beginPath()
    ctx.arc(CX, CY, R, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(78,205,196,0.04)'
    ctx.fill()

    // Concentric rings
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath()
      ctx.arc(CX, CY, R * (i / 4), 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(78,205,196,0.15)'
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Cross hairs
    ctx.strokeStyle = 'rgba(78,205,196,0.1)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(CX - R, CY); ctx.lineTo(CX + R, CY); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(CX, CY - R); ctx.lineTo(CX, CY + R); ctx.stroke()

    if (radarScanning) {
      ctx.save()
      ctx.translate(CX, CY)
      ctx.rotate(angle)

      const sweep = ctx.createRadialGradient(0, 0, 0, 0, 0, R)
      sweep.addColorStop(0, 'rgba(78,205,196,0.3)')
      sweep.addColorStop(1, 'rgba(78,205,196,0)')

      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.arc(0, 0, R, -0.5, 0)
      ctx.closePath()
      ctx.fillStyle = sweep
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(R, 0)
      ctx.strokeStyle = '#4ECDC4'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.restore()
      angle += 0.04
    }

    // Center dot
    ctx.beginPath()
    ctx.arc(CX, CY, 4, 0, Math.PI * 2)
    ctx.fillStyle = radarScanning ? '#4ECDC4' : 'rgba(78,205,196,0.4)'
    ctx.fill()

    radarAnim = requestAnimationFrame(draw)
  }

  if (radarAnim) cancelAnimationFrame(radarAnim)
  draw()
}

// ── Tutorial toggle ───────────────────────────────────────
function initTutorial() {
  const toggle = document.getElementById('tutorial-toggle')
  const body   = document.getElementById('tutorial-body')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', String(!open))
    body.classList.toggle('open', !open)
  })
}

// ── Auth modal wiring ─────────────────────────────────────
function initAuthModal() {
  const modal      = document.getElementById('auth-modal')
  const closeBtn   = document.getElementById('modal-close')
  const emailInput = document.getElementById('auth-email')
  const passInput  = document.getElementById('auth-password')
  const submitBtn  = document.getElementById('auth-submit')
  const googleBtn  = document.getElementById('auth-google')
  const msgEl      = document.getElementById('auth-message')
  const tabSignIn  = document.getElementById('auth-tab-signin')
  const tabSignUp  = document.getElementById('auth-tab-signup')

  renderBackendState(backend.state)
  document.getElementById('auth-retry')?.addEventListener('click', connectAccount)

  let isSignUp = false

  function setMsg(text, isError = false) {
    if (!msgEl) return
    msgEl.textContent = text
    msgEl.style.color = isError ? 'var(--c-primary)' : 'var(--c-green)'
  }

  tabSignIn?.addEventListener('click', () => {
    isSignUp = false
    tabSignIn.classList.add('active')
    tabSignUp?.classList.remove('active')
    if (submitBtn) submitBtn.textContent = '登入'
    setMsg('')
  })

  tabSignUp?.addEventListener('click', () => {
    isSignUp = true
    tabSignUp.classList.add('active')
    tabSignIn?.classList.remove('active')
    if (submitBtn) submitBtn.textContent = '註冊'
    setMsg('')
  })

  submitBtn?.addEventListener('click', async () => {
    const email = emailInput?.value?.trim()
    const pass  = passInput?.value ?? ''
    if (!email || !pass) { setMsg('請填寫 Email 和密碼', true); return }

    submitBtn.disabled = true
    submitBtn.textContent = isSignUp ? '註冊中...' : '登入中...'
    setMsg('')

    try {
      if (!supabase) throw new Error(backend.state.message)
      const { error } = await supabase.auth[isSignUp ? 'signUp' : 'signInWithPassword']({ email, password: pass })
      if (error) throw error
      setMsg(isSignUp ? '已寄出驗證信，請確認後再登入' : '登入成功！')
      if (!isSignUp) setTimeout(() => modal?.classList.remove('open'), 1000)
    } catch (error) {
      setMsg(error.message, true)
    } finally {
      submitBtn.disabled = backend.state.status !== 'ready'
      submitBtn.textContent = isSignUp ? '註冊' : '登入'
    }
  })

  googleBtn?.addEventListener('click', async () => {
    googleBtn.disabled = true
    setMsg('正在開啟 Google 登入…')
    try { await signInGoogle() }
    catch (error) { setMsg(error.message, true) }
    finally { googleBtn.disabled = backend.state.status !== 'ready' }
  })

  closeBtn?.addEventListener('click', () => modal?.classList.remove('open'))
  modal?.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open')
  })
}

function renderBackendState({ status, message }) {
  const notice = document.getElementById('auth-backend-notice')
  if (notice) { notice.hidden = status === 'ready'; notice.textContent = message }
  for (const id of ['auth-submit', 'auth-google']) {
    const button = document.getElementById(id)
    if (button) button.disabled = status !== 'ready'
  }
  const retry = document.getElementById('auth-retry')
  if (retry) { retry.hidden = status !== 'unavailable'; retry.disabled = status === 'checking' }
  const info = document.getElementById('auth-user-info')
  if (info && status === 'unavailable') info.textContent = '帳號服務暫時無法連線'
}

async function connectAccount() {
  const client = await backend.connect()
  if (!client || supabase === client) return
  supabase = client
  // Auth callbacks hold the SDK lock. Defer database work until it is released,
  // and load account data only when the user changes, not on every token refresh.
  supabase.auth.onAuthStateChange((event, session) => {
    const previousId = currentUser?.id
    currentUser = session?.user ? { id: session.user.id, email: session.user.email } : null
    if (previousId && previousId !== currentUser?.id) clearAccountData()
    checkAuthOverlay()
    if (currentUser && currentUser.id !== previousId) {
      const uid = currentUser.id
      setTimeout(() => {
        if (currentUser?.id !== uid) return
        loadUserSettings(uid)
        loadWorksFromDB()
      }, 0)
    }
  })
}

// ── Public init ───────────────────────────────────────────
export function initAntiTheft() {
  // Listen for mode-nav trigger
  document.addEventListener('wf:check-auth', () => checkAuthOverlay())

  // Start radar animation
  startRadar()
  initTutorial()
  initAuthModal()

  // Restore guest-mode ACR key from localStorage (Secret is never persisted)
  if (!SUPABASE_CONFIGURED) {
    // Purge any Secret persisted by older builds — must not live in localStorage
    localStorage.removeItem('acr-api-secret')
    const storedKey = localStorage.getItem('acr-api-key')
    if (storedKey) { acrAccessKey = storedKey; const el = document.getElementById('acr-api-key'); if (el) el.value = storedKey }
  }

  // ACRCloud settings save button
  document.getElementById('acr-key-save')?.addEventListener('click', saveSettings)

  // Spotify settings save button
  document.getElementById('spotify-key-save')?.addEventListener('click', saveSpotifySettings)

  // Spotify tutorial collapse
  const spTutToggle = document.getElementById('spotify-tutorial-toggle')
  const spTutBody   = document.getElementById('spotify-tutorial-body')
  spTutToggle?.addEventListener('click', () => {
    const open = spTutToggle.getAttribute('aria-expanded') === 'true'
    spTutToggle.setAttribute('aria-expanded', String(!open))
    spTutBody?.classList.toggle('open', !open)
  })

  // Email notify toggle
  document.getElementById('email-notify-toggle')?.addEventListener('change', e => {
    saveEmailNotify(e.target.checked)
  })

  // Works file input
  document.getElementById('works-file-input')?.addEventListener('change', e => {
    const file = e.target.files?.[0]
    if (file) handleWorksUpload(file)
    e.target.value = ''
  })

  // Settings auth button (login / logout)
  document.getElementById('settings-auth-btn')?.addEventListener('click', () => {
    if (currentUser) {
      signOut()
    } else {
      document.getElementById('auth-modal')?.classList.add('open')
    }
  })

  // Avatar dropdown menu (top-right) — the primary, discoverable logout
  const avatarBtn = document.getElementById('auth-avatar')
  const avatarMenu = document.getElementById('auth-menu')
  const menuEmail = document.getElementById('auth-menu-email')
  const menuLogout = document.getElementById('auth-menu-logout')

  function toggleAvatarMenu(show) {
    if (!avatarMenu || !avatarBtn) return
    const open = show ?? avatarMenu.hidden
    avatarMenu.hidden = !open
    avatarBtn.setAttribute('aria-expanded', String(open))
    if (open && menuEmail) menuEmail.textContent = currentUser?.email ?? ''
  }

  avatarBtn?.addEventListener('click', (e) => { e.stopPropagation(); toggleAvatarMenu() })
  menuLogout?.addEventListener('click', () => { toggleAvatarMenu(false); signOut() })
  // Click outside closes the menu
  document.addEventListener('click', (e) => {
    if (avatarMenu && !avatarMenu.hidden && !avatarMenu.contains(e.target) && e.target !== avatarBtn) {
      toggleAvatarMenu(false)
    }
  })

  // Auth overlay CTA
  document.getElementById('auth-cta-btn')?.addEventListener('click', () => {
    document.getElementById('auth-modal')?.classList.add('open')
  })

  connectAccount()

  if (!SUPABASE_CONFIGURED) {
    const panel = document.querySelector('#mode-antitheft .antitheft-panel')
    const banner = document.createElement('div')
    banner.className = 'guest-mode-banner'
    const msg = document.createElement('span')
    msg.textContent = '訪客模式：掃描結果為 Demo 資料。設定 Supabase 可啟用完整功能（真實 ACRCloud 掃描、帳號同步）。'
    banner.appendChild(msg)
    panel?.before(banner)
  }
}
