import { History } from '../history.js'
import { sha256Hex } from '../audio/sha256.js'
import { createSession, editLine, parseSession, diagnostics, clone } from './session.js'
import { exportLyrics } from './export.js'

const STORAGE_KEY = 'waveforge.lyrics.recovery.v1'

export function initLyricsPanel({ engine, getCurrentFile, playRange, stopPlayback }) {
  const root = document.getElementById('mode-lyrics')
  const el = id => document.getElementById(`lyrics-${id}`)
  let session = createSession(), history = new History(clone(session)), sessionTouched = false, selected = 'line-1'
  let acceptedSource = null, generation = 0, editEpoch = 0, pendingSource = false, waveform = null
  const commands = new Map()
  const notify = text => { el('status').textContent = text }
  const selectedLine = () => session.lines.find(l => l.id === selected)
  const matchesSource = () => acceptedSource && session.source?.hash === acceptedSource.hash && Math.abs(session.source.duration - acceptedSource.duration) < .001
  const connected = () => !pendingSource && matchesSource()
  const recoverable = () => { try { return !!localStorage.getItem(STORAGE_KEY) } catch { return false } }
  let saveTimer, pendingBackup = null
  function persistRecovery(backup) {
    try {
      localStorage.setItem(STORAGE_KEY, backup.payload)
      el('save-status').textContent = `已備份文字與時間 · r${backup.revision}（不含音檔）`
      return true
    } catch {
      el('save-status').textContent = '備份失敗；請下載歌詞工程，修改仍保留在此頁'
      return false
    }
  }
  function cancelRecovery() {
    clearTimeout(saveTimer); saveTimer = null; pendingBackup = null
  }
  function flushRecovery() {
    clearTimeout(saveTimer); saveTimer = null
    if (!pendingBackup) return true
    const backup = pendingBackup; pendingBackup = null
    const saved = persistRecovery(backup)
    refreshControls()
    return saved
  }
  function saveRecovery() {
    cancelRecovery()
    // Freeze the edit being saved; a later source/restore must not replace it.
    pendingBackup = { payload: JSON.stringify(session), revision: session.revision }
    saveTimer = setTimeout(flushRecovery, 350)
  }
  function commit(next) {
    const validated = parseSession(next)
    editEpoch++; sessionTouched = true; session = validated; history.push(clone(session)); render(); saveRecovery()
  }
  function restore(next) {
    stopPlayback()
    const restored = parseSession(next)
    cancelRecovery()
    editEpoch++; sessionTouched = true; session = restored; history.push(clone(session)); selected = session.lines[0].id
    el('raw').value = session.rawText
    render(); saveRecovery()
    notify(connected() ? '已恢復歌詞與時間，已核對為同一份原音檔' : '已恢復文字與時間；請載入同一份原音檔，核對完成後就能校正與匯出字幕')
  }
  function add(id, label, feature, handler, enabled = () => true, reason = '') {
    commands.set(id, { id, label, feature, handler, enabled, reason })
  }
  async function dispatch(id) {
    const cmd = commands.get(id)
    if (!cmd) return
    if (!cmd.enabled()) { notify(cmd.reason); return }
    try { await cmd.handler() } catch (err) { notify(err.message) }
  }
  function download(text, name, type = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }))
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1500)
  }
  add('lyrics.apply', '套用這份歌詞', 'DAW-LYR01', () => {
    const next = createSession(el('raw').value, acceptedSource)
    next.revision = session.revision + 1
    commit(next); selected = session.lines[0].id; render()
    notify('已套用原文，請逐句記錄開始與結束。改用另一份歌詞會清除時間，可按「復原」取回')
  }, () => !pendingSource, '正在核對音檔，請稍候')
  add('lyrics.undo', '復原歌詞操作', 'DAW-LYR04', () => {
    editEpoch++; sessionTouched = true; stopPlayback(); session = clone(history.undo()); el('raw').value = session.rawText; render(); saveRecovery()
  }, () => history.canUndo, '沒有可復原的歌詞操作')
  add('lyrics.redo', '重做歌詞操作', 'DAW-LYR04', () => {
    editEpoch++; sessionTouched = true; stopPlayback(); session = clone(history.redo()); el('raw').value = session.rawText; render(); saveRecovery()
  }, () => history.canRedo, '沒有可重做的歌詞操作')
  add('lyrics.start', '以播放位置打句首', 'DAW-LYR04', () => setTiming('start', engine.currentTime), connected, '請先載入相同的原音檔')
  add('lyrics.end', '以播放位置打句尾', 'DAW-LYR04', () => setTiming('end', engine.currentTime), connected, '請先載入相同的原音檔')
  add('lyrics.confirm', '確認此句已聽對', 'DAW-LYR04', () => {
    commit(editLine(session, selected, { confirmed: true })); notify('已記錄人工確認；不代表模型辨識正確率')
  }, () => connected() && selectedLine()?.start !== null && selectedLine()?.end !== null && selectedLine()?.sung, '需有有效句首、句尾與相符來源')
  add('lyrics.reset', '清除此句時間', 'DAW-LYR04', () => commit(editLine(session, selected, { start: null, end: null, confirmed: false })))
  add('lyrics.play', '播放此句', 'DAW-LYR04', () => {
    const line = selectedLine(); return playRange(line.start, line.end, el('loop').checked)
  }, () => connected() && selectedLine()?.start !== null && selectedLine()?.end !== null, '需有有效句首、句尾與相符來源')
  add('lyrics.stop', '停止句子播放', 'DAW-LYR04', stopPlayback, () => !!engine.buffer, '尚未載入音訊')
  add('lyrics.previous', '選取上一行', 'DAW-LYR04', () => selectRelative(-1))
  add('lyrics.next', '選取下一行', 'DAW-LYR04', () => selectRelative(1))
  add('lyrics.save', '下載歌詞工程 JSON', 'DAW-LYR05', () => {
    download(JSON.stringify(session, null, 2), 'WaveForge_Lyrics.json', 'application/json'); notify('已產生工程下載；音檔需另行保留')
  })
  add('lyrics.open', '開啟歌詞工程 JSON', 'DAW-LYR05', () => el('project-file').click(), () => !pendingSource, '音檔正在核對，完成後可開啟工程')
  add('lyrics.recover', '恢復上次本機備份', 'DAW-LYR05', () => {
    const next = parseSession(localStorage.getItem(STORAGE_KEY)); restore(next)
  }, () => !pendingSource && recoverable(), '音檔核對中或此瀏覽器尚無歌詞備份')
  for (const format of ['lrc', 'srt', 'ass', 'txt']) {
    add(`lyrics.export.${format}`, `匯出 ${format.toUpperCase()}`, 'DAW-LYR06', () => {
      const text = exportLyrics(session, format, { allowOverlap: el('overlap').checked })
      download(text, `WaveForge_Lyrics.${format}`)
      notify(`已產生 ${format.toUpperCase()} 下載 · 原文 r${session.revision}${format === 'ass' ? '；Arial 樣式，實際字型依播放器' : ''}`)
    }, () => format === 'txt' || !!connected(), '請先載入保存這份歌詞時使用的原音檔')
  }
  function setTiming(key, value) {
    if (!connected()) throw new Error('來源未連結，不能套用時間')
    if (!Number.isFinite(value)) throw new Error('請輸入有效秒數')
    commit(editLine(session, selected, { [key]: Math.round(value * 1000) / 1000 }))
  }
  function selectRelative(delta) {
    const index = session.lines.findIndex(l => l.id === selected)
    selected = session.lines[Math.max(0, Math.min(session.lines.length - 1, index + delta))].id
    render(); el('list').querySelector(`[data-line="${selected}"]`)?.focus()
  }
  function refreshControls() {
    for (const button of root.querySelectorAll('[data-command]')) {
      const cmd = commands.get(button.dataset.command)
      if (!cmd) continue
      button.disabled = !cmd.enabled(); button.title = button.disabled ? cmd.reason : cmd.label
    }
    for (const id of ['start-value', 'end-value', 'sung']) el(id).disabled = !connected()
    for (const option of el('command-select').options) {
      const cmd = commands.get(option.value); option.disabled = !cmd?.enabled()
    }
  }
  function render() {
    const focusedLine = root.contains(document.activeElement) ? document.activeElement?.dataset.line : null
    if (!selectedLine()) selected = session.lines[0].id
    const line = selectedLine()
    el('list').replaceChildren(...session.lines.map((l, index) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.line = l.id
      button.className = 'lyrics-line'; button.setAttribute('aria-pressed', String(l.id === selected))
      const badge = !l.sung ? '非演唱' : l.confirmed ? '已確認' : l.start === null || l.end === null ? '待打點' : '待確認'
      button.textContent = `${String(index + 1).padStart(2, '0')} · ${l.text || '（空行）'} · ${badge}`
      return button
    }))
    el('selected-text').textContent = line.text || '（空行）'
    el('selected-id').textContent = `第 ${session.lines.indexOf(line) + 1} 行 · 原文 r${session.revision}`
    el('start-value').value = line.start ?? ''; el('end-value').value = line.end ?? ''
    el('sung').checked = line.sung; el('offset').value = session.displayOffsetMs
    const errors = diagnostics(session, { allowOverlap: el('overlap').checked })
    el('diagnostics').textContent = errors.length ? errors.slice(0, 8).join('\n') + (errors.length > 8 ? `\n另有 ${errors.length - 8} 項` : '') : '逐句時間已確認；匯出仍會依格式精度再檢查'
    el('source').textContent = pendingSource ? '正在核對是否為同一份原音檔…' : connected() ? `來源已連結 · ${acceptedSource.name} · ${acceptedSource.duration.toFixed(3)} 秒` : session.source ? `來源未連結 · 請選回 ${session.source.name}` : '先使用上方「選取音檔」載入歌曲'
    refreshControls(); drawWaveform()
    if (focusedLine) el('list').querySelector(`[data-line="${focusedLine}"]`)?.focus({ preventScroll: true })
  }
  function drawWaveform() {
    const canvas = el('waveform'), ctx = canvas.getContext('2d')
    if (!ctx) return
    const width = Math.max(1, Math.floor(canvas.clientWidth)), height = 120
    canvas.width = width; canvas.height = height; ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#14211e'; ctx.fillRect(0, 0, width, height)
    if (!waveform || !connected()) return
    ctx.fillStyle = '#6fe3c0'
    for (let x = 0; x < width; x++) {
      const i = Math.min(waveform.length - 1, Math.floor(x / width * waveform.length))
      const h = Math.max(1, waveform[i] * height * .8); ctx.fillRect(x, (height - h) / 2, 1, h)
    }
    const line = selectedLine()
    if (line.start !== null && line.end !== null) {
      ctx.fillStyle = '#e6bc674d'; ctx.fillRect(line.start / engine.duration * width, 0, (line.end - line.start) / engine.duration * width, height)
    }
  }
  root.addEventListener('click', e => {
    const button = e.target.closest('[data-command]'); if (button) dispatch(button.dataset.command)
    const row = e.target.closest('[data-line]'); if (row) { selected = row.dataset.line; render(); el('list').querySelector(`[data-line="${selected}"]`)?.focus() }
  })
  for (const key of ['start', 'end']) el(`${key}-value`).addEventListener('change', e => {
    try { setTiming(key, e.target.value === '' ? NaN : Number(e.target.value)) } catch (err) { render(); notify(err.message) }
  })
  el('sung').addEventListener('change', e => {
    try { commit(editLine(session, selected, { sung: e.target.checked })) } catch (err) { render(); notify(err.message) }
  })
  el('offset').addEventListener('change', e => {
    try { const next = clone(session); next.displayOffsetMs = e.target.value === '' ? NaN : Number(e.target.value); next.revision++; commit(next) } catch (err) { render(); notify(err.message) }
  })
  el('overlap').addEventListener('change', render)
  el('project-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
    try {
      if (pendingSource) throw new Error('音檔正在核對，完成後請重新開啟')
      if (file.size > 2 * 1024 * 1024) throw new Error('歌詞工程上限 2 MB')
      const token = generation, epoch = editEpoch
      const next = parseSession(await file.text())
      if (token !== generation || epoch !== editEpoch) throw new Error('工程讀取期間來源或歌詞已變更，請重新開啟')
      restore(next)
    } catch (err) { notify(`開啟失敗：${err.message}`) }
  })
  el('waveform').addEventListener('click', e => {
    if (!connected()) return
    stopPlayback()
    const rect = e.currentTarget.getBoundingClientRect()
    engine.seekTo((e.clientX - rect.left) / rect.width)
  })
  el('waveform').addEventListener('keydown', e => {
    if (!connected() || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault(); const current = engine.currentTime; stopPlayback()
    const time = e.key === 'Home' ? 0 : e.key === 'End' ? engine.duration : current + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? .01 : .1)
    engine.seekTo(time / engine.duration)
  })
  root.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229 || e.target.matches('input, textarea, select, [contenteditable="true"]')) return
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); dispatch(e.shiftKey ? 'lyrics.redo' : 'lyrics.undo'); return }
    if (e.altKey && ['[', ']'].includes(e.key)) { e.preventDefault(); dispatch(e.key === '[' ? 'lyrics.start' : 'lyrics.end') }
  })
  for (const cmd of commands.values()) {
    const option = document.createElement('option'); option.value = cmd.id; option.textContent = cmd.label; el('command-select').appendChild(option)
  }
  el('command-run').addEventListener('click', () => dispatch(el('command-select').value))
  el('command-search').addEventListener('input', e => {
    const query = e.target.value.toLowerCase()
    for (const option of el('command-select').options) option.hidden = !option.textContent.toLowerCase().includes(query)
    const first = [...el('command-select').options].find(o => !o.hidden && !o.disabled)
    if (first) el('command-select').value = first.value
  })
  const observer = new ResizeObserver(drawWaveform); observer.observe(el('waveform'))
  const ticker = setInterval(() => {
    if (root.hidden) return
    const time = Math.min(engine.duration, engine.currentTime)
    el('position').textContent = `${time.toFixed(3)} s`
    el('waveform').setAttribute('aria-valuenow', String(time))
    el('waveform').setAttribute('aria-valuemax', String(engine.duration))
  }, 100)
  window.addEventListener('pagehide', event => {
    flushRecovery()
    // BFCache freezes and resumes these resources with the document.
    if (!event.persisted) { clearInterval(ticker); observer.disconnect() }
  })
  render()
  if (recoverable()) notify('此瀏覽器有上次備份，可按「恢復上次」；不會自動覆蓋目前工作')
  return {
    sourceLoading() {
      ++generation; pendingSource = true; flushRecovery(); stopPlayback(); render()
    },
    sourceFailed(file, buffer) {
      if (file && buffer) return this.sourceAccepted(file, buffer, { stop: false })
      ++generation; pendingSource = false; acceptedSource = null; waveform = null; render()
    },
    async sourceAccepted(file, buffer, { stop = true } = {}) {
      const wasConnected = !!matchesSource()
      const token = ++generation; pendingSource = true; flushRecovery()
      if (stop) stopPlayback()
      render()
      try {
        const bytes = await file.arrayBuffer(), hash = await sha256Hex(bytes)
        if (token !== generation || getCurrentFile() !== file) return
        acceptedSource = { name: file.name, hash, duration: buffer.duration }
        if (!session.source || session.source.hash !== hash) {
          // Opening an imported session with another source keeps it disconnected.
          if (!session.source || wasConnected) {
            const next = createSession(session.rawText, acceptedSource); next.revision = session.revision + 1
            // Loading a file into a fresh/untouched page must not overwrite the
            // previous session's recoverable backup with an empty template.
            const hadUserEdits = sessionTouched
            const backedUp = hadUserEdits && persistRecovery({ payload: JSON.stringify(session), revision: session.revision })
            editEpoch++; session = next; sessionTouched = false; history.push(clone(next))
            notify(!hadUserEdits
              ? '來源已載入。可貼上歌詞，或按「恢復上次」取回已存的文字與時間'
              : backedUp
              ? '新來源已載入；原文保留，舊時間已清除，可復原。上次備份仍可恢復'
              : '新來源已載入；備份失敗，舊時間仍可按「復原」取回並下載工程')
          } else notify('這不是原先的音檔。舊歌詞與時間仍保留；若要改用新音檔，請按「套用歌詞」重新對時')
        }
        waveform = new Float32Array(2048)
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const samples = buffer.getChannelData(c)
          for (let i = 0; i < samples.length; i++) {
            const bin = Math.min(2047, Math.floor(i / samples.length * 2048))
            waveform[bin] = Math.max(waveform[bin], Math.abs(samples[i]))
          }
        }
      } catch (err) {
        if (token !== generation || getCurrentFile() !== file) return
        acceptedSource = null; notify(`來源核對失敗：${err.message}；文字仍保留`)
      }
      finally { if (token === generation) { pendingSource = false; render() } }
    },
    clear() { flushRecovery(); ++generation; ++editEpoch; pendingSource = false; acceptedSource = null; waveform = null; stopPlayback(); render() },
  }
}
