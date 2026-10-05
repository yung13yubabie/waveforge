import { History } from '../history.js'
import { sha256Hex } from '../audio/sha256.js'
import { createSession, editLine, parseSession, diagnostics, clone, setManualLock, adoptAlignmentCandidates } from './session.js'
import { exportLyrics } from './export.js'
import { createLocalAlignmentService } from './alignment-service.js'

const STORAGE_KEY = 'waveforge.lyrics.recovery.v1'
const ALIGNMENT_REASONS = {
  partial_lyrics: '只有部分原文字元能與辨識結果對上', extra_asr_words: '附近可能有原稿未列入的唱詞',
  protected_line: '保留已確認或手動調整的時間', protected_anchor: '使用已保留的時間作為位置參考',
  not_targeted: '此行只提供前後文，不改時間', not_sung: '此行標為非演唱', workload_limit: '分析範圍太大，請只重找一句或較短片段',
  invalid_anchors: '前後已保留的時間有衝突，請先檢查時間順序', invalid_anchor: '作為參考的時間無效',
  invalid_protected_timing: '保留的時間無效，請先檢查', nonmonotone_anchors: '已保留時間與行序衝突',
  no_lexical_content: '此行沒有可比對的文字，請確認是否有演唱', insufficient_word_evidence: '未找到足夠的文字吻合依據',
  ambiguous_alignment: '找到多個相近位置，需確認是哪一次演唱', monotone_context_conflict: '候選位置與前後句順序衝突',
}
const explainReason = reason => ALIGNMENT_REASONS[reason] ?? reason
const describeAlignmentError = error => ({
  TimeoutError: '分析等待時間過長，已停止；可只重找一句後再試',
  ModelSourceApprovalError: '模型來源與下載尚未獲同意，請重新確認上方下載說明並勾選同意',
})[error?.name] ?? error?.message ?? String(error)

export function initLyricsPanel({ engine, getCurrentFile, playRange, stopPlayback, alignmentService }) {
  const root = document.getElementById('mode-lyrics')
  const el = id => document.getElementById(`lyrics-${id}`)
  let session = createSession(), history = new History(clone(session)), sessionTouched = false, selected = 'line-1'
  let acceptedSource = null, generation = 0, editEpoch = 0, pendingSource = false, waveform = null
  const service = alignmentService ?? createLocalAlignmentService()
  let activeTask = null, proposal = null, taskSequence = 0, clearingCache = false
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
    invalidateAlignment('歌詞或時間已變更，這次分析未套用')
    editEpoch++; sessionTouched = true; session = validated; history.push(clone(session)); render(); saveRecovery()
  }
  function restore(next) {
    stopPlayback()
    const restored = parseSession(next)
    cancelRecovery()
    invalidateAlignment('已開啟另一份工程，這次分析未套用')
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
    notify('已套用原文，可自動找時間或手動校正。改用另一份歌詞會清除時間，可按「復原」取回')
  }, () => !pendingSource, '正在核對音檔，請稍候')
  add('lyrics.undo', '復原歌詞操作', 'DAW-LYR04', () => {
    invalidateAlignment('已復原操作，這次分析未套用')
    editEpoch++; sessionTouched = true; stopPlayback(); session = clone(history.undo()); el('raw').value = session.rawText; render(); saveRecovery()
  }, () => history.canUndo, '沒有可復原的歌詞操作')
  add('lyrics.redo', '重做歌詞操作', 'DAW-LYR04', () => {
    invalidateAlignment('已重做操作，這次分析未套用')
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
  const editableTargets = () => session.lines.filter(line => line.sung && !line.manualLocked && !line.confirmed)
  const unresolvedTargets = () => editableTargets().filter(line => line.start === null || line.end === null || !line.confirmed)
  const rawDraftChanged = () => el('raw').value !== session.rawText
  function alignmentBlocker() {
    if (clearingCache) return '正在刪除模型快取，完成後可重新分析'
    if (activeTask) return '分析進行中；可取消，或繼續手動校正'
    if (proposal) return '請先採用這次結果，或選「保留目前時間」'
    if (!connected() || !engine.buffer) return '請先載入相同的原音檔'
    if (rawDraftChanged()) return '原文有修改，請先按「套用歌詞」'
    if (!el('language').value) return '請先選擇這段主要演唱語言'
    if (!el('model-consent').checked) return '請先閱讀模型下載說明，並勾選同意'
    if (!editableTargets().length) return '沒有可分析的演唱行；已確認與保留的時間不會覆蓋'
    return ''
  }
  function snapshot() {
    return { generation, editEpoch, buffer: engine.buffer, hash: acceptedSource?.hash,
      rawText: session.rawText, rawDraft: el('raw').value, language: el('language').value }
  }
  function isCurrent(saved) {
    return connected() && saved.generation === generation && saved.editEpoch === editEpoch &&
      saved.buffer === engine.buffer && saved.hash === acceptedSource?.hash &&
      saved.rawText === session.rawText && saved.rawDraft === el('raw').value && saved.language === el('language').value
  }
  function invalidateAlignment(message = '已取消分析，原有時間未變') {
    const hadWork = activeTask || proposal
    const task = activeTask
    activeTask = null; proposal = null; ++taskSequence
    task?.controller.abort()
    if (hadWork) {
      el('alignment-message').textContent = message
      el('model-progress').hidden = true
    }
    return !!hadWork
  }
  function timeRange(line) {
    return Number.isFinite(line?.start) && Number.isFinite(line?.end)
      ? `${line.start.toFixed(3)}–${line.end.toFixed(3)} 秒` : '尚無完整時間'
  }
  function candidateFor(id) { return proposal?.result.candidates.find(candidate => candidate.id === id) }
  function candidateLabel(candidate, previous) {
    return candidate?.status === 'matched' ? '找到時間，請試聽'
      : candidate?.status === 'unresolved' ? (Number.isFinite(previous?.start) && Number.isFinite(previous?.end) ? '此次未找到，保留原時間' : '尚未在音訊找到')
      : candidate?.status === 'protected' ? '保留原有時間' : '僅作前後文'
  }
  function evidenceText(candidate) {
    const evidence = candidate?.evidence
    if (!evidence) return '未提供文字比對資料；請試聽確認'
    const pieces = []
    if (Number.isFinite(evidence.matchedCharacters) && Number.isFinite(evidence.totalCharacters)) {
      pieces.push(`文字吻合：${evidence.matchedCharacters}／${evidence.totalCharacters} 個比對字元`)
    }
    if (!pieces.length && Number.isFinite(evidence.coverage)) pieces.push(`文字吻合指標：${evidence.coverage.toFixed(2)}（0–1）`)
    if (Array.isArray(evidence.reasons)) pieces.push(...evidence.reasons.filter(reason => typeof reason === 'string').map(explainReason))
    if (typeof evidence.unmatchedText === 'string' && evidence.unmatchedText) pieces.push(`未對上的文字：${evidence.unmatchedText}`)
    return pieces.join('；') || '未提供文字比對資料；請試聽確認'
  }
  function renderAlignment() {
    el('alignment-availability').textContent = alignmentBlocker() || `可分析 ${editableTargets().length} 句；已確認與手動保留的時間不會覆蓋`
    el('alignment-progress').setAttribute('aria-busy', String(!!activeTask))
    el('proposal').hidden = !proposal
    if (proposal) {
      const candidates = proposal.result.candidates.filter(candidate => proposal.targetIds.includes(candidate.id))
      const matched = candidates.filter(candidate => candidate.status === 'matched').length
      const missing = candidates.filter(candidate => candidate.status === 'unresolved').length
      el('proposal-summary').textContent = `找到 ${matched} 句時間；${missing} 句尚未找到。原文與目前時間尚未變更。`
      el('proposal-list').replaceChildren(...candidates.map(candidate => {
        const row = document.createElement('button'); row.type = 'button'; row.dataset.previewLine = candidate.id
        row.setAttribute('aria-pressed', String(selected === candidate.id))
        const original = session.lines.find(line => line.id === candidate.id)
        row.textContent = `第 ${session.lines.indexOf(original) + 1} 行 · ${original?.text ?? ''} · ${candidateLabel(candidate, original)} · ${timeRange(candidate)}`
        return row
      }))
    } else el('proposal-list').replaceChildren()
    const line = selectedLine(), candidate = candidateFor(selected), savedEvidence = line?.alignment
    const evidence = candidate ?? savedEvidence
    el('manual-lock').checked = !!line?.manualLocked
    el('line-evidence').hidden = !evidence
    if (evidence) {
      el('candidate-times').textContent = candidate
        ? `目前時間：${timeRange(line)}　新時間：${timeRange(candidate)} · ${candidateLabel(candidate, line)}`
        : `目前時間：${timeRange(line)} · ${candidateLabel(savedEvidence, line)}`
      el('candidate-reasons').textContent = evidenceText(evidence)
    }
  }
  function updateProgress(task, progress) {
    if (activeTask !== task || !isCurrent(task.snapshot)) return
    const phases = {
      'reading-cache': '讀取已下載的模型', 'cache-unavailable': '瀏覽器無法保存模型，下次可能需重新下載',
      verifying: '核對模型檔案完整性', loading: '載入本機辨識模型', transcribing: '辨識這段演唱', complete: '這段辨識結束',
      preparing: '準備分析音訊', matching: '比對原文與辨識結果', download: '下載模型', downloading: '下載模型',
      resampling: '準備分析音訊', recognizing: '辨識這段演唱', aligning: '比對原文與辨識結果',
    }
    const parts = [phases[progress?.phase] ?? '正在分析']
    if (typeof progress?.message === 'string' && progress.message) parts.push(progress.message)
    if (Number.isInteger(progress?.chunkIndex) && Number.isInteger(progress?.chunkCount)) parts.push(`片段 ${progress.chunkIndex}／${progress.chunkCount}`)
    const meter = el('model-progress')
    const preparingFiles = ['download', 'downloading', 'reading-cache', 'loading', 'verifying'].includes(progress?.phase)
    const validBytes = (loaded, total) => Number.isFinite(loaded) && Number.isFinite(total) && total > 0 && loaded >= 0 && loaded <= total
    const aggregate = preparingFiles && validBytes(progress.aggregateLoaded, progress.aggregateTotal)
    const perFile = preparingFiles && validBytes(progress.loaded, progress.total)
    meter.hidden = !aggregate && !perFile
    if (aggregate || perFile) {
      const loaded = aggregate ? progress.aggregateLoaded : progress.loaded
      const total = aggregate ? progress.aggregateTotal : progress.total
      meter.max = total; meter.value = loaded
      meter.setAttribute('aria-label', aggregate ? '模型檔案準備（含快取讀取）' : '單一模型檔案準備')
      parts.push(`${aggregate ? '模型檔案準備' : '單一模型檔案準備'} ${(loaded / 1048576).toFixed(1)}／${(total / 1048576).toFixed(1)} MiB${aggregate ? '（含快取讀取）' : ''}`)
    }
    el('alignment-message').textContent = parts.join(' · ')
  }
  async function runAlignment(targetIds, secondPass) {
    const reason = alignmentBlocker()
    if (reason) throw new Error(reason)
    if (!targetIds.length) throw new Error('沒有可重找的句子；已確認與手動保留的時間不會覆蓋')
    const task = { id: ++taskSequence, snapshot: snapshot(), targetIds: [...targetIds], controller: new AbortController() }
    activeTask = task
    el('alignment-message').textContent = secondPass ? `重新尋找 ${targetIds.length} 句；目前時間仍保留` : `開始尋找 ${targetIds.length} 句時間；原文不變`
    renderAlignment(); refreshControls()
    try {
      const result = await service.run({ buffer: task.snapshot.buffer, source: clone(session.source),
        lines: clone(session.lines), revision: session.revision, modelSourceApproved: true, targetIds: task.targetIds, language: task.snapshot.language, secondPass,
        onProgress: progress => updateProgress(task, progress), signal: task.controller.signal })
      if (activeTask !== task) return
      if (!isCurrent(task.snapshot)) {
        invalidateAlignment('音檔或歌詞已變更，這次結果未套用'); renderAlignment(); refreshControls(); return
      }
      if (!result || !Array.isArray(result.candidates)) throw new Error('分析未回傳可檢查的時間，請重試或手動對時')
      // Dry-run the pure session validator before displaying any untrusted candidate.
      // No session, history or backup changes until explicit adoption.
      adoptAlignmentCandidates(session, result, { targetIds: task.targetIds })
      proposal = { result, targetIds: task.targetIds, snapshot: task.snapshot }
      activeTask = null
      el('alignment-message').textContent = ['complete', 'completed'].includes(result.status)
        ? '分析結束，請檢查候選；原有時間尚未變更'
        : `這次分析未能完整執行：${explainReason(result.status ?? '未提供完成狀態')}。請檢查診斷；原有時間未變`
      el('model-progress').hidden = true
    } catch (err) {
      if (activeTask !== task) return
      activeTask = null
      el('model-progress').hidden = true
      el('alignment-message').textContent = task.controller.signal.aborted || err?.name === 'AbortError'
        ? '已取消分析，原有時間未變' : `分析失敗：${describeAlignmentError(err)}。原文與原有時間仍保留，可重試或手動對時`
    } finally {
      // An obsolete task must not clear or announce a newer task's state.
      if (task.id === taskSequence) { renderAlignment(); refreshControls() }
    }
  }
  add('lyrics.align', '自動找每句時間', 'DAW-LYR02', () => runAlignment(editableTargets().map(line => line.id), false), () => !alignmentBlocker(), '請先確認音檔、已套用原文、語言與模型下載同意')
  add('lyrics.align.clear-cache', '刪除此瀏覽器下載的模型', 'DAW-LYR02', async () => {
    clearingCache = true
    el('alignment-message').textContent = '正在刪除此瀏覽器的模型快取…'
    renderAlignment(); refreshControls()
    try {
      const outcome = await service.clearCache()
      el('alignment-message').textContent = outcome?.persistentCacheAvailable === false
        ? '此瀏覽器不支援持久模型快取，本次未刪除模型；歌詞工程仍保留'
        : outcome?.deleted === true
        ? '模型快取已清除，下次分析需重新下載；原音檔與歌詞工程未變'
        : outcome?.deleted === false
        ? '此瀏覽器沒有已下載的模型快取可刪除；下次分析需要時會重新下載'
        : '未收到模型快取刪除確認；原音檔與歌詞工程未變，請稍後重試'
    } catch (err) {
      el('alignment-message').textContent = `模型快取刪除失敗：${err?.message ?? String(err)}。請重試；歌詞工程仍保留`
    } finally { clearingCache = false; renderAlignment(); refreshControls() }
  }, () => !activeTask && !clearingCache && typeof service.clearCache === 'function', '分析或清除快取期間無法刪除模型')
  add('lyrics.align.selected', '只重找這一句', 'DAW-LYR03', () => runAlignment([selected], true),
    () => !alignmentBlocker() && editableTargets().some(line => line.id === selected), '請先完成分析設定；這句須為未鎖定、尚未確認的演唱行')
  add('lyrics.align.unresolved', '重找待確認句', 'DAW-LYR03', () => runAlignment(unresolvedTargets().map(line => line.id), true),
    () => !alignmentBlocker() && unresolvedTargets().length > 0, '請先完成分析設定；沒有可重找的句子')
  add('lyrics.align.cancel', '取消這次分析', 'DAW-LYR03', () => {
    invalidateAlignment(); renderAlignment(); refreshControls(); notify('已取消分析，原有時間未變')
  }, () => !!activeTask, '目前沒有進行中的分析')
  add('lyrics.align.adopt', '採用這批時間與未找到標記', 'DAW-LYR03', () => {
    if (!proposal || !isCurrent(proposal.snapshot)) {
      invalidateAlignment('音檔或歌詞已變更，這次結果未套用'); renderAlignment(); refreshControls(); return
    }
    const next = adoptAlignmentCandidates(session, proposal.result, { targetIds: proposal.targetIds })
    proposal = null
    commit(next)
    el('alignment-message').textContent = '已採用這批分析；請逐句試聽並確認，可一次復原'
    notify('已採用候選時間與分析標記；原文未改動，請逐句試聽確認')
  }, () => !!proposal && isCurrent(proposal.snapshot), '沒有可採用的最新分析結果')
  add('lyrics.align.discard', '保留目前時間，不採用這次分析', 'DAW-LYR03', () => {
    invalidateAlignment('已保留目前時間，這次候選未採用'); renderAlignment(); refreshControls()
  }, () => !!proposal, '目前沒有待採用的候選')
  add('lyrics.align.play', '試聽選中句子的新時間', 'DAW-LYR03', () => {
    const candidate = candidateFor(selected); return playRange(candidate.start, candidate.end, el('loop').checked)
  }, () => !!proposal && isCurrent(proposal.snapshot) && candidateFor(selected)?.status === 'matched' &&
    Number.isFinite(candidateFor(selected)?.start) && Number.isFinite(candidateFor(selected)?.end), '這句尚未找到可試聽的新時間')

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
    for (const id of ['start-value', 'end-value', 'sung', 'manual-lock']) el(id).disabled = !connected()
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
      const badge = !l.sung ? '非演唱' : l.confirmed ? '已確認' : l.manualLocked ? '已手動調整・保留' : l.alignment?.status === 'unresolved' ? candidateLabel(l.alignment, l) : l.start === null || l.end === null ? '待打點' : '待確認'
      button.dataset.timingStatus = !l.sung ? 'silent' : l.confirmed ? 'confirmed' : l.manualLocked ? 'manual' : l.alignment?.status ?? 'pending'
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
    renderAlignment(); refreshControls(); drawWaveform()
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
    const row = e.target.closest('[data-line], [data-preview-line]'); if (row) { selected = row.dataset.line ?? row.dataset.previewLine; render(); el('list').querySelector(`[data-line="${selected}"]`)?.focus() }
  })
  for (const key of ['start', 'end']) el(`${key}-value`).addEventListener('change', e => {
    try { setTiming(key, e.target.value === '' ? NaN : Number(e.target.value)) } catch (err) { render(); notify(err.message) }
  })
  el('sung').addEventListener('change', e => {
    try { commit(editLine(session, selected, { sung: e.target.checked })) } catch (err) { render(); notify(err.message) }
  })
  el('manual-lock').addEventListener('change', e => {
    try { commit(setManualLock(session, selected, e.target.checked)) } catch (err) { render(); notify(err.message) }
  })
  el('raw').addEventListener('input', () => {
    invalidateAlignment('原文草稿已變更，這次分析未套用'); renderAlignment(); refreshControls()
  })
  for (const id of ['language', 'model-consent']) el(id).addEventListener('change', () => {
    invalidateAlignment(id === 'language' ? '語言設定已變更，請重新分析' : '模型下載同意已變更，這次分析未套用'); renderAlignment(); refreshControls()
  })
  el('offset').addEventListener('change', e => {
    try { const next = clone(session); next.displayOffsetMs = e.target.value === '' ? NaN : Number(e.target.value); next.revision++; commit(next) } catch (err) { render(); notify(err.message) }
  })
  el('overlap').addEventListener('change', render)
  el('project-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
    invalidateAlignment('正在開啟工程，這次分析未套用'); renderAlignment(); refreshControls()
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
  const onPageShow = () => { renderAlignment(); refreshControls() }
  const onPageHide = event => {
    flushRecovery()
    invalidateAlignment('已離開頁面，未完成分析不會套用'); service.dispose()
    // BFCache resumes the page with existing controls; never resume an old model task.
    if (!event.persisted) {
      clearInterval(ticker); observer.disconnect()
      window.removeEventListener('pagehide', onPageHide); window.removeEventListener('pageshow', onPageShow)
    }
  }
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', onPageShow)
  const info = service.info ?? {}
  const size = bytes => Number.isFinite(bytes) && bytes > 0 ? `約 ${(bytes / 1048576).toFixed(1)} MiB` : '大小尚未提供'
  el('model-info').textContent = `${info.name ?? '本機辨識模型'} · 首次使用需下載模型（${size(info.downloadBytes)}），另需同站執行檔（${size(info.runtimeAssetBytes)}）${info.license ? ` · ${info.license}` : ''}。模型快取可能由瀏覽器清除，下次需重新下載。`
  for (const [id, url] of [['model-link', info.modelUrl], ['license-link', info.licenseUrl]]) {
    const link = el(id); link.hidden = typeof url !== 'string' || !/^https:\/\//.test(url)
    if (!link.hidden) link.href = url
  }
  render()
  if (recoverable()) notify('此瀏覽器有上次備份，可按「恢復上次」；不會自動覆蓋目前工作')
  return {
    sourceLoading() {
      invalidateAlignment('音檔正在更換，這次分析未套用')
      ++generation; pendingSource = true; flushRecovery(); stopPlayback(); render()
    },
    sourceFailed(file, buffer) {
      invalidateAlignment('音訊來源已變更，這次分析未套用')
      if (file && buffer) return this.sourceAccepted(file, buffer, { stop: false })
      ++generation; pendingSource = false; acceptedSource = null; waveform = null; render()
    },
    async sourceAccepted(file, buffer, { stop = true } = {}) {
      invalidateAlignment('音訊來源已變更，這次分析未套用')
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
    clear() { invalidateAlignment('已清除音訊，這次分析未套用'); service.dispose(); flushRecovery(); ++generation; ++editEpoch; pendingSource = false; acceptedSource = null; waveform = null; stopPlayback(); render() },
  }
}
