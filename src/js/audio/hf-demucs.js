/**
 * Hugging Face Spaces / Gradio client for Demucs stem separation.
 *
 * Network only: every function here returns raw bytes and never touches the
 * DOM or an AudioContext, so the Gradio-version routing and the SSE protocol
 * are testable without a browser. Decoding to AudioBuffer is the caller's job.
 */

// HF Spaces limits — reject before uploading to avoid wasted minutes
export const HF_MAX_FILE_BYTES = 50 * 1024 * 1024 // 50 MB
export const HF_UPLOAD_TIMEOUT_MS = 60_000 // 1 min for the upload leg
export const HF_PREDICT_TIMEOUT_MS = 600_000 // 10 min for Demucs inference

export const STEM_KEYS = ['vocals', 'drums', 'bass', 'other']

/** Read bodies inside consumeResponse so the deadline covers them, not just headers. */
export async function fetchWithTimeout(url, options, timeoutMs, label, consumeResponse) {
  const ctrl = new AbortController()
  const callerSignal = options.signal
  const abortFromCaller = () => ctrl.abort(callerSignal.reason)
  if (callerSignal?.aborted) abortFromCaller()
  else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  let timedOut = false
  const t = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
  let response
  try {
    if (ctrl.signal.aborted) throw ctrl.signal.reason
    response = await fetch(url, { ...options, signal: ctrl.signal })
    return consumeResponse ? await consumeResponse(response, ctrl.signal) : response
  } catch (err) {
    if (timedOut) throw new Error(`${label} 逾時（${Math.round(timeoutMs / 1000)} 秒），請稍後重試`)
    throw err
  } finally {
    clearTimeout(t)
    callerSignal?.removeEventListener('abort', abortFromCaller)
    // A rejected HTTP response may have an unread body. Do not retain its stream.
    if (consumeResponse && response?.body && !response.bodyUsed && !response.body.locked && typeof response.body.cancel === 'function') {
      response.body.cancel().catch(() => {})
    }
  }
}

/**
 * Read a Gradio SSE result stream to completion.
 * Lines arrive as "event: <type>" / "data: <json>" pairs; resolve on the
 * first complete event, reject on error, ignore generating/heartbeat.
 * @param {ReadableStream} body
 * @returns {Promise<unknown>} the parsed payload of the complete event
 */
export async function readDemucsSSE(body, signal) {
  const reader = body.getReader()
  const cancelReader = () => { reader.cancel(signal?.reason).catch(() => {}) }
  if (signal?.aborted) cancelReader()
  else signal?.addEventListener('abort', cancelReader, { once: true })
  const decoder = new TextDecoder()
  let buf = ''
  let lastEvent = ''
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (signal?.aborted) throw signal.reason
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() // keep incomplete trailing line
      for (const line of lines) {
        if (line.startsWith('event:')) lastEvent = line.slice(6).trim()
        else if (line.startsWith('data:')) {
          const raw = line.slice(5).trim()
          if (lastEvent === 'complete') return JSON.parse(raw)
          if (lastEvent === 'error') {
            throw new Error(`Demucs 分軌失敗：${raw === 'null' ? 'Space 內部錯誤（檔案過長或記憶體不足）' : raw}`)
          }
        }
      }
    }
    throw new Error('Demucs 串流意外結束，未收到完成事件')
  } finally {
    signal?.removeEventListener('abort', cancelReader)
    // complete/error may arrive before the server closes the connection.
    // Cancellation is best-effort: a transport's cancel hook must not extend
    // the request deadline or prevent releasing this reader's lock.
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/**
 * Upload a file to a Gradio Space, probing for the API route prefix.
 * Gradio 5+ moved every API route under /gradio_api/ (verified live:
 * /upload → 404, /gradio_api/upload → 200 on gradio 6.19). Probe the
 * prefixed route first, keep the bare route as a Gradio 4 fallback.
 * @returns {Promise<{apiRoot: string, tmpPath: string}>}
 */
export async function uploadToGradio(file, base, { signal } = {}) {
  const uploadForm = new FormData()
  uploadForm.append('files', file, file.name)
  let apiRoot = `${base}/gradio_api`
  let uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
    method: 'POST',
    body: uploadForm,
    signal,
  }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳', readUploadResponse)

  if (uploadRes.status === 404) {
    apiRoot = base // Gradio 4: no prefix
    const retryForm = new FormData()
    retryForm.append('files', file, file.name)
    uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
      method: 'POST',
      body: retryForm,
      signal,
    }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳', readUploadResponse)
  }

  if (!uploadRes.ok) throw new Error(`HF 上傳失敗（HTTP ${uploadRes.status}）— 請確認 Space 是否在執行中`)
  const uploaded = uploadRes.data
  return { apiRoot, tmpPath: Array.isArray(uploaded) ? uploaded[0] : uploaded }
}

async function readUploadResponse(response) {
  return { ok: response.ok, status: response.status, data: response.ok ? await response.json() : null }
}

/** Fetch a Gradio file URL and return as ArrayBuffer */
export async function fetchGradioFile(baseUrl, filePath, { signal } = {}) {
  return fetchWithTimeout(`${baseUrl}/file=${encodeURIComponent(filePath)}`,
    { signal }, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載', readStemResponse)
}

async function readStemResponse(response) {
  if (!response.ok) throw new Error(`分軌檔下載失敗（HTTP ${response.status}）`)
  return response.arrayBuffer()
}

/**
 * Download each stem the complete event pointed at.
 * Gradio 4 FileData items usually carry a full `url`; fall back to /file={path}.
 * @returns {Promise<Record<string, ArrayBuffer|null>>}
 */
export async function fetchStemFiles(apiRoot, data, { signal } = {}) {
  const result = {}
  for (let i = 0; i < STEM_KEYS.length; i++) {
    const item = data?.[i]
    if (!item) { result[STEM_KEYS[i]] = null; continue }
    if (typeof item === 'object' && item.url) {
      result[STEM_KEYS[i]] = await fetchWithTimeout(item.url, { signal }, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載', readStemResponse)
    } else {
      result[STEM_KEYS[i]] = await fetchGradioFile(apiRoot, item.path ?? item.name ?? item, { signal })
    }
  }
  return result
}

/**
 * Run a full Demucs job: upload → submit → await SSE → download stems.
 * @param {File} file
 * @param {string} endpoint  the Space base URL
 * @returns {Promise<Record<string, ArrayBuffer|null>>} raw encoded audio per stem
 */
export async function runDemucsJob(file, endpoint, { signal } = {}) {
  if (file.size > HF_MAX_FILE_BYTES) {
    throw new Error(`檔案 ${(file.size / 1024 / 1024).toFixed(1)}MB 超過分軌上限 50MB，請先裁剪或壓縮`)
  }

  const base = endpoint.replace(/\/$/, '')
  const { apiRoot, tmpPath } = await uploadToGradio(file, base, { signal })

  // POST /call/separate returns an event_id, then GET /call/separate/{event_id}
  // streams the result as SSE. (api_name="separate" is declared in
  // hf-space/app.py; never rely on fn_index.)
  const payload = { data: [{ path: tmpPath, meta: { _type: 'gradio.FileData' } }] }
  const { event_id: eventId } = await fetchWithTimeout(`${apiRoot}/call/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }, HF_UPLOAD_TIMEOUT_MS, 'Demucs 任務送出', response => {
    if (!response.ok) throw new Error(`Demucs 任務送出失敗（HTTP ${response.status}）— Space 可能休眠或未部署 separate API`)
    return response.json()
  })
  if (!eventId) throw new Error('HF Space 未回傳 event_id，請確認 Gradio 版本 ≥ 4')

  const data = await fetchWithTimeout(`${apiRoot}/call/separate/${eventId}`,
    { signal }, HF_PREDICT_TIMEOUT_MS, 'Demucs 分軌', (response, requestSignal) => {
      if (!response.ok) throw new Error(`Demucs 結果讀取失敗（HTTP ${response.status}）`)
      return readDemucsSSE(response.body, requestSignal)
    })

  // A response with no stem data = failure; never fabricate stems
  if (!Array.isArray(data) || data.every(d => !d)) {
    throw new Error('HF Space 未回傳任何分軌資料，請確認 Space 的 separate API 輸出格式')
  }

  return fetchStemFiles(apiRoot, data, { signal })
}
