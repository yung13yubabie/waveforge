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

export function fetchWithTimeout(url, options, timeoutMs, label) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch(err => {
      if (err.name === 'AbortError') throw new Error(`${label} 逾時（${Math.round(timeoutMs / 1000)} 秒），請稍後重試`)
      throw err
    })
    .finally(() => clearTimeout(t))
}

/**
 * Read a Gradio SSE result stream to completion.
 * Lines arrive as "event: <type>" / "data: <json>" pairs; resolve on the
 * first complete event, reject on error, ignore generating/heartbeat.
 * @param {ReadableStream} body
 * @returns {Promise<unknown>} the parsed payload of the complete event
 */
export async function readDemucsSSE(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let lastEvent = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
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
export async function uploadToGradio(file, base) {
  const uploadForm = new FormData()
  uploadForm.append('files', file, file.name)
  let apiRoot = `${base}/gradio_api`
  let uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
    method: 'POST',
    body: uploadForm,
  }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳')

  if (uploadRes.status === 404) {
    apiRoot = base // Gradio 4: no prefix
    const retryForm = new FormData()
    retryForm.append('files', file, file.name)
    uploadRes = await fetchWithTimeout(`${apiRoot}/upload`, {
      method: 'POST',
      body: retryForm,
    }, HF_UPLOAD_TIMEOUT_MS, 'HF 上傳')
  }

  if (!uploadRes.ok) throw new Error(`HF 上傳失敗（HTTP ${uploadRes.status}）— 請確認 Space 是否在執行中`)
  const uploaded = await uploadRes.json()
  return { apiRoot, tmpPath: Array.isArray(uploaded) ? uploaded[0] : uploaded }
}

/** Fetch a Gradio file URL and return as ArrayBuffer */
export async function fetchGradioFile(baseUrl, filePath) {
  const res = await fetchWithTimeout(`${baseUrl}/file=${encodeURIComponent(filePath)}`,
    {}, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載')
  if (!res.ok) throw new Error(`分軌檔下載失敗（HTTP ${res.status}）`)
  return res.arrayBuffer()
}

/**
 * Download each stem the complete event pointed at.
 * Gradio 4 FileData items usually carry a full `url`; fall back to /file={path}.
 * @returns {Promise<Record<string, ArrayBuffer|null>>}
 */
export async function fetchStemFiles(apiRoot, data) {
  const result = {}
  for (let i = 0; i < STEM_KEYS.length; i++) {
    const item = data?.[i]
    if (!item) { result[STEM_KEYS[i]] = null; continue }
    if (typeof item === 'object' && item.url) {
      const res = await fetchWithTimeout(item.url, {}, HF_UPLOAD_TIMEOUT_MS, '分軌檔下載')
      if (!res.ok) throw new Error(`分軌檔下載失敗（HTTP ${res.status}）`)
      result[STEM_KEYS[i]] = await res.arrayBuffer()
    } else {
      result[STEM_KEYS[i]] = await fetchGradioFile(apiRoot, item.path ?? item.name ?? item)
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
export async function runDemucsJob(file, endpoint) {
  if (file.size > HF_MAX_FILE_BYTES) {
    throw new Error(`檔案 ${(file.size / 1024 / 1024).toFixed(1)}MB 超過分軌上限 50MB，請先裁剪或壓縮`)
  }

  const base = endpoint.replace(/\/$/, '')
  const { apiRoot, tmpPath } = await uploadToGradio(file, base)

  // POST /call/separate returns an event_id, then GET /call/separate/{event_id}
  // streams the result as SSE. (api_name="separate" is declared in
  // hf-space/app.py; never rely on fn_index.)
  const payload = { data: [{ path: tmpPath, meta: { _type: 'gradio.FileData' } }] }
  const submitRes = await fetchWithTimeout(`${apiRoot}/call/separate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, HF_UPLOAD_TIMEOUT_MS, 'Demucs 任務送出')
  if (!submitRes.ok) throw new Error(`Demucs 任務送出失敗（HTTP ${submitRes.status}）— Space 可能休眠或未部署 separate API`)

  const { event_id: eventId } = await submitRes.json()
  if (!eventId) throw new Error('HF Space 未回傳 event_id，請確認 Gradio 版本 ≥ 4')

  const sseRes = await fetchWithTimeout(`${apiRoot}/call/separate/${eventId}`,
    {}, HF_PREDICT_TIMEOUT_MS, 'Demucs 分軌')
  if (!sseRes.ok) throw new Error(`Demucs 結果讀取失敗（HTTP ${sseRes.status}）`)

  const data = await readDemucsSSE(sseRes.body)

  // A response with no stem data = failure; never fabricate stems
  if (!Array.isArray(data) || data.every(d => !d)) {
    throw new Error('HF Space 未回傳任何分軌資料，請確認 Space 的 separate API 輸出格式')
  }

  return fetchStemFiles(apiRoot, data)
}
