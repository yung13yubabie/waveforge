import WaveSurfer from 'wavesurfer.js'
import { AudioEngine }    from './audio/engine.js'
import { initKnobs }      from './ui/knob.js'
import { EQCanvas }       from './ui/eq-canvas.js'
import { SpectrumAnalyser } from './ui/spectrum.js'
import { Goniometer }      from './ui/goniometer.js'
import { LoudnessHistory } from './audio/loudness-history.js'
import { LoudnessGraph }   from './ui/loudness-graph.js'
import { Spectrogram }     from './ui/spectrogram.js'
import { StemsPanel }     from './ui/stems.js'
import { PRESETS }        from './presets.js'
import { detectBPM, detectKey } from './audio/analyze.js'
import { buildExportReport, measureIntegratedLUFS } from './audio/measure.js'
import { encodeWAV } from './audio/wav.js'
import { averageSpectrum, computeMatchCurve } from './audio/match-eq.js'
import { Album, loudnessTrim } from './album.js'
import { History } from './history.js'
import { listUserPresets, saveUserPreset, getUserPreset } from './user-presets.js'
import { renderMasterChain } from './audio/render-chain.js'
import { truePeakLimit } from './audio/true-peak-limiter.js'
import { assembleAlbum } from './audio/album-assembly.js'
import { generateCue } from './audio/cue.js'
import { createZip } from './audio/zip.js'
import { md5 } from './audio/md5.js'
// Static ?url import: a dynamic import('...?url') is a Vite compile-time
// transform and fails to resolve at runtime in a production build.
import dynamicsWorkletUrl from './audio/dynamics-worklet.js?url'

// ── Build 10 EQ band controls in HTML ─────────────────────
function buildEQBands() {
  const container = document.getElementById('eq-bands-container')
  if (!container) return
  const bands = [
    { freq: '32Hz', param: 'eq-0' }, { freq: '64Hz',  param: 'eq-1' },
    { freq: '125Hz', param: 'eq-2' }, { freq: '250Hz', param: 'eq-3' },
    { freq: '500Hz', param: 'eq-4' }, { freq: '1kHz',  param: 'eq-5' },
    { freq: '2kHz',  param: 'eq-6' }, { freq: '4kHz',  param: 'eq-7' },
    { freq: '8kHz',  param: 'eq-8' }, { freq: '16kHz', param: 'eq-9' },
  ]
  container.innerHTML = bands.map(b => `
    <div class="eq-band">
      <div class="knob-wrap" data-param="${b.param}"
           data-min="-12" data-max="12" data-default="0" data-unit="dB">
        <svg class="knob-svg" width="32" height="32"></svg>
        <div class="knob-label">${b.freq}</div>
        <div class="knob-value">0 dB</div>
      </div>
    </div>
  `).join('')
}

// ── Format seconds → m:ss ─────────────────────────────────
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '0:00'
  const m = Math.floor(s / 60)
  const sc = Math.floor(s % 60)
  return `${m}:${sc.toString().padStart(2, '0')}`
}

// ── Format LUFS for display ───────────────────────────────
function fmtLUFS(v) {
  if (!isFinite(v) || v === -Infinity) return '—'
  return `${v.toFixed(1)}`
}

// ── Platform LUFS targets ────────────────────────────────
const PLATFORMS = [
  { id: 'spotify',   target: -14 },
  { id: 'youtube',   target: -13 },
  { id: 'apple',     target: -16 },
  { id: 'tidal',     target: -14 },
  { id: 'broadcast', target: -23 },
]

function updatePlatformBars(intLUFS) {
  PLATFORMS.forEach(({ id, target }) => {
    const bar    = document.getElementById(`bar-${id}`)
    const status = document.getElementById(`status-${id}`)
    if (!bar || !status) return

    if (!isFinite(intLUFS)) {
      bar.style.width = '0%'
      bar.className = 'platform-bar ok'
      status.textContent = '—'
      return
    }

    const diff = intLUFS - target  // negative = quiet, positive = too loud
    // Width represents how full the loudness is (0 = silent, 100% = at target or above)
    const pct = Math.min(100, Math.max(0, ((intLUFS - (-40)) / (target - (-40))) * 100))
    bar.style.width = `${pct}%`

    if (diff < -2) {
      bar.className = 'platform-bar warn'
      status.textContent = '🔇'
    } else if (diff > 1) {
      bar.className = 'platform-bar over'
      status.textContent = '🔴'
    } else {
      bar.className = 'platform-bar ok'
      status.textContent = '✅'
    }
  })
}

// ── Module card toggle ────────────────────────────────────
// Wired via addEventListener (NOT inline onclick) so a strict CSP without
// 'unsafe-inline'/'unsafe-hashes' doesn't block module expand/collapse.
function wireModuleHeads() {
  document.querySelectorAll('.module-head').forEach(head => {
    head.addEventListener('click', e => {
      if (e.target.closest('.module-toggle')) return   // enable checkbox: don't expand
      const card = head.closest('.module-card')
      if (!card) return
      const expanded = card.classList.toggle('expanded')
      head.setAttribute('aria-expanded', String(expanded))
    })
  })
}

// ── Vinyl time calculation ────────────────────────────────
const VINYL_LIMITS = {
  '12-33': { ideal: 18 * 60, max: 22 * 60, rms: -12 },
  '12-45': { ideal: 12 * 60, max: 15 * 60, rms: -9  },
  '7-45':  { ideal:  4 * 60, max:  6 * 60, rms: -9  },
}
let vinylFormat = '12-33'

function updateVinylUI(duration) {
  const limits = VINYL_LIMITS[vinylFormat]
  const bar    = document.getElementById('vinyl-time-bar')
  const label  = document.getElementById('vinyl-time-label')
  const warns  = document.getElementById('vinyl-warnings')
  if (!bar || !label || !limits) return

  if (!duration) {
    label.textContent = '— / ' + fmtTime(limits.ideal) + ' 理想'
    return
  }

  const pct = Math.min(100, (duration / limits.max) * 100)
  bar.style.width = `${pct}%`

  if (duration > limits.max) {
    bar.style.background = 'var(--c-primary)'
    label.textContent = `${fmtTime(duration)} / ${fmtTime(limits.max)} ⚠ 超過極限`
  } else if (duration > limits.ideal) {
    bar.style.background = 'var(--c-orange)'
    label.textContent = `${fmtTime(duration)} / ${fmtTime(limits.ideal)} 理想`
  } else {
    bar.style.background = 'var(--c-green)'
    label.textContent = `${fmtTime(duration)} / ${fmtTime(limits.ideal)} 理想 ✓`
  }

  const messages = []
  if (duration > limits.max)    messages.push({ cls: 'error', text: '✕ 超過每面極限時長，刻版必定失真' })
  else if (duration > limits.ideal) messages.push({ cls: 'warn', text: '⚠ 超過理想時長，建議縮短或降低音量' })
  else                           messages.push({ cls: 'ok',   text: '✓ 時長在允許範圍內' })

  if (warns) {
    warns.textContent = ''
    for (const m of messages) {
      const d = document.createElement('div')
      d.className = `vinyl-warning ${m.cls}`
      d.textContent = m.text
      warns.appendChild(d)
    }
  }
}

// ── Main app bootstrap ────────────────────────────────────
let booted = false
async function boot() {
  // Re-entry guard: a second boot() would double-register every event listener
  if (booted) return
  booted = true

  buildEQBands()

  const engine   = new AudioEngine()
  const stems    = new StemsPanel(document.getElementById('stems-container'))

  // WaveSurfer for main waveform
  let ws = null
  // Loudness target of the active preset (null = no target) — used by export report
  let activeTargetLUFS = null
  // Album sequence (Phase 6) + the currently-loaded File (for per-track snapshot)
  const album = new Album()
  let currentFile = null

  // ── File loading ────────────────────────────────────────
  let isLoadingFile = false
  async function loadFile(file) {
    if (!file) return
    if (isLoadingFile) {
      setStatus('正在載入中，請稍候再試', false)
      return
    }
    isLoadingFile = true
    try {
      await doLoadFile(file)
    } finally {
      isLoadingFile = false
    }
  }

  async function doLoadFile(file) {

    const validTypes = ['audio/mpeg','audio/wav','audio/x-wav','audio/flac','audio/x-flac','audio/aac','audio/mp4','audio/x-m4a','audio/ogg']
    const ext = file.name.split('.').pop().toLowerCase()
    const validExts = ['mp3','wav','flac','aac','m4a','ogg']

    // Accept by known extension OR exact MIME type — not just any audio/* prefix
    if (!validExts.includes(ext) && !validTypes.includes(file.type)) {
      setStatus(`不支援的格式：${ext}（支援 MP3 / WAV / FLAC / AAC / M4A / OGG）`, false)
      return
    }

    if (file.size > 200 * 1024 * 1024) {
      setStatus('檔案超過 200MB 上限', false)
      return
    }

    // Update upload zone label — textContent, NOT innerHTML: file.name is
    // attacker-controlled, a name like "<img src=x onerror=...>.wav" passes the
    // extension check and would execute if spliced into innerHTML (XSS).
    const wrap = document.getElementById('upload-text-wrap')
    if (wrap) {
      const span = document.createElement('span')
      span.className = 'upload-filename'
      span.textContent = `📄 ${file.name}`
      wrap.replaceChildren(span)
    }

    setStatus('讀取音訊...', true)
    setProcessing(true, '讀取音訊檔案...', 5)

    try {
      // Two copies needed: decodeAudioData DETACHES the buffer it receives.
      // engineBuf goes to the engine (gets detached); wsBuf stays intact for WaveSurfer.
      const wsBuf     = await file.arrayBuffer()
      const engineBuf = wsBuf.slice(0)
      // Bound the decode: a malformed-but-valid-header file can hang
      // decodeAudioData indefinitely, freezing the tab with no feedback.
      const buffer = await Promise.race([
        engine.loadFile(engineBuf),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('解碼逾時（檔案可能損毀或過大）')), 30000)),
      ])

      setProcessing(true, '渲染波形...', 30)

      // Load into WaveSurfer for visual display
      if (ws) ws.destroy()
      ws = WaveSurfer.create({
        container:     '#waveform-main',
        waveColor:     'rgba(255,75,110,0.5)',
        progressColor: '#E8003C',
        height:        80,
        barWidth:      2,
        barGap:        1,
        barRadius:     2,
        normalize:     true,
        interact:      true,
      })

      await ws.loadBlob(new Blob([wsBuf]))

      // WaveSurfer is the VISUAL clock only — all audible audio comes from the
      // engine (whose A/B crossfade selects dry vs processed). Unmuted, it
      // plays the original file on top of the engine = both heard at once.
      ws.setVolume(0)
      ws.setMuted(true)

      // Dev-only handle for E2E assertions (Playwright reads ws/engine state)
      if (import.meta.env.DEV) window.__wf = { ws, engine, album, spectrogram, gonio, loudnessGraph }

      ws.on('interaction', (newTime) => {
        // Guard: duration 0 (empty decode) would produce Infinity → NaN seek
        if (engine.duration > 0) engine.seekTo(newTime / engine.duration)
      })

      ws.on('finish', () => {
        updatePlayBtn(false)
      })

      setProcessing(false, '', 100)

      // Fresh loudness timeline per loaded track
      loudnessHistory.clear()

      // Remove empty-state placeholder once waveform is rendered
      document.getElementById('waveform-empty')?.remove()

      // Remember the source File so "add to album" can snapshot it
      currentFile = file

      // Enable buttons
      document.getElementById('analyze-btn').disabled = false
      document.getElementById('export-btn').disabled  = false
      document.getElementById('album-add-btn').disabled = false
      for (const z of ['zoom-in','zoom-out','zoom-fit'])
        document.getElementById(z)?.removeAttribute('disabled')

      // Screen readers should know which file the waveform shows
      document.getElementById('waveform-main')?.setAttribute('aria-label', `主波形：${file.name}`)

      // Engine ignores setABMode before init — re-assert whatever the UI shows
      // so a pre-load A/B click can't leave button state desynced from audio.
      engine.setABMode(document.getElementById('ab-a')?.classList.contains('active') ? 'A' : 'B')

      // Dynamics worklet failed to load → De-esser / Dynamic EQ have no DSP;
      // their cards must go inert instead of pretending to work.
      if (!engine.dynamicsAvailable) {
        for (const mod of ['dyneq', 'deesser']) {
          const card = document.getElementById(`mod-${mod}`)
          card?.classList.add('unimplemented')
          card?.querySelector('input[type="checkbox"]')?.setAttribute('disabled', '')
          card?.setAttribute('data-tooltip', 'AudioWorklet 載入失敗 — 此模組暫不可用')
        }
        setStatus('部分模組停用（AudioWorklet 載入失敗）', false)
      }

      // Update time display
      document.getElementById('time-total').textContent = fmtTime(engine.duration)
      updateVinylUI(engine.duration)

      // Start EQ canvas + spectrum
      eqCanvas.startLoop()
      spectrumAn.startLoop()
      spectrogram?.startLoop()
      gonio?.startLoop()
      loudnessGraph?.startLoop()

      setStatus(`已載入：${file.name}`, true)
      setDot('active')

    } catch (err) {
      setProcessing(false, '', 0)
      setStatus(`讀取失敗：${err.message}`, false)
      console.error('[WaveForge] loadFile error', err)
    }
  }

  // ── Processing overlay helpers ──────────────────────────
  function setProcessing(show, text, pct) {
    const overlay = document.getElementById('processing-overlay')
    const step    = document.getElementById('processing-step')
    const fill    = document.getElementById('processing-fill')
    if (!overlay) return
    overlay.classList.toggle('visible', show)
    if (step) {
      step.textContent = ''
      if (text) { const s = document.createElement('strong'); s.textContent = text; step.appendChild(s) }
    }
    if (fill) fill.style.width = `${pct}%`
  }

  // ── Status bar helpers ──────────────────────────────────
  function setStatus(text, ok) {
    const el = document.getElementById('status-text')
    if (!el) return
    el.textContent = text
    el.classList.toggle('status-error', ok === false)
  }

  function setDot(state) {
    const dot = document.getElementById('status-dot')
    if (!dot) return
    dot.className = 'analysis-dot' + (state ? ` ${state}` : '')
  }

  // ── Drag & drop ─────────────────────────────────────────
  const uploadZone = document.getElementById('upload-zone')
  const fileInput  = document.getElementById('file-input')

  fileInput.addEventListener('change', () => {
    if (fileInput.files?.[0]) loadFile(fileInput.files[0])
  })

  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over') })
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'))
  uploadZone.addEventListener('drop', e => {
    e.preventDefault()
    uploadZone.classList.remove('drag-over')
    const file = e.dataTransfer.files?.[0]
    if (file) loadFile(file)
  })

  // ── Knobs → Engine ──────────────────────────────────────
  const knobs = initKnobs(document.body, (param, value) => {
    const i = param.match(/^eq-(\d+)$/)
    if (i) { engine.setEQBand(parseInt(i[1]), value); recordEdit(); return }

    switch(param) {
      case 'hp-freq':       engine.setHPFreq(value); break
      case 'lp-freq':       engine.setLPFreq(value); break
      case 'comp-threshold':engine.setCompThreshold(value); break
      case 'comp-ratio':    engine.setCompRatio(value); break
      case 'comp-knee':     engine.setCompKnee(value); break
      case 'comp-attack':   engine.setCompAttack(value); break
      case 'comp-release':  engine.setCompRelease(value); break
      case 'comp-makeup':   engine.setCompMakeup(value); break
      // True multiband compressor: per-band threshold/ratio + crossovers
      case 'mbc-xover1':    engine.setMBCXover(0, value); break
      case 'mbc-xover2':    engine.setMBCXover(1, value); break
      case 'mbc-low-thresh':  engine.setMBCBandThresh(0, value); break
      case 'mbc-mid-thresh':  engine.setMBCBandThresh(1, value); break
      case 'mbc-high-thresh': engine.setMBCBandThresh(2, value); break
      case 'mbc-low-ratio':   engine.setMBCBandRatio(0, value); break
      case 'mbc-mid-ratio':   engine.setMBCBandRatio(1, value); break
      case 'mbc-high-ratio':  engine.setMBCBandRatio(2, value); break
      case 'lim-ceiling':   engine.setLimCeiling(value); break
      case 'lim-release':   engine.setLimRelease(value); break
      case 'lim-input':     engine.setLimInput(value); break
      case 'sat-drive':     engine.setSatDrive(value / 100); break  // knob is 0-100%
      case 'sat-mix':       engine.setSatMix(value / 100); break
      // Phase-2 modules
      case 'dyneq-freq':    engine.setDynEQFreq(value); break
      case 'dyneq-thresh':  engine.setDynEQThresh(value); break
      case 'dyneq-ratio':   engine.setDynEQRatio(value); break
      case 'dess-freq':     engine.setDeessFreq(value); break
      case 'dess-thresh':   engine.setDeessThresh(value); break
      case 'ms-width':      engine.setMSWidth(value); break
      case 'ms-mid-gain':   engine.setMSMidGain(value); break
      case 'ms-side-gain':  engine.setMSSideGain(value); break
      case 'mbc-mix':       engine.setMBCMix(value); break
    }
    recordEdit()
  })

  // ── Undo / Redo ─────────────────────────────────────────
  // Snapshots the full chain on each edit gesture (debounced + deduped). Restore
  // re-applies to engine AND syncs every control. Seeded with the default state.
  const history = new History(engine.serialize())
  let histTimer = null
  function recordEdit() {
    clearTimeout(histTimer)
    histTimer = setTimeout(() => {
      const snap = engine.serialize()
      if (JSON.stringify(snap) !== JSON.stringify(history.current)) history.push(snap)
      updateUndoButtons()
    }, 350)
  }
  // For discrete events (preset selection, snapshot recall) — push immediately
  // without waiting for the 350ms debounce to avoid Undo missing the state.
  function recordEditNow() {
    clearTimeout(histTimer)
    histTimer = null
    const snap = engine.serialize()
    if (JSON.stringify(snap) !== JSON.stringify(history.current)) history.push(snap)
    updateUndoButtons()
  }
  function syncUIFromEngine() {
    const p = engine.params
    const set = (id, v) => knobs[id]?.setValue(v, true)
    set('hp-freq', p.hpFreq); set('lp-freq', p.lpFreq)
    p.eqGains.forEach((g, i) => set(`eq-${i}`, g))
    set('comp-attack', p.compAttack); set('comp-release', p.compRelease); set('comp-makeup', p.compMakeup)
    set('mbc-xover1', p.mbcXover1); set('mbc-xover2', p.mbcXover2)
    set('mbc-low-thresh', p.mbcThresh[0]); set('mbc-mid-thresh', p.mbcThresh[1]); set('mbc-high-thresh', p.mbcThresh[2])
    set('mbc-low-ratio', p.mbcRatio[0]); set('mbc-mid-ratio', p.mbcRatio[1]); set('mbc-high-ratio', p.mbcRatio[2])
    set('lim-ceiling', p.limCeiling); set('lim-input', p.limInput); set('lim-release', p.limRelease)
    set('sat-drive', p.satDrive * 100); set('sat-mix', p.satMix * 100)
    set('dyneq-freq', p.dyneqFreq); set('dyneq-thresh', p.dyneqThresh); set('dyneq-ratio', p.dyneqRatio)
    set('dess-freq', p.deessFreq); set('dess-thresh', p.deessThresh)
    set('ms-width', p.msWidth); set('ms-mid-gain', p.msMidGain); set('ms-side-gain', p.msSideGain)
    set('mbc-mix', p.mbcMix ?? 100)
    const vol = document.getElementById('master-vol')
    if (vol) { vol.value = String(p.masterVol); const vl = document.getElementById('master-vol-label'); if (vl) vl.textContent = `${Math.round(p.masterVol * 100)}%` }
    // Bypass checkboxes (set silently — no change event → no history feedback)
    const cbMap = { hplp: 'hplp', eq: 'eq', dyneq: 'dyneq', ms: 'ms', comp: 'mbc', sat: 'sat', limiter: 'limiter', deesser: 'deesser' }
    for (const [mod, cbId] of Object.entries(cbMap)) {
      const cb = document.getElementById(`${cbId}-enabled`)
      if (cb) { cb.checked = !engine.bypassed[mod]; cb.closest('.module-card')?.classList.toggle('bypassed', !!engine.bypassed[mod]) }
    }
    const isA = engine.abMode === 'A'
    document.getElementById('ab-a')?.classList.toggle('active', isA)
    document.getElementById('ab-b')?.classList.toggle('active', !isA)
    document.getElementById('ab-a')?.setAttribute('aria-pressed', String(isA))
    document.getElementById('ab-b')?.setAttribute('aria-pressed', String(!isA))
    document.querySelectorAll('[data-sat-type]').forEach(b => b.classList.toggle('active', b.dataset.satType === p.satType))
  }
  function updateUndoButtons() {
    const u = document.getElementById('undo-btn'), r = document.getElementById('redo-btn')
    if (u) u.disabled = !history.canUndo
    if (r) r.disabled = !history.canRedo
  }
  function doUndo() { const s = history.undo(); if (s) { engine.restore(s); syncUIFromEngine(); updateUndoButtons() } }
  function doRedo() { const s = history.redo(); if (s) { engine.restore(s); syncUIFromEngine(); updateUndoButtons() } }
  document.getElementById('undo-btn')?.addEventListener('click', doUndo)
  document.getElementById('redo-btn')?.addEventListener('click', doRedo)
  updateUndoButtons()

  // Wire module expand/collapse (CSP-safe, replaces inline onclick)
  wireModuleHeads()

  // ── Module toggles ──────────────────────────────────────
  const moduleIds = ['hplp','eq','dyneq','ms','mbc','limiter','sat','deesser']
  moduleIds.forEach(id => {
    const cb = document.getElementById(`${id === 'mbc' ? 'mbc' : id}-enabled`)
    if (!cb) return
    // Initial visual must match the checkbox state (unchecked = bypassed look)
    cb.closest('.module-card')?.classList.toggle('bypassed', !cb.checked)
    cb.addEventListener('change', () => {
      const bypassed = !cb.checked
      const card = cb.closest('.module-card')
      card?.classList.toggle('bypassed', bypassed)
      engine.setModuleBypassed(id === 'mbc' ? 'comp' : id, bypassed)
      recordEdit()
    })
  })

  // Vinyl Cut has no DSP node (analysis-only module) but its toggle must
  // still reflect bypass state visually — previously it was wired to nothing.
  const vinylToggle = document.getElementById('vinyl-enabled')
  vinylToggle?.addEventListener('change', () => {
    document.getElementById('mod-vinyl')?.classList.toggle('bypassed', !vinylToggle.checked)
  })

  // ── EQ Canvas + Spectrum ────────────────────────────────
  const eqCanvas   = new EQCanvas(document.getElementById('eq-canvas'), engine)
  const spectrumAn = new SpectrumAnalyser(document.getElementById('spectrum-canvas'), engine.analyser)
  const spectrogramEl = document.getElementById('spectrogram-canvas')
  const spectrogram = spectrogramEl ? new Spectrogram(spectrogramEl, engine) : null
  const gonioCanvasEl = document.getElementById('gonio-canvas')
  const gonio = gonioCanvasEl ? new Goniometer(gonioCanvasEl, engine) : null

  // Scrolling short-term LUFS history (target line follows the album target input)
  const loudnessHistory = new LoudnessHistory(900)
  const loudnessGraphEl = document.getElementById('loudness-graph-canvas')
  const loudnessGraph = loudnessGraphEl
    ? new LoudnessGraph(loudnessGraphEl, loudnessHistory, {
        getTarget: () => {
          const v = parseFloat(document.getElementById('album-target')?.value)
          return Number.isFinite(v) ? v : -14
        },
      })
    : null
  let _lastLoudPush = 0

  // ── LUFS callbacks ──────────────────────────────────────
  engine.onLufs((m, s, i, tp) => {
    document.getElementById('lufs-m').textContent  = fmtLUFS(m)
    document.getElementById('lufs-s').textContent  = fmtLUFS(s)
    document.getElementById('lufs-i').textContent  = fmtLUFS(i)
    document.getElementById('lufs-tp').textContent = fmtLUFS(tp)

    // Light up the meter cells' top accent line when live data flows
    document.querySelectorAll('.lufs-reading').forEach(el =>
      el.classList.toggle('live', isFinite(m)))
    document.getElementById('val-lufs').textContent = isFinite(m) ? `${m.toFixed(1)} LUFS` : '—'
    document.getElementById('val-tp').textContent  = isFinite(tp) ? `${tp.toFixed(1)} dBTP` : '—'

    // Colour coding
    const limEl = document.getElementById('lufs-i')
    if (isFinite(i)) {
      limEl.className = i > -8 ? 'lufs-reading-value over' : i > -12 ? 'lufs-reading-value warn' : 'lufs-reading-value'
    }
    updatePlatformBars(i)

    // Feed the scrolling history with short-term LUFS, throttled to a steady
    // ~5 Hz so the timeline window is time-stable regardless of callback rate.
    const now = performance.now()
    if (now - _lastLoudPush >= 200) {
      _lastLoudPush = now
      loudnessHistory.push(s)
    }
  })

  // ── Phase-2 module GR meters (De-esser / Dynamic EQ) ────
  // grDb is ≤0; full-scale at -12 dB reduction. Makes the worklet modules
  // visible instead of black boxes — user can confirm they're working.
  const GR_FULLSCALE = 12
  function updateGRMeter(mod, grDb) {
    const fill = document.getElementById(`${mod}-gr-fill`)
    const label = document.getElementById(`${mod}-gr-value`)
    if (!fill || !label) return
    const amount = Math.min(GR_FULLSCALE, Math.abs(grDb))
    fill.style.width = `${(amount / GR_FULLSCALE) * 100}%`
    fill.className = `gr-meter-fill${amount > 6 ? ' heavy' : amount > 1 ? ' active' : ''}`
    label.textContent = `GR: ${grDb <= -0.05 ? grDb.toFixed(1) : '0.0'} dB`
  }
  engine.onGR((mod, grDb) => updateGRMeter(mod, grDb))

  // ── Playback ────────────────────────────────────────────
  const btnPlay = document.getElementById('btn-play')
  function updatePlayBtn(playing) {
    btnPlay.textContent = playing ? '⏸' : '▶'
    btnPlay.setAttribute('aria-label', playing ? '暫停' : '播放')
  }

  btnPlay.addEventListener('click', async () => {
    if (engine.isPlaying) {
      engine.pause()
      ws?.pause()
      updatePlayBtn(false)
    } else {
      try {
        await engine.play()   // may reject if AudioContext can't resume (mobile)
        ws?.play()
        updatePlayBtn(true)
      } catch (err) {
        updatePlayBtn(false)
        setStatus(`播放失敗：${err.message}`, false)
      }
    }
  })

  document.getElementById('btn-skip-back')?.addEventListener('click', () => {
    engine.seekTo(0)
    ws?.seekTo(0)
  })

  document.getElementById('btn-skip-fwd')?.addEventListener('click', () => {
    engine.seekTo(1)
    ws?.seekTo(1)
  })

  let loopOn = false
  document.getElementById('btn-loop')?.addEventListener('click', e => {
    loopOn = !loopOn
    engine.loop = loopOn
    e.currentTarget.classList.toggle('active', loopOn)
    e.currentTarget.setAttribute('aria-pressed', String(loopOn))
  })

  // Keyboard: Space → play/pause; Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z (or Ctrl+Y) redo
  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      e.shiftKey ? doRedo() : doUndo()
      return
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
    if (e.code === 'Space') { e.preventDefault(); btnPlay.click() }
  })

  // Master volume
  const volInput = document.getElementById('master-vol')
  const volLabel = document.getElementById('master-vol-label')
  volInput?.addEventListener('input', () => {
    const v = parseFloat(volInput.value)
    engine.setMasterVolume(v)
    if (volLabel) volLabel.textContent = `${Math.round(v * 100)}%`
    recordEdit()
  })

  // Progress bar
  const progressEl = document.getElementById('transport-progress')
  const progressFill = document.getElementById('progress-fill')

  progressEl?.addEventListener('click', e => {
    const rect = progressEl.getBoundingClientRect()
    const frac = (e.clientX - rect.left) / rect.width
    engine.seekTo(frac)
    ws?.seekTo(frac)
  })

  // role="slider" requires keyboard operation: ←/→ seek ±5 s
  progressEl?.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    if (!(engine.duration > 0)) return
    e.preventDefault()
    const step = 5 / engine.duration
    const cur  = engine.currentTime / engine.duration
    const frac = Math.min(1, Math.max(0, cur + (e.key === 'ArrowRight' ? step : -step)))
    engine.seekTo(frac)
    ws?.seekTo(frac)
  })

  // Zoom controls — track level locally; ws.options.minPxPerSec is not
  // reliably present on WaveSurfer v7 instances
  let zoomLevel = 20
  function applyZoom(level) {
    zoomLevel = Math.min(640, Math.max(20, level))
    try { ws?.zoom(zoomLevel) } catch (_) { /* zoom before decode throws — ignore */ }
    const zoomOutput = document.getElementById('zoom-level')
    if (zoomOutput) zoomOutput.value = `${zoomLevel / 20}×`
  }
  document.getElementById('zoom-in')?.addEventListener('click',  () => applyZoom(zoomLevel * 2))
  document.getElementById('zoom-out')?.addEventListener('click', () => applyZoom(zoomLevel / 2))
  document.getElementById('zoom-fit')?.addEventListener('click', () => applyZoom(20))

  // Surface async engine errors (e.g. resume failure during seek) to the UI
  engine.onError(err => setStatus(`音訊錯誤：${err.message}`, false))

  // Natural end-of-track: WaveSurfer's 'finish' may never fire (separate clock),
  // so the engine's own onended must also reset the play button.
  engine.onEnded(() => {
    updatePlayBtn(false)
    ws?.pause()
  })

  // Compressor gain-reduction meter (previously a fake static "GR: 0.0 dB")
  const grValueEl  = document.getElementById('comp-gr-value')
  const grCanvas   = document.getElementById('comp-gr-canvas')
  const GR_RANGE_DB = 20  // meter full-scale
  function drawGR(reduction) {
    if (grValueEl) grValueEl.textContent = `GR: ${reduction.toFixed(1)} dB`
    if (!grCanvas) return
    const ctx = grCanvas.getContext('2d')
    const w = grCanvas.width, h = grCanvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0F0F18'
    ctx.fillRect(0, 0, w, h)
    const frac = Math.min(1, Math.abs(reduction) / GR_RANGE_DB)
    ctx.fillStyle = frac > 0.6 ? '#E8003C' : frac > 0.3 ? '#FFA502' : '#2ED573'
    ctx.fillRect(0, 0, w * frac, h)
  }

  // Time display update loop (ID kept for teardown if app is ever re-bootstrapped)
  const timeLoopId = setInterval(() => {
    if (!engine.buffer) return
    const cur = engine.currentTime
    const dur = engine.duration
    document.getElementById('time-current').textContent = fmtTime(Math.min(cur, dur))
    const frac = Math.min(1, cur / dur)
    if (progressFill) progressFill.style.width = `${frac * 100}%`
    progressEl?.setAttribute('aria-valuenow', String(Math.round(frac * 100)))
    // Live multiband gain reduction (worst of the 3 bands)
    const red = engine.compReduction?.()
    if (typeof red === 'number') drawGR(red)
    updateCorrMeter()
    // Sync WaveSurfer to engine time when playing (AudioEngine drives real playback)
    // WaveSurfer playback is decorative: it's driven by ws.loadBlob and plays its own clock
  }, 50)

  // Stereo phase correlation: needle position + anti-phase warning
  const corrNeedle = document.getElementById('corr-needle')
  const corrValue  = document.getElementById('corr-value')
  function updateCorrMeter() {
    const c = engine.getCorrelation?.()
    if (c == null) {
      if (corrValue) { corrValue.textContent = '—'; corrValue.classList.remove('warn') }
      if (corrNeedle) corrNeedle.style.left = '50%'
      return
    }
    if (corrNeedle) corrNeedle.style.left = `${((c + 1) / 2) * 100}%`
    if (corrValue) {
      corrValue.textContent = (c >= 0 ? '+' : '') + c.toFixed(2)
      corrValue.classList.toggle('warn', c < 0)   // negative = mono-incompatible
    }
  }

  // ── A/B toggle ─────────────────────────────────────────
  const abBtnA = document.getElementById('ab-a')
  const abBtnB = document.getElementById('ab-b')
  function setABMode(mode) {
    engine.setABMode(mode)
    const isA = mode === 'A'
    abBtnA?.classList.toggle('active', isA)
    abBtnB?.classList.toggle('active', !isA)
    abBtnA?.setAttribute('aria-pressed', String(isA))
    abBtnB?.setAttribute('aria-pressed', String(!isA))
    recordEdit()
  }
  abBtnA?.addEventListener('click', () => setABMode('A'))
  abBtnB?.addEventListener('click', () => setABMode('B'))

  // ── C/D quick-snapshot slots ───────────────────────────
  // Click empty slot → stores current settings (silent save).
  // Click filled slot → recalls those settings + syncs UI.
  // Shift+click filled slot → clears the slot.
  const snapSlots = { c: null, d: null }
  const SNAP_LABELS = { c: '存1', d: '存2' }
  function updateSnapBtn(key) {
    const btn = document.getElementById(`snap-${key}`)
    if (!btn) return
    const filled = !!snapSlots[key]
    const label = SNAP_LABELS[key]
    btn.classList.toggle('snap-filled', filled)
    btn.setAttribute('aria-pressed', String(filled))
    btn.setAttribute('data-tooltip', filled
      ? `${label} — 已存：點按還原設定，Shift+點按清除`
      : `${label} — 空：點按儲存目前設定`)
  }
  function handleSnap(key, shift) {
    if (!engine.ctx) {
      setStatus('請先載入音檔再使用存1/存2', false)
      return
    }
    const label = SNAP_LABELS[key]
    if (snapSlots[key] && !shift) {
      engine.restore(snapSlots[key])
      syncUIFromEngine()
      recordEditNow()
      setStatus(`已還原 ${label} 的設定`, true)
    } else if (snapSlots[key] && shift) {
      snapSlots[key] = null
      updateSnapBtn(key)
      setStatus(`已清除 ${label}`, true)
    } else {
      snapSlots[key] = engine.serialize()
      updateSnapBtn(key)
      setStatus(`已儲存至 ${label} — 再次點按可還原`, true)
    }
  }
  document.getElementById('snap-c')?.addEventListener('click', e => handleSnap('c', e.shiftKey))
  document.getElementById('snap-d')?.addEventListener('click', e => handleSnap('d', e.shiftKey))

  // ── User presets (save/recall own chain settings) ──────
  function refreshUserPresets() {
    const group = document.getElementById('user-preset-group')
    if (!group) return
    group.replaceChildren()
    const names = listUserPresets()
    group.hidden = names.length === 0
    for (const name of names) {
      const opt = document.createElement('option')
      opt.value = `user:${name}`
      opt.textContent = `★ ${name}`   // textContent → user-name injection-safe
      group.appendChild(opt)
    }
  }
  refreshUserPresets()
  document.getElementById('preset-save-btn')?.addEventListener('click', () => {
    const name = window.prompt('預設名稱：')
    if (!name || !name.trim()) return
    if (saveUserPreset(name, engine.serialize())) {
      refreshUserPresets()
      const sel = document.getElementById('preset-select')
      if (sel) sel.value = `user:${name.trim().slice(0, 60)}`
      setStatus(`已儲存預設：${name.trim()}`, true)
    } else {
      setStatus('儲存預設失敗（瀏覽器儲存空間不足或被封鎖）', false)
    }
  })

  // ── Presets ─────────────────────────────────────────────
  document.getElementById('preset-select')?.addEventListener('change', e => {
    const key = e.target.value

    // User preset → restore the full snapshot (incl. bypass/AB), sync UI
    if (key.startsWith('user:')) {
      const snap = getUserPreset(key.slice(5))
      if (snap) {
        engine.restore(snap)
        syncUIFromEngine()
        recordEditNow()   // discrete event: push immediately
        setStatus(`已套用我的預設：${key.slice(5)}`, true)
      }
      return
    }

    if (!key || !PRESETS[key]) return

    const preset = PRESETS[key]
    engine.applyPreset(preset)

    // Sync knobs to reflect new values
    if (preset.eqGains) {
      preset.eqGains.forEach((g, i) => knobs[`eq-${i}`]?.setValue(g, true))
    }
    const PRESET_KNOB_MAP = [
      ['compAttack',    'comp-attack'],
      ['compRelease',   'comp-release'],
      ['compMakeup',    'comp-makeup'],
      ['limCeiling',    'lim-ceiling'],
      ['limInput',      'lim-input'],
      ['satDrive',      'sat-drive'],
      ['satMix',        'sat-mix'],
      ['hpFreq',        'hp-freq'],
      ['lpFreq',        'lp-freq'],
    ]
    for (const [presetKey, knobId] of PRESET_KNOB_MAP) {
      if (preset[presetKey] != null) knobs[knobId]?.setValue(preset[presetKey], true)
    }
    // Global comp threshold/ratio seed all 3 MBC bands → sync every band knob
    if (preset.compThreshold != null) {
      for (const b of ['low', 'mid', 'high']) knobs[`mbc-${b}-thresh`]?.setValue(preset.compThreshold, true)
    }
    if (preset.compRatio != null) {
      for (const b of ['low', 'mid', 'high']) knobs[`mbc-${b}-ratio`]?.setValue(preset.compRatio, true)
    }

    // Vinyl mode auto-enable
    const vinylCard = document.getElementById('mod-vinyl')
    const vinylCb   = document.getElementById('vinyl-enabled')
    if (preset.isVinyl && vinylCb && !vinylCb.checked) {
      vinylCb.checked = true
      vinylCard?.classList.remove('bypassed')
    }

    // Remember the loudness target so the export report can judge "on target"
    activeTargetLUFS = preset.targetLUFS ?? null

    // Confirm auto-fill to user
    setStatus(`已套用預設：${preset.label}`, true)
    if (preset.targetLUFS) {
      setStatus(`已套用 ${preset.label}（目標 ${preset.targetLUFS} LUFS）`, true)
    }
    recordEditNow()   // applying a preset is one undoable step (immediate, not debounced)
  })

  // ── Vinyl format buttons ────────────────────────────────
  const vinylBtns = document.querySelectorAll('[data-vinyl-format]')
  vinylBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      vinylBtns.forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      vinylFormat = btn.dataset.vinylFormat
      updateVinylUI(engine.duration)
    })
  })

  // ── Reference matching ──────────────────────────────────
  // Analyse a reference track's tonal balance + the source's, then write the
  // per-band difference into the 10-band EQ (works with linear-phase export).
  const refInput = document.getElementById('ref-file-input')
  refInput?.addEventListener('change', async () => {
    const file = refInput.files?.[0]
    if (!file) return
    if (!engine.buffer) { setRefStatus('請先載入要處理的音檔', false); return }
    setRefStatus('分析參考曲...', true)
    try {
      const refArr = await file.arrayBuffer()
      // Bound the decode like the main loader: a malformed reference file can
      // otherwise hang decodeAudioData and freeze the tab forever.
      const refBuf = await Promise.race([
        engine.ctx.decodeAudioData(refArr),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error('參考曲解碼逾時（檔案可能損毀）')), 30000)),
      ])
      const bandFreqs = (engine.EQ_BANDS_META ?? []).map(b => b.freq)
      const srcCh = []
      for (let c = 0; c < engine.buffer.numberOfChannels; c++) srcCh.push(engine.buffer.getChannelData(c))
      const refCh = []
      for (let c = 0; c < refBuf.numberOfChannels; c++) refCh.push(refBuf.getChannelData(c))

      const sr = engine.ctx.sampleRate
      const srcBands = averageSpectrum(srcCh, sr, bandFreqs)
      const refBands = averageSpectrum(refCh, sr, bandFreqs)
      // averageSpectrum returns null for clips shorter than one FFT frame
      // (~85ms) — without this guard the match silently produces a flat curve.
      if (!srcBands || !refBands) {
        setRefStatus('音檔或參考曲太短，無法分析（需 ≥ 0.1 秒）', false)
        return
      }
      const curve = computeMatchCurve(srcBands, refBands, 12, 1)

      // Apply to EQ (+ sync knobs + canvas), ensuring EQ is enabled
      const eqCb = document.getElementById('eq-enabled')
      if (eqCb && !eqCb.checked) { eqCb.checked = true; eqCb.dispatchEvent(new Event('change')) }
      curve.forEach((g, i) => { engine.setEQBand(i, g); knobs[`eq-${i}`]?.setValue(g, true) })

      // Loudness delta (informational — match tone here, loudness via limiter/preset)
      const srcLufs = measureIntegratedLUFS(srcCh, sr)
      const refLufs = measureIntegratedLUFS(refCh, sr)
      const delta = (Number.isFinite(srcLufs) && Number.isFinite(refLufs)) ? (refLufs - srcLufs) : null
      const peak = Math.max(...curve.map(Math.abs)).toFixed(1)
      setRefStatus(
        `已匹配「${file.name}」音色（最大 ±${peak}dB）` +
        (delta != null ? `；參考曲響度 ${delta >= 0 ? '高' : '低'} ${Math.abs(delta).toFixed(1)} LU` : ''),
        true)
    } catch (err) {
      setRefStatus(`參考曲分析失敗：${err.message}`, false)
      console.error('[WaveForge] reference match error', err)
    } finally {
      refInput.value = ''   // allow re-selecting the same file
    }
  })
  function setRefStatus(text, ok) {
    const el = document.getElementById('ref-match-status')
    if (el) { el.textContent = text; el.classList.toggle('err', !ok) }
  }

  // ── Album sequence (Phase 6) ────────────────────────────
  document.getElementById('album-add-btn')?.addEventListener('click', () => {
    if (!engine.buffer || !currentFile) return
    // Source integrated LUFS (informational; processed/target loudness = Phase 6 step 6)
    const ch = []
    for (let c = 0; c < engine.buffer.numberOfChannels; c++) ch.push(engine.buffer.getChannelData(c))
    const lufs = measureIntegratedLUFS(ch, engine.ctx.sampleRate)
    album.add({
      file: currentFile,
      snapshot: engine.serialize(),   // freeze this track's full chain
      title: currentFile.name,
      lufs,
      gapBeforeSec: album.length === 0 ? 2 : 0,   // 2s lead-in before track 1
    })
    renderAlbum()
    setStatus(`已加入專輯：${currentFile.name}（共 ${album.length} 軌）`, true)
  })

  // Render the album list. Filenames are user-controlled → build with DOM +
  // textContent (never innerHTML) so a crafted name can't inject (CSP/XSS).
  function renderAlbum() {
    const list = document.getElementById('album-list')
    const count = document.getElementById('album-count')
    if (!list) return
    if (count) count.textContent = `${album.length} 軌`
    const exportBtn = document.getElementById('album-export-btn')
    if (exportBtn) exportBtn.disabled = album.length === 0
    const alignBtn = document.getElementById('album-align-btn')
    if (alignBtn) alignBtn.disabled = album.length === 0
    list.replaceChildren()
    if (album.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'album-empty'
      empty.id = 'album-empty'
      const icon = document.createElement('div'); icon.className = 'album-empty-icon'; icon.textContent = '💿'
      const txt = document.createElement('div'); txt.className = 'album-empty-text'
      txt.textContent = '載入並調好一首後，按上方「＋ 加入專輯」逐曲建立序列；之後輸出 DDP。'
      empty.append(icon, txt)
      list.appendChild(empty)
      return
    }
    album.tracks.forEach((t, i) => {
      const row = document.createElement('div')
      row.className = 'album-row'

      const num = document.createElement('span'); num.className = 'ac-num'; num.textContent = String(i + 1)
      const title = document.createElement('span'); title.className = 'ac-title'
      title.textContent = t.title; title.title = t.title
      const lufs = document.createElement('span'); lufs.className = 'ac-lufs'
      lufs.textContent = Number.isFinite(t.lufs) ? `${t.lufs.toFixed(1)}` : '—'

      const gain = document.createElement('input')
      gain.type = 'number'; gain.step = '0.1'; gain.value = String(t.gainTrimDb)
      gain.className = 'ac-gain'; gain.setAttribute('aria-label', `${t.title} 增益 dB`)
      gain.addEventListener('change', () => album.update(t.id, { gainTrimDb: parseFloat(gain.value) || 0 }))

      const gap = document.createElement('input')
      gap.type = 'number'; gap.step = '0.1'; gap.min = '0'; gap.value = String(t.gapBeforeSec)
      gap.className = 'ac-gap'; gap.setAttribute('aria-label', `${t.title} 前間隙 秒`)
      gap.addEventListener('change', () => album.update(t.id, { gapBeforeSec: Math.max(0, parseFloat(gap.value) || 0) }))

      const isrc = document.createElement('input')
      isrc.type = 'text'; isrc.value = t.isrc ?? ''
      isrc.className = 'ac-isrc'; isrc.maxLength = 17
      isrc.placeholder = 'CC-XXX-YY-NNNNN'
      isrc.setAttribute('aria-label', `${t.title} ISRC`)
      isrc.addEventListener('change', () => album.update(t.id, { isrc: isrc.value.trim() }))

      const ops = document.createElement('span'); ops.className = 'ac-ops'
      const up = mkOp('▲', '上移', i === 0, () => { album.move(t.id, -1); renderAlbum() })
      const down = mkOp('▼', '下移', i === album.length - 1, () => { album.move(t.id, 1); renderAlbum() })
      const del = mkOp('✕', '移除', false, () => { album.remove(t.id); renderAlbum() })
      del.classList.add('remove')
      ops.append(up, down, del)

      row.append(num, title, lufs, gain, gap, isrc, ops)
      list.appendChild(row)
    })
  }
  function mkOp(glyph, label, disabled, onClick) {
    const b = document.createElement('button')
    b.className = 'album-op-btn'; b.textContent = glyph
    b.setAttribute('aria-label', label); b.title = label
    b.disabled = disabled
    b.addEventListener('click', onClick)
    return b
  }

  // Render one album track through its own frozen chain at CD rate (44.1kHz).
  // Decode directly at 44.1k (avoids 48k→44.1k double conversion). The per-track
  // gainTrim folds into masterVol. Returns the rendered 44.1k AudioBuffer.
  const DDP_RATE = 44100
  async function renderAlbumTrack(track) {
    const arr = await track.file.arrayBuffer()
    const dctx = new OfflineAudioContext(2, 1, DDP_RATE)
    const decoded = await Promise.race([
      dctx.decodeAudioData(arr),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`「${track.title}」解碼逾時`)), 30000)),
    ])
    const snap = track.snapshot ?? engine.serialize()
    // Album loudness trim folds into limInput (PRE-limiter) so the true-peak
    // ceiling still protects against clipping — never as post-limiter output gain.
    const params = { ...snap.params, limInput: (snap.params?.limInput ?? 0) + (track.gainTrimDb || 0) }
    return renderMasterChain({
      engine, sourceBuffer: decoded, params,
      bypassed: snap.bypassed ?? engine.bypassed,
      sampleRate: DDP_RATE, linPhaseMag: null, dynamicsWorkletUrl,
    })
  }
  if (import.meta.env.DEV) window.__wf_renderAlbumTrack = renderAlbumTrack

  // Hybrid album loudness: measure each track's PROCESSED loudness (rendered at
  // trim 0), then suggest a gain trim toward the target — a STARTING POINT the
  // user refines by ear (real album mastering balances relatively, not hard-NR).
  document.getElementById('album-align-btn')?.addEventListener('click', async () => {
    if (album.length === 0) return
    const target = parseFloat(document.getElementById('album-target')?.value) || -14
    const btn = document.getElementById('album-align-btn')
    btn.disabled = true
    setProcessing(true, '量測各軌響度...', 5)
    try {
      for (let i = 0; i < album.length; i++) {
        const t = album.tracks[i]
        setProcessing(true, `量測第 ${i + 1}/${album.length} 軌：${t.title}`, 5 + (i / album.length) * 90)
        // render at trim 0 to get the track's natural processed loudness
        const buf = await renderAlbumTrack({ ...t, gainTrimDb: 0 })
        const chs = []
        for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c))
        const measured = measureIntegratedLUFS(chs, 44100)
        const trim = loudnessTrim(measured, target)
        // displayed LUFS = aligned result (measured + trim); honest if clamped
        album.update(t.id, { gainTrimDb: trim, lufs: Number.isFinite(measured) ? measured + trim : null })
      }
      renderAlbum()
      setProcessing(false, '', 100)
      setStatus(`✓ 已對齊 ${album.length} 軌至 ${target} LUFS（起點，可手動微調每軌增益）`, true)
    } catch (err) {
      setProcessing(false, '', 0)
      setStatus(`響度對齊失敗：${err.message}`, false)
      console.error('[WaveForge] album align error', err)
    } finally {
      btn.disabled = album.length === 0
    }
  })

  // Album export: render every track at 44.1k → frame-aligned assembly →
  // 16-bit dithered WAV image + CUE sheet + MD5, zipped. (CUE+WAV is the open,
  // widely-accepted CD master interchange; proprietary DDP 2.00 descriptors are
  // NOT faked — see PHASE6_PLAN.)
  document.getElementById('album-export-btn')?.addEventListener('click', async () => {
    if (album.length === 0) return
    const btn = document.getElementById('album-export-btn')
    btn.disabled = true
    setProcessing(true, '渲染專輯曲目...', 5)
    try {
      const rendered = []
      for (let i = 0; i < album.length; i++) {
        const t = album.tracks[i]
        setProcessing(true, `渲染第 ${i + 1}/${album.length} 軌：${t.title}`, 5 + (i / album.length) * 70)
        const buf = await renderAlbumTrack(t)
        const left = buf.getChannelData(0)
        const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)
        rendered.push({ left, right, gapBeforeSec: t.gapBeforeSec, isrc: t.isrc, title: t.title })
      }
      setProcessing(true, '拼接專輯影像（CD frame 對齊）...', 80)
      const asm = assembleAlbum(rendered, 44100)

      setProcessing(true, '編碼 16-bit WAV image...', 88)
      const wavBytes = new Uint8Array(encodeWAV([asm.left, asm.right], 44100, 16))
      const cue = generateCue({ imageFile: 'album.wav', markers: asm.markers })
      const checksum = `${md5(wavBytes)} *album.wav\n`

      setProcessing(true, '打包 ZIP...', 94)
      const enc = new TextEncoder()
      const zip = createZip([
        { name: 'album.wav', data: wavBytes },
        { name: 'album.cue', data: enc.encode(cue) },
        { name: 'album.md5', data: enc.encode(checksum) },
      ])
      const blob = new Blob([zip], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'waveforge-album.zip'
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      setProcessing(false, '', 100)
      const mins = (asm.totalSamples / 44100 / 60).toFixed(1)
      setStatus(`✓ 已輸出專輯母帶（CUE+WAV · ${album.length} 軌 · ${mins} 分 · 44.1k/16bit · 含 MD5）`, true)
    } catch (err) {
      setProcessing(false, '', 0)
      setStatus(`專輯輸出失敗：${err.message}`, false)
      console.error('[WaveForge] album export error', err)
    } finally {
      btn.disabled = album.length === 0
    }
  })

  // ── Saturator type buttons ──────────────────────────────
  document.querySelectorAll('[data-sat-type]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-sat-type]').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      engine.setSatType(btn.dataset.satType)
      recordEdit()
    })
  })

  // IRC mode buttons: Web Audio 的 DynamicsCompressor 無法實作 IRC 演算法。
  // 按鈕在 index.html 已標示停用（需後端離線渲染），這裡不註冊任何 handler。

  // ── Analyze button ─────────────────────────────────────
  // BPM + Key run client-side (autocorrelation + Krumhansl-Schmuckler).
  // Genre detection requires GPU backend (Essentia + ONNX) — honest about this.
  document.getElementById('analyze-btn')?.addEventListener('click', async () => {
    if (!engine.buffer) return
    const btn = document.getElementById('analyze-btn')
    btn.disabled = true
    btn.textContent = '分析中...'
    setDot('processing')

    function setAnalysisValue(id, text, confPct) {
      const el = document.getElementById(id)
      if (el) {
        el.textContent = text
        el.classList.add('updated')
        setTimeout(() => el.classList.remove('updated'), 600)
      }
      const confEl = document.getElementById(`conf-${id}`)
      if (confEl && confPct != null) {
        confEl.style.width = `${Math.round(confPct)}%`
        confEl.title = `信心度 ${Math.round(confPct)}%`
      }
    }

    try {
      // Step 1: BPM detection (client-side, ~50ms)
      setStatus('偵測 BPM...', true)
      // yield to paint before heavy computation
      await new Promise(r => setTimeout(r, 0))
      const bpmResult = detectBPM(engine.buffer)

      if (bpmResult.bpm !== null) {
        setAnalysisValue('val-bpm',
          `${bpmResult.bpm}`,
          bpmResult.confidence * 100)
      } else {
        setAnalysisValue('val-bpm', '無法偵測', 0)
      }

      // Step 2: Key detection (client-side, ~100ms)
      setStatus('偵測調性...', true)
      await new Promise(r => setTimeout(r, 0))
      const keyResult = detectKey(engine.buffer)

      if (keyResult.key !== null) {
        setAnalysisValue('val-key',
          `${keyResult.key} ${keyResult.scale}`,
          keyResult.confidence * 100)
      } else {
        setAnalysisValue('val-key', '無法偵測', 0)
      }

      // Step 3: Genre — requires ML backend, be honest
      setAnalysisValue('val-genre', 'AI 後端', null)
      const confEl = document.getElementById('conf-val-genre')
      if (confEl) { confEl.style.width = '0%'; confEl.title = '需要後端 AI 分析' }

      // Honest about scope: detectBPM samples the first 45 s, detectKey the first 30 s
      setStatus(
        bpmResult.bpm
          ? `${bpmResult.bpm} BPM（前 45 秒）· ${keyResult.key ?? '?'} ${keyResult.scale ?? ''}（前 30 秒）· 曲風需後端`
          : '曲風需後端 AI 分析',
        true
      )

    } catch (err) {
      setStatus(`分析失敗：${err.message}`, false)
    } finally {
      btn.disabled = false
      btn.textContent = '◎ 分析'
      setDot('active')
    }
  })

  // ── Export report: surface measured loudness/peak so the user can TRUST
  // the output instead of just receiving a WAV blind. Warnings → red status.
  function showExportReport(report, bitDepth = 24) {
    const lufsTxt = Number.isFinite(report.lufs) ? `${report.lufs.toFixed(1)} LUFS` : '— LUFS'
    const tpTxt   = Number.isFinite(report.truePeakDb) ? `${report.truePeakDb.toFixed(1)} dBTP` : '— dBTP'
    const parts = [`已輸出 ${bitDepth}bit/48kHz`, `整合 ${lufsTxt}`, `True Peak ${tpTxt}`]
    if (report.lufsNote) parts.push(report.lufsNote)
    if (engine.abMode === 'A') parts.push('注意：輸出為處理後，目前監聽 A=原始')
    if (report.warnings.length) {
      setStatus(`⚠ ${report.warnings.join('；')} ｜ ${parts.join(' · ')}`, false)
    } else {
      setStatus(`✓ ${parts.join(' · ')}`, true)
    }
    console.info('[WaveForge] export report', report)
  }

  // ── Export ──────────────────────────────────────────────
  document.getElementById('export-btn')?.addEventListener('click', async () => {
    if (!engine.buffer) return
    const btn = document.getElementById('export-btn')
    btn.disabled = true
    btn.textContent = '輸出中...'
    setProcessing(true, '渲染處理後音訊（離線渲染）...', 0)

    try {
      const dur = engine.buffer.duration
      const sr  = engine.ctx.sampleRate
      const p   = engine.params
      const byp = engine.bypassed

      // Linear-phase EQ (export only): compute the 10-band EQ magnitude → FIR.
      // Realtime preview stays minimum-phase biquad.
      let linPhaseMag = null
      if (!byp.eq && document.getElementById('eq-linphase')?.checked) {
        const FFT_N = 4096
        const grid = new Float32Array(FFT_N / 2 + 1)
        const nyq = sr / 2
        for (let k = 0; k <= FFT_N / 2; k++) grid[k] = Math.max(1, (k / (FFT_N / 2)) * nyq)
        linPhaseMag = engine.getEQResponse(grid)
      }

      setProcessing(true, `渲染中（${fmtTime(dur)}）...`, 30)
      // Single shared chain (also used by album per-track render) — no drift.
      const rendered = await renderMasterChain({
        engine, sourceBuffer: engine.buffer, params: p, bypassed: byp,
        sampleRate: sr, linPhaseMag, dynamicsWorkletUrl,
      })
      setProcessing(true, '分析輸出...', 70)

      // Mastering report: measure the ACTUAL rendered output (not the live meter)
      let channels = []
      for (let ch = 0; ch < rendered.numberOfChannels; ch++) channels.push(rendered.getChannelData(ch))

      // True-peak safety pass (export only): 4× oversampled offline limiter that
      // GUARANTEES the file's inter-sample peak ≤ ceiling. Realtime stays sample-peak.
      if (!byp.limiter && document.getElementById('lim-truepeak')?.checked) {
        setProcessing(true, '真 True-Peak 限幅...', 60)
        channels = truePeakLimit(channels, rendered.sampleRate, p.limCeiling)
      }

      const report = buildExportReport(channels, rendered.sampleRate, {
        targetLUFS: activeTargetLUFS,
        ceilingDb: byp.limiter ? 0 : p.limCeiling,
      })

      const bitDepth = parseInt(document.getElementById('export-bitdepth')?.value ?? '24', 10)
      setProcessing(true, `編碼 WAV ${bitDepth}-bit...`, 85)

      const wav = encodeWAV(channels, rendered.sampleRate, bitDepth)
      const blob = new Blob([wav], { type: 'audio/wav' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href = url
      a.download = `waveforge-master-${bitDepth}bit.wav`
      // Firefox ignores .click() on a detached anchor — must be in the DOM,
      // and the URL must outlive the click (revoke async, not immediately).
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)

      setProcessing(false, '', 100)
      showExportReport(report, bitDepth)
    } catch (err) {
      setProcessing(false, '', 0)
      setStatus(`輸出失敗：${err.message}`, false)
      console.error('[WaveForge] export error', err)
    } finally {
      btn.disabled = false
      btn.textContent = '↓ 輸出'
    }
  })

  // ── Leave warning ────────────────────────────────────────
  window.addEventListener('beforeunload', e => {
    if (engine.buffer || album.length > 0) {
      e.preventDefault()
      e.returnValue = album.length > 0
        ? `您有 ${album.length} 軌專輯序列尚未輸出，離開將全部遺失。確定要離開嗎？`
        : '您有未下載的處理結果，確定要離開嗎？'
    }
  })

  window.addEventListener('pagehide', () => clearInterval(timeLoopId))
}

// ── Entry point ──────────────────────────────────────────
boot()
