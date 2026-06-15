/**
 * Anti-Theft Detection — Supabase Auth + ACRCloud 音訊指紋比對
 *
 * 模式：
 *   SUPABASE_READY=false → 訪客模式（localStorage ACR key，Demo 掃描結果）
 *   SUPABASE_READY=true  → 完整模式（Supabase 帳號 + Edge Function 呼叫 ACRCloud）
 */

import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY, ACR_EDGE_FN, SUPABASE_READY } from './config.js'
import { fetchUrlMeta, detectPlatform } from './audio/url-meta.js'

// ── Supabase client (lazy init) ───────────────────────────
const supabase = SUPABASE_READY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

// ── Auth state ────────────────────────────────────────────
let currentUser = null     // { id, email } | null
let acrAccessKey = ''
let acrAccessSecret = ''
let emailNotify = true

// ── Works library (in-memory; synced to DB in live mode) ──
const works = []   // [{ id, name, file, fingerprint, lastScan, results }]
let activeWorkId = null

// ── Helpers ───────────────────────────────────────────────
function safeHref(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') ? url : '#'
  } catch { return '#' }
}

// ── Auth overlay ──────────────────────────────────────────
export function checkAuthOverlay() {
  const overlay  = document.getElementById('auth-required-overlay')
  const infoEl   = document.getElementById('auth-user-info')
  const loginBtn = document.getElementById('auth-login-pill')
  const settingsBtn = document.getElementById('settings-auth-btn')
  const avatarEl = document.getElementById('auth-avatar')

  const shouldBlock = SUPABASE_READY && !currentUser
  if (overlay) overlay.classList.toggle('visible', shouldBlock)

  if (currentUser) {
    const initial = (currentUser.email?.[0] ?? '?').toUpperCase()
    if (infoEl)     infoEl.textContent = currentUser.email ?? ''
    if (avatarEl)   { avatarEl.hidden = false; avatarEl.textContent = initial }
    if (loginBtn)   loginBtn.hidden = true
    if (settingsBtn) settingsBtn.textContent = '登出'
  } else {
    if (infoEl)     infoEl.textContent = SUPABASE_READY ? '未登入' : '訪客模式'
    if (avatarEl)   avatarEl.hidden = true
    if (loginBtn)   loginBtn.hidden = false
    if (settingsBtn) settingsBtn.textContent = '登入 / 註冊'
  }
}

// ── Supabase auth methods ─────────────────────────────────
async function signInEmail(email, password) {
  if (!supabase) return { error: new Error('Supabase 未設定') }
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { data, error }
}

async function signUpEmail(email, password) {
  if (!supabase) return { error: new Error('Supabase 未設定') }
  const { data, error } = await supabase.auth.signUp({ email, password })
  return { data, error }
}

async function signInGoogle() {
  if (!supabase) return
  await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.href },
  })
}

async function signOut() {
  if (supabase) await supabase.auth.signOut()
  currentUser = null
  acrAccessKey = ''
  acrAccessSecret = ''
  checkAuthOverlay()
}

// ── Load user settings from Supabase ─────────────────────
async function loadUserSettings(userId) {
  if (!supabase) return
  const { data } = await supabase
    .from('user_settings')
    .select('acr_access_key, acr_access_secret, email_notify')
    .eq('user_id', userId)
    .single()

  if (data) {
    acrAccessKey    = data.acr_access_key ?? ''
    acrAccessSecret = data.acr_access_secret ?? ''
    emailNotify     = data.email_notify ?? true

    const keyInput   = document.getElementById('acr-api-key')
    const secretInput = document.getElementById('acr-api-secret')
    const notifyToggle = document.getElementById('email-notify-toggle')
    if (keyInput && acrAccessKey) keyInput.value = acrAccessKey
    if (secretInput && acrAccessSecret) secretInput.value = '••••••••••••'
    if (notifyToggle) notifyToggle.checked = emailNotify
  }
}

// ── Load user's works from Supabase DB ────────────────────
async function loadWorksFromDB() {
  if (!supabase || !currentUser) return
  const { data, error } = await supabase
    .from('works')
    .select('id, name, fingerprint_ok, last_scan')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })

  if (error || !data) return

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

// ── Save ACRCloud settings ────────────────────────────────
async function saveSettings() {
  const keyInput    = document.getElementById('acr-api-key')
  const secretInput = document.getElementById('acr-api-secret')
  const saveBtn     = document.getElementById('acr-key-save')

  const newKey    = keyInput?.value?.trim() ?? ''
  const newSecret = secretInput?.value?.trim() ?? ''
  if (!newKey) return

  acrAccessKey    = newKey
  if (newSecret && newSecret !== '••••••••••••') acrAccessSecret = newSecret

  if (supabase && currentUser) {
    await supabase.from('user_settings').upsert({
      user_id:           currentUser.id,
      acr_access_key:    acrAccessKey,
      acr_access_secret: acrAccessSecret || undefined,
    })
  } else {
    // Guest mode → localStorage
    localStorage.setItem('acr-api-key',    acrAccessKey)
    if (acrAccessSecret) localStorage.setItem('acr-api-secret', acrAccessSecret)
  }

  if (saveBtn) {
    saveBtn.textContent = '已儲存 ✓'
    saveBtn.classList.add('saved')
    setTimeout(() => { saveBtn.textContent = '儲存'; saveBtn.classList.remove('saved') }, 2000)
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
    // Save to DB
    const { data, error } = await supabase.from('works').insert({
      id:             id,
      user_id:        currentUser.id,
      name:           work.name,
      file_size_bytes: file.size,
      fingerprint_ok: false,
    }).select('id').single()

    if (!error && data) work.id = data.id
  }

  // Simulate fingerprint extraction (Phase 3: real ACRCloud fingerprint endpoint)
  setTimeout(() => {
    work.fingerprint = true
    if (supabase && currentUser) {
      supabase.from('works').update({ fingerprint_ok: true }).eq('id', work.id)
    }
    renderWorksList()
  }, 1500)
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

  radarScanning = true
  if (statusEl) statusEl.textContent = '掃描中...'
  if (scanBtn)  { scanBtn.classList.add('scanning'); scanBtn.textContent = '掃描中...' }

  try {
    let results

    if (SUPABASE_READY && currentUser && work.file) {
      // ── Live mode: call Supabase Edge Function ────────
      const sample = await extractAudioSample(work.file, 30)
      const session = (await supabase.auth.getSession()).data.session
      const res = await fetch(ACR_EDGE_FN, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          work_id:     work.id,
          audio_base64: sample,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      results = json.results ?? []
    } else {
      // ── Demo mode: show stub results ──────────────────
      await new Promise(r => setTimeout(r, 3000))
      const modeNote = SUPABASE_READY ? '（需登入帳號）' : '（需設定 Supabase）'
      results = [
        { similarity: 94, title: `待 ACRCloud 回傳 ${modeNote}`, artist: '—', platform: 'ACRCloud', url: '#' },
        { similarity: 81, title: '請完成後端設定後重試', artist: '—', platform: 'ACRCloud', url: '#' },
      ]
    }

    radarScanning = false
    const now = new Date()
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
    if (statusEl) statusEl.textContent = `掃描失敗：${err.message}`
    if (scanBtn)  { scanBtn.classList.remove('scanning'); scanBtn.textContent = '重試' }
    console.error('[ACRCloud scan]', err)
  }
}

/** Extract first N seconds of audio as base64 WAV data URL */
async function extractAudioSample(file, durationSec) {
  const arr = await file.arrayBuffer()
  const ctx = new OfflineAudioContext(2, 48000 * durationSec, 48000)
  const decoded = await ctx.decodeAudioData(arr.slice(0))
  const src = ctx.createBufferSource()
  src.buffer = decoded
  src.connect(ctx.destination)
  src.start(0, 0, durationSec)
  const rendered = await ctx.startRendering()

  // Encode to WAV
  const numCh = rendered.numberOfChannels
  const len   = rendered.length
  const sr    = rendered.sampleRate
  const byteRate = sr * numCh * 2
  const dataBytes = len * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const dv  = new DataView(buf)
  const w   = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)) }

  w(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE')
  w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true)
  dv.setUint16(22, numCh, true); dv.setUint32(24, sr, true)
  dv.setUint32(28, byteRate, true); dv.setUint16(32, numCh * 2, true); dv.setUint16(34, 16, true)
  w(36, 'data'); dv.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, rendered.getChannelData(c)[i]))
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }

  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return `data:audio/wav;base64,${btoa(bin)}`
}

// ── Render helpers ────────────────────────────────────────
function renderResults(work) {
  const listEl = document.getElementById('scan-results-list')
  if (!listEl) return

  if (!work?.results?.length) {
    listEl.innerHTML = `<div class="scan-empty"><div style="font-size:32px;opacity:0.2">◎</div><div>尚無比對結果</div></div>`
    return
  }

  const fragment = document.createDocumentFragment()
  work.results.forEach((r, i) => {
    const cls = r.similarity >= 90 ? 'high' : r.similarity >= 70 ? 'mid' : 'low'

    const item = document.createElement('div')
    item.className = 'scan-result-item'
    item.style.animationDelay = `${i * 60}ms`

    const simEl = document.createElement('div')
    simEl.className = `result-similarity ${cls}`
    simEl.textContent = `${r.similarity}%`

    const infoEl = document.createElement('div')
    infoEl.className = 'result-info'

    const titleEl = document.createElement('div')
    titleEl.className = 'result-title'
    titleEl.textContent = r.title ?? ''

    const metaEl = document.createElement('div')
    metaEl.className = 'result-meta'

    const artistEl = document.createElement('span')
    artistEl.textContent = r.artist ?? ''

    const platformEl = document.createElement('span')
    platformEl.className = 'result-platform'
    platformEl.textContent = r.platform ?? ''

    metaEl.append(artistEl, platformEl)
    infoEl.append(titleEl, metaEl)

    const linkEl = document.createElement('a')
    linkEl.className = 'result-link'
    linkEl.href = safeHref(r.url)
    linkEl.target = '_blank'
    linkEl.rel = 'noopener noreferrer'
    linkEl.setAttribute('aria-label', r.platform ? `前往 ${r.platform}` : '前往平台')
    linkEl.textContent = '↗'

    item.append(simEl, infoEl, linkEl)
    fragment.appendChild(item)
  })

  listEl.replaceChildren(fragment)
}

function renderWorksList() {
  const listEl = document.getElementById('works-list')
  if (!listEl) return

  if (!works.length) {
    listEl.innerHTML = `
      <div class="works-empty">
        <div class="works-empty-icon">♪</div>
        <div class="works-empty-text">點擊「+ 新增」上傳您的原創作品，WaveForge 會萃取音訊指紋存入資料庫。</div>
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
    fpLabel.textContent = w.fingerprint ? '指紋已建立' : '建立中...'
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
    scanBtn.textContent = w.results?.length ? '重新掃描' : '掃描'
    scanBtn.addEventListener('click', e => {
      e.stopPropagation()
      scanWork(w)
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

    actions.append(scanBtn, delBtn)
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

// ── Demucs progress canvas (shared with stems-mastering) ──
let demucsAnim    = null
let demucsRunning = false

export function startDemucsAnimation() {
  const canvas = document.getElementById('demucs-canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const W = canvas.width, H = canvas.height
  const COLORS = ['#FF4B6E', '#4ECDC4', '#FFE66D', '#FD9644']
  const BARS   = 28
  const phase  = Array.from({ length: BARS }, (_, i) => (i / BARS) * Math.PI * 2)
  let t = 0
  demucsRunning = true

  function draw() {
    if (!demucsRunning) return
    ctx.clearRect(0, 0, W, H)
    const bw = (W - (BARS - 1) * 2) / BARS

    for (let i = 0; i < BARS; i++) {
      const colorIdx = Math.floor((i / BARS) * COLORS.length)
      const height   = (0.3 + 0.7 * Math.abs(Math.sin(phase[i] + t))) * H * 0.85
      const y        = (H - height) / 2
      ctx.fillStyle  = COLORS[colorIdx] + 'CC'
      ctx.beginPath()
      if (ctx.roundRect) {
        ctx.roundRect(i * (bw + 2), y, bw, height, 2)
      } else {
        ctx.rect(i * (bw + 2), y, bw, height)
      }
      ctx.fill()
    }

    t += 0.08
    demucsAnim = requestAnimationFrame(draw)
  }

  if (demucsAnim) cancelAnimationFrame(demucsAnim)
  draw()
}

export function stopDemucsAnimation() {
  demucsRunning = false
  if (demucsAnim) cancelAnimationFrame(demucsAnim)
  demucsAnim = null
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

  // Show backend status notice when Supabase is not configured
  if (!SUPABASE_READY) {
    const notice = document.getElementById('auth-backend-notice')
    if (notice) notice.hidden = false
    if (submitBtn) { submitBtn.disabled = true; submitBtn.setAttribute('data-tooltip', '後端未設定，無法登入') }
    if (googleBtn) { googleBtn.disabled = true; googleBtn.setAttribute('data-tooltip', '後端未設定，無法登入') }
  }

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

    const fn = isSignUp ? signUpEmail : signInEmail
    const { error } = await fn(email, pass)

    if (error) {
      setMsg(error.message, true)
    } else {
      setMsg(isSignUp ? '已寄出驗證信，請確認後再登入' : '登入成功！')
      if (!isSignUp) setTimeout(() => modal?.classList.remove('open'), 1000)
    }

    submitBtn.disabled = false
    submitBtn.textContent = isSignUp ? '註冊' : '登入'
  })

  googleBtn?.addEventListener('click', () => signInGoogle())

  closeBtn?.addEventListener('click', () => modal?.classList.remove('open'))
  modal?.addEventListener('click', e => {
    if (e.target === modal) modal.classList.remove('open')
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

  // Restore guest-mode ACR key from localStorage
  if (!SUPABASE_READY) {
    const storedKey    = localStorage.getItem('acr-api-key')
    const storedSecret = localStorage.getItem('acr-api-secret')
    if (storedKey)    { acrAccessKey = storedKey; const el = document.getElementById('acr-api-key'); if (el) el.value = storedKey }
    if (storedSecret) acrAccessSecret = storedSecret
  }

  // ── URL detection ─────────────────────────────────────────
  const urlInput  = document.getElementById('url-detect-input')
  const urlBtn    = document.getElementById('url-detect-btn')
  const urlResult = document.getElementById('url-detect-result')

  function renderUrlResult(meta) {
    if (!urlResult) return
    urlResult.hidden = false
    urlResult.replaceChildren()

    const row = document.createElement('div')
    row.className = 'url-result-row'

    if (meta.thumbnailUrl) {
      const img = document.createElement('img')
      img.src = safeHref(meta.thumbnailUrl)  // reuse existing protocol validator
      img.alt = ''
      img.className = 'url-result-thumb'
      img.loading = 'lazy'
      row.appendChild(img)
    }

    const info = document.createElement('div')
    info.className = 'url-result-info'

    const platform = document.createElement('span')
    platform.className = 'url-result-platform'
    platform.textContent = meta.platform

    const title = document.createElement('div')
    title.className = 'url-result-title'
    title.textContent = meta.title ?? '（無標題）'

    const author = document.createElement('div')
    author.className = 'url-result-author'
    author.textContent = meta.authorName ?? ''

    info.append(platform, title, author)
    row.appendChild(info)
    urlResult.appendChild(row)

    const note = document.createElement('div')
    note.className = 'url-result-note'
    note.textContent = '已擷取元資料。如需音訊指紋比對，請上傳該曲目的音訊檔至「我的作品庫」。'
    urlResult.appendChild(note)
  }

  function renderUrlError(msg) {
    if (!urlResult) return
    urlResult.hidden = false
    urlResult.replaceChildren()
    const err = document.createElement('div')
    err.className = 'url-result-error'
    err.textContent = msg
    urlResult.appendChild(err)
  }

  async function doUrlDetect() {
    const raw = urlInput?.value?.trim()
    if (!raw) return
    if (urlBtn) { urlBtn.disabled = true; urlBtn.textContent = '查詢中...' }
    if (urlResult) urlResult.hidden = true

    try {
      const platform = detectPlatform(raw)
      if (platform === 'SUNO') {
        renderUrlError('SUNO 無公開 API，無法自動擷取資訊')
        return
      }
      const meta = await fetchUrlMeta(raw)
      renderUrlResult(meta)
    } catch (err) {
      renderUrlError(err.message)
    } finally {
      if (urlBtn) { urlBtn.disabled = false; urlBtn.textContent = '查詢' }
    }
  }

  urlBtn?.addEventListener('click', doUrlDetect)
  urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doUrlDetect() })

  // ACRCloud settings save button
  document.getElementById('acr-key-save')?.addEventListener('click', saveSettings)

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

  // Auth overlay CTA
  document.getElementById('auth-cta-btn')?.addEventListener('click', () => {
    document.getElementById('auth-modal')?.classList.add('open')
  })

  // Supabase auth state listener
  if (supabase) {
    supabase.auth.onAuthStateChange(async (event, session) => {
      currentUser = session?.user
        ? { id: session.user.id, email: session.user.email }
        : null

      checkAuthOverlay()

      if (currentUser) {
        await loadUserSettings(currentUser.id)
        await loadWorksFromDB()
      }
    })

    // Restore session on page load
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        currentUser = { id: session.user.id, email: session.user.email }
        checkAuthOverlay()
        loadUserSettings(currentUser.id)
        loadWorksFromDB()
      }
    })
  }

  // Show mode note if Supabase not configured
  if (!SUPABASE_READY) {
    const modeNote = document.getElementById('auth-user-info')
    if (modeNote) modeNote.textContent = '訪客模式 — 掃描為 Demo 結果'
  }

  if (!SUPABASE_READY) {
    const panel = document.querySelector('#mode-antitheft .antitheft-panel')
    const banner = document.createElement('div')
    banner.className = 'guest-mode-banner'
    const msg = document.createElement('span')
    msg.textContent = '訪客模式：掃描結果為 Demo 資料。設定 Supabase 可啟用完整功能（真實 ACRCloud 掃描、帳號同步）。'
    banner.appendChild(msg)
    panel?.prepend(banner)
  }
}
