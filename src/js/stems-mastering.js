/**
 * Stems Mastering — Demucs 分軌 + 每軌 EQ/壓縮 + Bounce 回主鏈
 *
 * 模式：
 *   HF_READY=false → 5 秒模擬分軌（UI 展示）
 *   HF_READY=true  → 呼叫 HF Spaces Gradio API（真實 Demucs htdemucs）
 *
 * Bounce 流程：
 *   每軌: buffer → lowShelf → midPeak → highShelf → DynamicsCompressor → gain
 *   Mix: 4 軌加總 → peak normalize
 *   載入: 發送 CustomEvent 'wf:stem-bounce'，main.js 接收後載入母帶鏈
 */

import WaveSurfer from 'wavesurfer.js'
import { startDemucsAnimation, stopDemucsAnimation } from './antitheft.js'
import { HF_ENDPOINT, HF_READY } from './config.js'

// ── Stem metadata ─────────────────────────────────────────
const STEM_META = [
  { key: 'vocals', label: '人聲', color: '#FF4B6E', bg: 'var(--stem-vocals-bg)' },
  { key: 'drums',  label: '鼓組', color: '#4ECDC4', bg: 'var(--stem-drums-bg)' },
  { key: 'bass',   label: '貝斯', color: '#FFE66D', bg: 'var(--stem-bass-bg)' },
  { key: 'other',  label: '其他', color: '#FD9644', bg: 'var(--stem-other-bg)' },
]

// ── Per-stem DSP params ───────────────────────────────────
const stemParams = {}
const stemVolumes = {}
STEM_META.forEach(m => {
  stemParams[m.key]  = { lowGain: 0, midGain: 0, highGain: 0, thresh: -24, ratio: 4 }
  stemVolumes[m.key] = 1.0
})

// ── Stem audio buffers (set after Demucs returns) ─────────
const stemBuffers = {}          // AudioBuffer per stem key
const stemWaveSurfers = {}      // WaveSurfer per stem key

// ── Helpers ───────────────────────────────────────────────

/** Convert File to data URL */
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/** Decode base64 audio data URL → AudioBuffer */
async function decodeBase64Audio(dataURL) {
  const b64 = dataURL.replace(/^data:[^;]+;base64,/, '')
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const ctx = new AudioContext()
  try {
    return await ctx.decodeAudioData(bytes.buffer.slice(0))
  } finally {
    await ctx.close()
  }
}

/** Fetch a Gradio file URL and return as ArrayBuffer */
async function fetchGradioFile(baseUrl, filePath) {
  const res = await fetchWithTimeout(`${baseUrl}/file=${encodeURIComponent(filePath)}`,
    {}, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載')
  if (!res.ok) throw new Error(`分軌檔下載失敗（HTTP ${res.status}）`)
  return res.arrayBuffer()
}

// HF Spaces limits — reject before uploading to avoid wasted minutes
const HF_MAX_FILE_BYTES = 50 * 1024 * 1024   // 50 MB
const HF_UPLOAD_TIMEOUT_MS  = 60_000          // 1 min for the upload leg
const HF_PREDICT_TIMEOUT_MS = 600_000         // 10 min for Demucs inference

function fetchWithTimeout(url, options, timeoutMs, label) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch(err => {
      if (err.name === 'AbortError') throw new Error(`${label} 逾時（${Math.round(timeoutMs / 1000)} 秒），請稍後重試`)
      throw err
    })
    .finally(() => clearTimeout(t))
}

/** Call HF Spaces Gradio API — upload file then predict */
async function callHFDemucs(file) {
  const base = HF_ENDPOINT.replace(/\/$/, '')

  if (file.size > HF_MAX_FILE_BYTES) {
    throw new Error(`檔案 ${(file.size / 1024 / 1024).toFixed(1)}MB 超過分軌上限 50MB，請先裁剪或壓縮`)
  }

  // Gradio 5+ moved every API route under /gradio_api/ (verified live:
  // /upload → 404, /gradio_api/upload → 200 on gradio 6.19). Probe the
  // prefixed route first, keep the bare route as a Gradio 4 fallback.
  const uploadForm = new FormData()
  uploadForm.append('files', file, file.name)
  let apiRoot = `${base}/gradio_api`
  let uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
    method: 'POST',
    body: uploadForm,
  }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳')
  if (uploadRes.status === 404) {
    apiRoot = base   // Gradio 4: no prefix
    const retryForm = new FormData()
    retryForm.append('files', file, file.name)
    uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
      method: 'POST',
      body: retryForm,
    }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳')
  }
  if (!uploadRes.ok) throw new Error(`HF 上傳失敗（HTTP ${uploadRes.status}）— 請確認 Space 是否在執行中`)
  const uploaded = await uploadRes.json()
  const tmpPath = Array.isArray(uploaded) ? uploaded[0] : uploaded

  // Step 2: POST /call/separate returns an event_id, then
  // GET /call/separate/{event_id} streams the result as SSE.
  // (api_name="separate" is declared in hf-space/app.py; never rely on fn_index.)
  const payload = { data: [{ path: tmpPath, meta: { _type: 'gradio.FileData' } }] }
  const submitRes = await fetchWithTimeout(`${apiRoot}/call/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, HF_UPLOAD_TIMEOUT_MS, 'Demucs 任務送出')
  if (!submitRes.ok) throw new Error(`Demucs 任務送出失敗（HTTP ${submitRes.status}）— Space 可能休眠或未部署 separate API`)
  const { event_id: eventId } = await submitRes.json()
  if (!eventId) throw new Error('HF Space 未回傳 event_id，請確認 Gradio 版本 ≥ 4')

  // SSE stream: lines of "event: <type>" / "data: <json>"; wait for complete.
  const sseRes = await fetchWithTimeout(`${apiRoot}/call/separate/${eventId}`,
    {}, HF_PREDICT_TIMEOUT_MS, 'Demucs 分軌')
  if (!sseRes.ok) throw new Error(`Demucs 結果讀取失敗（HTTP ${sseRes.status}）`)

  const data = await new Promise(async (resolve, reject) => {
    const reader = sseRes.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let lastEvent = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()  // keep incomplete trailing line
        for (const line of lines) {
          if (line.startsWith('event:')) lastEvent = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            if (lastEvent === 'complete') { resolve(JSON.parse(raw)); return }
            if (lastEvent === 'error') {
              reject(new Error(`Demucs 分軌失敗：${raw === 'null' ? 'Space 內部錯誤（檔案過長或記憶體不足）' : raw}`))
              return
            }
            // 'generating' / 'heartbeat' → keep waiting
          }
        }
      }
      reject(new Error('Demucs 串流意外結束，未收到完成事件'))
    } catch (e) { reject(e) } finally { reader.releaseLock() }
  })

  // A response with no stem data = failure; never fabricate stems
  if (!Array.isArray(data) || data.every(d => !d)) {
    throw new Error('HF Space 未回傳任何分軌資料，請確認 Space 的 separate API 輸出格式')
  }

  // Step 3: Download each stem as AudioBuffer.
  // Gradio 4 FileData items usually carry a full `url`; fall back to /file={path}.
  const stemKeys = ['vocals', 'drums', 'bass', 'other']
  const result = {}
  for (let i = 0; i < stemKeys.length; i++) {
    const item = data?.[i]
    if (!item) { result[stemKeys[i]] = null; continue }
    let arr
    if (typeof item === 'object' && item.url) {
      const res = await fetchWithTimeout(item.url, {}, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載')
      if (!res.ok) throw new Error(`分軌檔下載失敗（HTTP ${res.status}）`)
      arr = await res.arrayBuffer()
    } else {
      const filePath = item.path ?? item.name ?? item
      arr = await fetchGradioFile(apiRoot, filePath)
    }
    const ctx = new AudioContext()
    try {
      result[stemKeys[i]] = await ctx.decodeAudioData(arr)
    } finally {
      await ctx.close()
    }
  }
  return result
}

/** Process one stem buffer through EQ + dynamics compression */
async function processStem(buffer, params, volume) {
  if (!buffer) return null
  const { lowGain, midGain, highGain, thresh, ratio } = params
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    buffer.length,
    buffer.sampleRate,
  )

  const src = ctx.createBufferSource()
  src.buffer = buffer

  // 3-band EQ
  const low = ctx.createBiquadFilter()
  low.type = 'lowshelf'; low.frequency.value = 200; low.gain.value = lowGain

  const mid = ctx.createBiquadFilter()
  mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.7; mid.gain.value = midGain

  const high = ctx.createBiquadFilter()
  high.type = 'highshelf'; high.frequency.value = 8000; high.gain.value = highGain

  // Dynamics compressor
  const comp = ctx.createDynamicsCompressor()
  comp.threshold.value = thresh
  comp.ratio.value     = ratio
  comp.knee.value      = 6
  comp.attack.value    = 0.003
  comp.release.value   = 0.25

  // Per-stem volume
  const gain = ctx.createGain()
  gain.gain.value = volume

  src.connect(low)
  low.connect(mid)
  mid.connect(high)
  high.connect(comp)
  comp.connect(gain)
  gain.connect(ctx.destination)
  src.start()

  return ctx.startRendering()
}

/** Sum all processed stem buffers and peak-normalize */
function mixBuffers(buffers) {
  const valid = buffers.filter(Boolean)
  if (!valid.length) return null

  const ch  = valid[0].numberOfChannels
  const len = Math.max(...valid.map(b => b.length))
  const sr  = valid[0].sampleRate

  const mixed = Array.from({ length: ch }, () => new Float32Array(len))

  for (const buf of valid) {
    for (let c = 0; c < ch; c++) {
      const data = buf.getChannelData(c)
      const dest = mixed[c]
      for (let i = 0; i < data.length; i++) dest[i] += data[i]
    }
  }

  // Peak normalize (prevent clipping)
  let peak = 0
  for (const chan of mixed) for (const s of chan) if (Math.abs(s) > peak) peak = Math.abs(s)
  if (peak > 0.99) for (const chan of mixed) for (let i = 0; i < chan.length; i++) chan[i] /= peak

  // Build output AudioBuffer using OfflineAudioContext (broadest compat)
  const tmpCtx = new OfflineAudioContext(ch, len, sr)
  const out    = tmpCtx.createBuffer(ch, len, sr)
  for (let c = 0; c < ch; c++) out.copyToChannel(mixed[c], c)
  return out
}

/** Mount a WaveSurfer instance into a stem card's waveform container */
function loadStemWaveSurfer(stemKey, buffer) {
  const container = document.getElementById(`stem-waveform-${stemKey}`)
  if (!container) return

  // Destroy any existing instance
  stemWaveSurfers[stemKey]?.destroy()

  const meta = STEM_META.find(m => m.key === stemKey)

  // Convert AudioBuffer → Blob → URL for WaveSurfer
  const sr = buffer.sampleRate
  const ch = buffer.numberOfChannels
  const pcm = []
  for (let c = 0; c < ch; c++) pcm.push(buffer.getChannelData(c))

  // Encode a minimal WAV header for WaveSurfer
  const wavBlob = pcmToWavBlob(pcm, sr)
  const url = URL.createObjectURL(wavBlob)

  const ws = WaveSurfer.create({
    container,
    waveColor:     meta.color + '66',
    progressColor: meta.color,
    height:        56,
    barWidth:      2,
    barGap:        1,
    barRadius:     2,
    normalize:     true,
    interact:      false,
  })
  ws.load(url)
  stemWaveSurfers[stemKey] = ws
}

/** Minimal 16-bit PCM WAV encoder */
function pcmToWavBlob(channels, sampleRate) {
  const numCh = channels.length
  const numFrames = channels[0].length
  const byteRate = sampleRate * numCh * 2
  const dataBytes = numFrames * numCh * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v   = new DataView(buf)
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }

  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, numCh, true); v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true); v.setUint16(32, numCh * 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, dataBytes, true)

  let off = 44
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([buf], { type: 'audio/wav' })
}

// ── Main separation flow ──────────────────────────────────
export async function separateStems(fileOrBlob) {
  const btnEl    = document.getElementById('stems-ai-btn')
  const wrapEl   = document.getElementById('demucs-progress-wrap')
  const etaEl    = document.getElementById('demucs-eta')
  const gridEl   = document.getElementById('stems-processing-grid')
  const bounceEl = document.getElementById('bounce-btn')

  if (!btnEl) return

  btnEl.classList.add('processing')
  btnEl.disabled  = true
  btnEl.textContent = '分軌中...'
  wrapEl?.classList.add('visible')
  startDemucsAnimation()

  // Honest elapsed timer — CPU Demucs has no reliable ETA (cold start + file
  // length vary wildly). Count UP, never fake a countdown that hits 0:00 while
  // the job is still running.
  const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed++
    if (!etaEl) return
    etaEl.textContent = elapsed < 240
      ? `處理中 ${fmtClock(elapsed)}（CPU 分軌通常需 2–5 分鐘）`
      : `處理中 ${fmtClock(elapsed)}（Space 冷啟動或檔案較長，請耐心等待）`
  }, 1000)

  try {
    if (HF_READY) {
      // ── Live mode: call HF Spaces ────────────────────────
      if (etaEl) etaEl.textContent = '上傳至 HF Spaces...'
      const file = fileOrBlob instanceof File ? fileOrBlob : new File([fileOrBlob], 'audio.wav')
      const stems = await callHFDemucs(file)

      STEM_META.forEach(m => {
        if (stems[m.key]) stemBuffers[m.key] = stems[m.key]
      })
    } else {
      // ── Demo mode: simulate 5-second wait ────────────────
      await new Promise(r => setTimeout(r, 5000))
    }

    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = '重新分軌'
    btnEl.disabled    = false
    if (etaEl) etaEl.textContent = HF_READY ? '分軌完成' : '分軌完成（示範）'

    renderStemCards(gridEl)

    // Load WaveSurfer per stem if we have real buffers
    if (HF_READY) {
      STEM_META.forEach(m => {
        if (stemBuffers[m.key]) loadStemWaveSurfer(m.key, stemBuffers[m.key])
      })
    }

    if (bounceEl) bounceEl.disabled = false
    const statusEl = document.getElementById('bounce-status')
    if (statusEl) statusEl.textContent = '各軌調整完成後點擊 Bounce'

  } catch (err) {
    clearInterval(timer)
    stopDemucsAnimation()
    wrapEl?.classList.remove('visible')
    btnEl.classList.remove('processing')
    btnEl.textContent = '重試分軌'
    btnEl.disabled    = false
    console.error('[Demucs]', err)
    const bsEl = document.getElementById('bounce-status')
    if (bsEl) bsEl.textContent = `分軌失敗：${err.message}`
  }
}

// ── Render per-stem processing cards ─────────────────────
function renderStemCards(container) {
  if (!container) return
  container.innerHTML = ''
  STEM_META.forEach(meta => container.appendChild(buildStemCard(meta)))
}

function buildStemCard(meta) {
  const card = document.createElement('div')
  card.className = 'stem-proc-card'
  card.style.borderTop = `2px solid ${meta.color}`
  const stemIndex = STEM_META.findIndex(m => m.key === meta.key)
  card.style.setProperty('--stem-card-delay', `${stemIndex * 60}ms`)

  const modeNote = HF_READY
    ? '已分軌'
    : 'Phase 2 — 接 Demucs 後載入'

  card.innerHTML = `
    <div class="stem-proc-head">
      <div class="stem-proc-dot" style="background:${meta.color}"></div>
      <div class="stem-proc-name">${meta.label}</div>
      <div class="stem-proc-type">${modeNote}</div>
    </div>
    <div class="stem-proc-waveform" id="stem-waveform-${meta.key}" style="background:${meta.bg}">
      ${HF_READY && stemBuffers[meta.key] ? '' : `
        <div style="height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:${meta.color};opacity:0.5">
          ${HF_READY ? '載入波形...' : '波形（分軌後載入）'}
        </div>`}
    </div>
    <div class="stem-proc-body">
      <div style="font-size:9px;color:var(--c-text-3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">EQ — 三頻段</div>
      <div class="stem-mini-eq">
        ${['低', '中', '高'].map((band, i) => {
          const paramKey = ['lowGain', 'midGain', 'highGain'][i]
          return `
          <div class="stem-eq-band">
            <div class="stem-eq-label">${band}</div>
            <input type="range" class="stem-eq-slider" min="-12" max="12" step="0.5"
                   value="${stemParams[meta.key][paramKey]}"
                   data-stem="${meta.key}" data-param="${paramKey}"
                   aria-label="${meta.label} ${band}頻 EQ">
            <div class="stem-eq-value" id="eq-val-${meta.key}-${paramKey}">0 dB</div>
          </div>`
        }).join('')}
      </div>
      <div style="font-size:9px;color:var(--c-text-3);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">壓縮</div>
      <div class="stem-comp-row">
        <div class="stem-comp-field">
          <div class="stem-comp-label">Thresh (dB)</div>
          <input type="number" class="stem-comp-input" min="-60" max="0" step="1"
                 value="${stemParams[meta.key].thresh}"
                 data-stem="${meta.key}" data-param="thresh"
                 aria-label="${meta.label} 壓縮門限">
        </div>
        <div class="stem-comp-field">
          <div class="stem-comp-label">Ratio</div>
          <input type="number" class="stem-comp-input" min="1" max="20" step="0.5"
                 value="${stemParams[meta.key].ratio}"
                 data-stem="${meta.key}" data-param="ratio"
                 aria-label="${meta.label} 壓縮比">
        </div>
      </div>
    </div>
    <div class="stem-proc-footer">
      <input type="range" class="stem-proc-vol" min="0" max="1" step="0.01" value="1"
             data-stem="${meta.key}" aria-label="${meta.label} 音量">
      <span class="stem-vol-label" data-stem="${meta.key}">100%</span>
    </div>
  `

  // Wire EQ sliders
  card.querySelectorAll('.stem-eq-slider').forEach(slider => {
    const valEl = card.querySelector(`#eq-val-${slider.dataset.stem}-${slider.dataset.param}`)
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value)
      stemParams[slider.dataset.stem][slider.dataset.param] = v
      if (valEl) valEl.textContent = `${v >= 0 ? '+' : ''}${v} dB`
    })
  })

  // Wire compressor inputs
  card.querySelectorAll('.stem-comp-input').forEach(input => {
    input.addEventListener('change', () => {
      stemParams[input.dataset.stem][input.dataset.param] = parseFloat(input.value)
    })
  })

  // Wire volume slider
  const volSlider = card.querySelector('.stem-proc-vol')
  const volLabel  = card.querySelector(`.stem-vol-label[data-stem="${meta.key}"]`)
  volSlider?.addEventListener('input', () => {
    const pct = Math.round(volSlider.value * 100)
    stemVolumes[meta.key] = parseFloat(volSlider.value)
    if (volLabel) volLabel.textContent = `${pct}%`
  })

  return card
}

// ── Bounce: process each stem → mix → dispatch to main chain
export async function bounce() {
  const statusEl = document.getElementById('bounce-status')
  const bounceEl = document.getElementById('bounce-btn')

  const hasRealBuffers = STEM_META.some(m => stemBuffers[m.key])
  if (!hasRealBuffers) {
    if (statusEl) statusEl.textContent = '需先完成 AI 分軌才能 Bounce（請設定 VITE_HF_ENDPOINT）'
    return
  }

  if (bounceEl) { bounceEl.disabled = true; bounceEl.textContent = 'Bounce 中...' }
  if (statusEl) statusEl.textContent = '處理各軌 EQ + 壓縮...'

  try {
    const processed = await Promise.all(
      STEM_META.map(m => processStem(stemBuffers[m.key], stemParams[m.key], stemVolumes[m.key]))
    )

    if (statusEl) statusEl.textContent = '混音中...'
    const mixed = mixBuffers(processed)
    if (!mixed) throw new Error('無可用的分軌音訊')

    // Dispatch to main.js for loading into master chain
    document.dispatchEvent(new CustomEvent('wf:stem-bounce', { detail: { buffer: mixed } }))

    if (statusEl) statusEl.textContent = '✓ Bounce 完成 → 已載入母帶處理鏈'
    if (bounceEl) { bounceEl.disabled = false; bounceEl.textContent = '重新 Bounce' }
  } catch (err) {
    console.error('[Bounce]', err)
    if (statusEl) statusEl.textContent = `Bounce 失敗：${err.message}`
    if (bounceEl) { bounceEl.disabled = false; bounceEl.textContent = 'Bounce (重試)' }
  }
}

// ── Public init ───────────────────────────────────────────
export function initStemsMastering(getAudioFile) {
  // Show backend notice if HF not configured
  if (!HF_READY) {
    const notice = document.getElementById('stems-hf-notice')
    const desc   = document.getElementById('stems-hf-desc')
    if (notice) notice.hidden = false
    if (desc)   desc.hidden   = true
  }

  const btn = document.getElementById('stems-ai-btn')
  btn?.addEventListener('click', () => {
    const file = getAudioFile()
    if (!file) return
    separateStems(file)
  })

  document.getElementById('bounce-btn')?.addEventListener('click', bounce)
}
