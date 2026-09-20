import { loudnessTrim } from '../album.js'
import { measureIntegratedLUFS } from '../audio/measure.js'
import { renderFinalMaster } from '../audio/final-render.js'
import { assertIntegerHeadroom } from '../audio/export-safety.js'
import { encodeWAV } from '../audio/wav.js'
import { assembleAlbum } from '../audio/album-assembly.js'
import { generateCue } from '../audio/cue.js'
import { createZip } from '../audio/zip.js'
import { md5 } from '../audio/md5.js'

// Owns album list interaction and package rendering; the shared Album holds files.
export function initAlbumPanel({ album, engine, getCurrentFile, captureRenderOptions, setProcessing, setStatus }) {
  // ── Album sequence (Phase 6) ────────────────────────────
  document.getElementById('album-add-btn')?.addEventListener('click', () => {
    const currentFile = getCurrentFile()
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
      txt.textContent = '載入並調好一首後，按上方「＋ 加入專輯」逐曲建立序列；之後輸出 CD Master Package。'
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
    const bypassed = snap.bypassed ?? engine.bypassed
    // Album loudness trim folds into limInput (PRE-limiter) so the true-peak
    // ceiling still protects against clipping — never as post-limiter output gain.
    const params = { ...snap.params }
    const trim = track.gainTrimDb || 0
    if (bypassed.limiter) {
      // A true limiter bypass skips its input gain too; retain album trim.
      params.masterOutputGainDb = (params.masterOutputGainDb ?? 20 * Math.log10(params.masterVol ?? 1)) + trim
    } else {
      params.limInput = (params.limInput ?? 0) + trim
    }

    // Linear-phase EQ is a single export-time toggle shared with single-track
    // export (matches DDP_RATE below: one setting applied uniformly across the
    // album). Each track's OWN snapshot gains feed the FIR design — never the
    // live engine's current gains, which reflect whichever track (if any) is
    // loaded in the main view and would otherwise bleed into every track.
    const result = await renderFinalMaster({ ...captureRenderOptions(),
      sourceBuffer: decoded, snapshot: { params, bypassed }, sampleRate: DDP_RATE })
    return result.buffer
  }

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
      assertIntegerHeadroom([asm.left, asm.right])
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

  return { renderAlbum, renderAlbumTrack }
}
