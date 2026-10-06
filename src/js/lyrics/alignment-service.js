import { matchLyricsToAsr } from './alignment-matcher.js'
import { WHISPER_MODEL_INFO } from './whisper-config.js'

// No ML import, network request or model allocation occurs at module load.
// The worker client is created only after explicit per-page model consent.
export const LOCAL_ALIGNMENT_INFO = Object.freeze({
  ...WHISPER_MODEL_INFO, name: 'Whisper tiny · 本機多語辨識',
  validation: WHISPER_MODEL_INFO.modelValidation,
})

const LANGUAGES = new Set(['zh', 'en', 'ja', 'ar', 'es', 'fr', 'de', 'ko'])
const abortError = () => new DOMException('已取消分析，原有時間未變', 'AbortError')
function checkAbort(signal) { if (signal?.aborted) throw abortError() }
const validRange = line => Number.isFinite(line.start) && Number.isFinite(line.end) && line.end > line.start
// Offline rendering cannot reliably be aborted. Keep one owner across service
// instances and cancelled runs until the native promise actually settles.
let nativeResamplingOwner = null

export function planAlignmentWindows(lines, targetIds, duration, secondPass = false) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1200) throw new Error('本機自動對時目前限 20 分鐘；較長歌曲請分段處理，手動功能仍可用')
  const targets = new Set(targetIds), ranges = []
  if (!secondPass) ranges.push([0, duration])
  else {
    for (let index = 0; index < lines.length; index++) {
      if (!targets.has(lines[index].id)) continue
      const line = lines[index]
      let left = 0, right = duration
      for (let i = index - 1; i >= 0; i--) if (!targets.has(lines[i].id) && validRange(lines[i])) { left = Math.max(0, lines[i].end - 2); break }
      for (let i = index + 1; i < lines.length; i++) if (!targets.has(lines[i].id) && validRange(lines[i])) { right = Math.min(duration, lines[i].start + 2); break }
      if (validRange(line)) { left = Math.max(left, line.start - 4); right = Math.min(right, line.end + 4) }
      if (right <= left) throw new Error('前後句時間互相衝突，請先校正再重找')
      ranges.push([left, right])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push([...range])
  }
  const windows = []
  for (const [start, end] of merged) {
    let cursor = start
    // A short, unanchored retry otherwise feeds precisely the same clip to a
    // deterministic recognizer. Use overlapping focused views instead. Very
    // short clips keep their full context and may still require a manual cue.
    const windowSeconds = secondPass && start === 0 && end === duration && duration > 4 && duration <= 20
      ? Math.max(4, duration * .65) : 20
    // With no usable anchors, pass two moves the seams rather than rerunning
    // precisely the same windows. This is new context, not a quality promise.
    if (secondPass && end - start > 20) { windows.push({ start, end: start + 11 }); cursor = start + 9 }
    while (cursor < end) {
      const stop = Math.min(end, cursor + windowSeconds)
      windows.push({ start: cursor, end: stop })
      if (stop === end) break
      cursor = stop - 2
    }
  }
  return windows
}

export function chooseAnalysisChannel(buffer) {
  let best = 0, bestEnergy = -1
  if (!Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 8) throw new Error('自動對時支援 1 至 8 聲道來源')
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel), stride = Math.max(1, Math.floor(samples.length / 64000))
    let energy = 0, count = 0
    for (let i = 0; i < samples.length; i += stride) {
      if (!Number.isFinite(samples[i])) throw new Error('音訊包含無效數值')
      energy += samples[i] ** 2; count++
    }
    energy /= Math.max(1, count)
    if (energy > bestEnergy) { best = channel; bestEnergy = energy }
  }
  // Never average stereo channels: opposite-phase vocals can cancel out.
  return best
}

export async function prepareAlignmentWindow(buffer, range, { channel = 0, signal,
  OfflineContext = globalThis.OfflineAudioContext } = {}) {
  checkAbort(signal)
  const rate = buffer.sampleRate
  if (!Number.isFinite(rate) || rate < 8000 || rate > 384000) throw new Error('音訊取樣率不受支援')
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.start < 0 || range.end <= range.start || range.end - range.start > 20.000001) throw new Error('分析片段長度無效')
  const source = buffer.getChannelData(channel)
  const first = Math.max(0, Math.floor(range.start * rate))
  // Anchor-derived decimal seconds can straddle floating-point sample edges.
  // Bound the actual PCM count, then report its measured offset/duration.
  const last = Math.min(source.length, first + Math.floor(20 * rate), Math.ceil(range.end * rate))
  if (last <= first || (last - first) / rate > 20.001) throw new Error('分析片段長度無效')
  const owner = rate === 16000 ? null : {}
  if (owner) {
    if (!OfflineContext) throw new Error('此瀏覽器無法準備分析音訊，仍可手動對時')
    if (nativeResamplingOwner) throw new Error('上一段音訊仍在完成取樣轉換，請稍候再試')
    // Claim before slicing PCM or allocating an AudioBuffer/context. Clearing
    // the service's active request on Cancel must not permit another allocation.
    nativeResamplingOwner = owner
  }
  let sourceNode, nativePromise, abortHandler, nativeSettled = false, finished = false
  const release = () => { if (owner && nativeResamplingOwner === owner) nativeResamplingOwner = null }
  const disconnect = () => {
    const node = sourceNode; sourceNode = null
    try { node?.disconnect() } catch { /* Cleanup must not replace the original outcome. */ }
  }
  try {
    const input = source.slice(first, last)
    if (input.some(value => !Number.isFinite(value))) throw new Error('音訊包含無效數值')
    const offset = first / rate
    let samples
    if (rate === 16000) samples = input
    else {
      const context = new OfflineContext(1, Math.max(1, Math.min(320000, Math.round(input.length * 16000 / rate))), 16000)
      const mono = context.createBuffer(1, input.length, rate)
      mono.copyToChannel(input, 0)
      sourceNode = context.createBufferSource(); sourceNode.buffer = mono
      sourceNode.connect(context.destination); sourceNode.start()
      checkAbort(signal)
      nativePromise = Promise.resolve(context.startRendering()).finally(() => {
        nativeSettled = true
        disconnect()
        if (finished) release()
      })
      const interrupted = new Promise((_, reject) => {
        abortHandler = () => { disconnect(); reject(abortError()) }
        signal?.addEventListener('abort', abortHandler, { once: true })
        if (signal?.aborted) abortHandler()
      })
      // Cancel returns promptly, but ownership stays with the native job. The
      // race also consumes late native rejection after cancellation.
      const rendered = await Promise.race([nativePromise, interrupted])
      checkAbort(signal)
      samples = rendered.getChannelData(0).slice()
    }
    let peak = 0
    for (const value of samples) peak = Math.max(peak, Math.abs(value))
    return { samples, sampleRate: 16000, offset, duration: samples.length / 16000,
      silent: peak === 0 }
  } finally {
    finished = true
    if (abortHandler) signal?.removeEventListener('abort', abortHandler)
    disconnect()
    if (!nativePromise || nativeSettled) release()
  }
}

const normalized = text => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
export function joinWindowWords(groups, duration) {
  const words = [], conflicts = []
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i], previous = groups[i - 1], next = groups[i + 1]
    const left = previous && previous.end > group.start ? (previous.end + group.start) / 2 : group.start
    const right = next && next.start < group.end ? (group.end + next.start) / 2 : group.end
    for (const chunk of group.chunks) {
      const [relativeStart, relativeEnd] = chunk.timestamp ?? []
      if (typeof chunk.text !== 'string' || !Number.isFinite(relativeStart) || !Number.isFinite(relativeEnd) || relativeStart < 0 || relativeEnd <= relativeStart || relativeEnd > group.duration) continue
      const start = group.offset + relativeStart, end = group.offset + relativeEnd, middle = (start + end) / 2
      if (middle < left || middle >= right || end > duration) continue
      words.push({ text: chunk.text, timestamp: [start, end], centerDistance: Math.abs(middle - (group.start + group.end) / 2) })
    }
  }
  words.sort((a, b) => a.timestamp[0] - b.timestamp[0] || a.timestamp[1] - b.timestamp[1])
  const accepted = []
  for (const word of words) {
    const previous = accepted.at(-1)
    if (previous && word.timestamp[0] < previous.timestamp[1]) {
      if (normalized(previous.text) === normalized(word.text)) {
        if (word.centerDistance < previous.centerDistance) accepted[accepted.length - 1] = word
      } else {
        accepted.pop(); conflicts.push({ start: Math.min(previous.timestamp[0], word.timestamp[0]), end: Math.max(previous.timestamp[1], word.timestamp[1]) })
      }
    } else accepted.push(word)
  }
  return { words: accepted.filter(word => !conflicts.some(gap => word.timestamp[0] < gap.end && word.timestamp[1] > gap.start)).map(({ text, timestamp }) => ({ text, timestamp })), conflicts }
}

export function createLocalAlignmentService({ clientFactory, prepareWindow = prepareAlignmentWindow, matcher = matchLyricsToAsr } = {}) {
  let client = null, active = null, clearing = false
  async function getClient(approved) {
    if (!approved) throw new Error('請先確認模型來源與下載說明')
    if (!client) {
      const factory = clientFactory ?? (await import('./whisper-client.js')).createWhisperClient
      client = factory({ modelSourceApproved: true })
    }
    return client
  }
  return {
    info: LOCAL_ALIGNMENT_INFO,
    async run({ buffer, source, lines, revision, targetIds, language, secondPass = false, modelSourceApproved = false, onProgress = () => {}, signal }) {
      if (active || clearing) throw new Error(clearing ? '正在刪除模型，請稍候' : '已有分析進行中，請先取消')
      if (!modelSourceApproved) throw new Error('請先確認模型來源與下載說明')
      if (!LANGUAGES.has(language)) throw new Error('請明確選擇這段的主要演唱語言')
      if (!source || !/^[a-f0-9]{64}$/.test(source.hash) || !buffer || !Number.isFinite(buffer.duration) || !Number.isFinite(source.duration) || Math.abs(buffer.duration - source.duration) > 0.001 || !Number.isSafeInteger(revision) || revision < 0) throw new Error('音訊來源尚未核對完成')
      if (!Array.isArray(lines) || lines.length > 5000 || !Array.isArray(targetIds) || !targetIds.length || targetIds.length > 500) throw new Error('自動對時每次支援最多 500 個目標行，請分批選擇歌詞')
      const snapshot = structuredClone(lines), targets = new Set(targetIds)
      if (targets.size !== targetIds.length || targetIds.some(id => !snapshot.some(line => line.id === id && line.sung && !line.manualLocked && !line.confirmed))) throw new Error('目標包含已保護或無效歌詞行')
      const controller = new AbortController(), abort = () => {
        controller.abort()
        if (active === controller) { active = null; client?.dispose(); client = null }
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) controller.abort()
      active = controller
      const progress = event => { checkAbort(controller.signal); onProgress(event) }
      try {
        checkAbort(controller.signal)
        const windows = planAlignmentWindows(snapshot, targetIds, source.duration, secondPass), channel = chooseAnalysisChannel(buffer), groups = []
        for (let index = 0; index < windows.length; index++) {
          const range = windows[index]
          progress({ phase: 'preparing', message: '準備 16 kHz 分析副本；原音訊不變', chunkIndex: index + 1, chunkCount: windows.length })
          const prepared = await prepareWindow(buffer, range, { channel, signal: controller.signal })
          checkAbort(controller.signal)
          let chunks = []
          if (!prepared.silent) {
            const recognizer = await getClient(modelSourceApproved)
            progress({ phase: 'transcribing', message: secondPass ? '集中處理選取句，可能仍需手動確認' : '從聲音尋找文字時間', chunkIndex: index + 1, chunkCount: windows.length })
            const response = await recognizer.transcribe({ samples: prepared.samples, sampleRate: 16000, language,
              signal: controller.signal, onProgress: event => progress({ ...event, chunkIndex: index + 1, chunkCount: windows.length }) })
            checkAbort(controller.signal)
            if (!response || !Array.isArray(response.chunks)) throw new Error('模型沒有回傳有效逐詞時間')
            chunks = response.chunks
          }
          groups.push({ ...range, ...prepared, samples: undefined, chunks })
        }
        progress({ phase: 'matching', message: '比對原文；未找到的句子保留空白' })
        const joined = joinWindowWords(groups, source.duration)
        const result = matcher(snapshot, joined.words, { duration: source.duration, targetIds,
          protectedIds: snapshot.filter(line => line.manualLocked || line.confirmed).map(line => line.id) })
        checkAbort(controller.signal)
        return { ...result, run: { sourceHash: source.hash, sourceRevision: revision, engine: `${LOCAL_ALIGNMENT_INFO.engine}@${LOCAL_ALIGNMENT_INFO.engineVersion}`, model: LOCAL_ALIGNMENT_INFO.model,
          modelRevision: LOCAL_ALIGNMENT_INFO.revision, language, backend: 'wasm', pass: secondPass ? 2 : 1,
          channel, windows: windows.map(range => ({ ...range })), seamConflicts: joined.conflicts.length } }
      } finally { signal?.removeEventListener('abort', abort); if (active === controller) active = null }
    },
    async clearCache() {
      if (active || clearing) throw new Error('請先取消分析或等待目前刪除完成')
      clearing = true
      try {
        if (!client) {
          const factory = clientFactory ?? (await import('./whisper-client.js')).createWhisperClient
          client = factory({ modelSourceApproved: false })
        }
        return await client.clearCache()
      } finally { client?.dispose(); client = null; clearing = false }
    },
    dispose() { const retiring = active; active = null; retiring?.abort(); client?.dispose(); client = null },
  }
}
