import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchWithTimeout,
  readDemucsSSE,
  uploadToGradio,
  fetchGradioFile,
  fetchStemFiles,
  runDemucsJob,
  HF_MAX_FILE_BYTES,
  HF_UPLOAD_TIMEOUT_MS,
  HF_PREDICT_TIMEOUT_MS,
} from '../../src/js/audio/hf-demucs.js'

const ENDPOINT = 'https://space.hf.example'

/** Build a ReadableStream that emits the given text chunks then closes. */
function streamOf(...chunks) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    },
  })
}

const res = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  arrayBuffer: async () => body,
  body,
})

function smallFile(name = 'song.wav') {
  const f = new File([new Uint8Array(16)], name, { type: 'audio/wav' })
  return f
}

/** A file that reports a size without allocating it. */
function fileOfSize(bytes) {
  return Object.defineProperty(smallFile(), 'size', { value: bytes })
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('fetchWithTimeout', () => {
  it('passes the response through when the request completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res('ok')))
    await expect(fetchWithTimeout('https://x/y', {}, 1000, '測試')).resolves.toMatchObject({ ok: true })
  })

  it('aborts a stalled request with a labelled timeout message', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })))
    const result = expect(fetchWithTimeout('https://x/y', {}, 5000, 'HF 上傳'))
      .rejects.toThrow('HF 上傳 逾時（5 秒），請稍後重試')
    await vi.advanceTimersByTimeAsync(5000)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the deadline active after headers until the body consumer settles', async () => {
    vi.useFakeTimers()
    let requestSignal
    vi.stubGlobal('fetch', vi.fn(async (_url, { signal }) => {
      requestSignal = signal
      return res('headers arrived')
    }))
    const readBody = (_response, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const result = expect(fetchWithTimeout('https://x/y', {}, 1000, '測試', readBody))
      .rejects.toThrow('測試 逾時（1 秒），請稍後重試')
    await vi.advanceTimersByTimeAsync(999)
    expect(requestSignal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await result
    expect(requestSignal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves caller cancellation and removes its listener', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })))
    const result = expect(fetchWithTimeout('https://x/y', { signal: caller.signal }, 1000, '測試'))
      .rejects.toMatchObject({ name: 'AbortError' })
    caller.abort()
    await result
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start a request if its caller already cancelled it', async () => {
    const caller = new AbortController()
    caller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchWithTimeout('https://x/y', { signal: caller.signal }, 1000, '測試'))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels an unread error response and clears its timer', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(body, { ok: false, status: 502 })))
    await expect(fetchWithTimeout('https://x/y', {}, 1000, '測試', () => { throw new Error('HTTP 502') }))
      .rejects.toThrow('HTTP 502')
    expect(cancel).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not wait indefinitely for an unread response cancellation hook', async () => {
    vi.useFakeTimers()
    const body = new ReadableStream({ cancel: () => new Promise(() => {}) })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(body, { ok: false, status: 502 })))
    await expect(fetchWithTimeout('https://x/y', {}, 1000, '測試', () => { throw new Error('HTTP 502') }))
      .rejects.toThrow('HTTP 502')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rethrows a non-abort network error unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(fetchWithTimeout('https://x/y', {}, 1000, '測試')).rejects.toThrow('ECONNREFUSED')
  })
})

describe('readDemucsSSE', () => {
  it('resolves with the payload of the complete event', async () => {
    const stream = streamOf('event: complete\ndata: [{"path":"/tmp/vocals.wav"}]\n')
    await expect(readDemucsSSE(stream)).resolves.toEqual([{ path: '/tmp/vocals.wav' }])
  })

  it('ignores generating and heartbeat events while waiting', async () => {
    const stream = streamOf(
      'event: generating\ndata: null\n',
      'event: heartbeat\ndata: null\n',
      'event: complete\ndata: [1,2]\n',
    )
    await expect(readDemucsSSE(stream)).resolves.toEqual([1, 2])
  })

  it('reassembles an event split across chunk boundaries', async () => {
    const stream = streamOf('event: comp', 'lete\ndata: [{"a"', ':1}]\n')
    await expect(readDemucsSSE(stream)).resolves.toEqual([{ a: 1 }])
  })

  it('surfaces the payload of an error event', async () => {
    const stream = streamOf('event: error\ndata: "CUDA out of memory"\n')
    await expect(readDemucsSSE(stream)).rejects.toThrow(/CUDA out of memory/)
  })

  it('explains a null error payload instead of printing "null"', async () => {
    const stream = streamOf('event: error\ndata: null\n')
    await expect(readDemucsSSE(stream)).rejects.toThrow(/Space 內部錯誤/)
  })

  it('rejects when the stream ends before a complete event', async () => {
    const stream = streamOf('event: generating\ndata: null\n')
    await expect(readDemucsSSE(stream)).rejects.toThrow('Demucs 串流意外結束，未收到完成事件')
  })

  it('cancels and unlocks the stream after complete even if the server keeps it open', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: complete\ndata: [1]\n')) },
      cancel,
    })
    await expect(readDemucsSSE(body)).resolves.toEqual([1])
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('releases a completed stream without waiting for its cancellation hook', async () => {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: complete\ndata: [1]\n')) },
      cancel: () => new Promise(() => {}),
    })
    await expect(readDemucsSSE(body)).resolves.toEqual([1])
    expect(body.locked).toBe(false)
  })

  it.each(['event: error\ndata: "failed"\n', 'event: complete\ndata: {invalid}\n'])(
    'cancels and unlocks an open stream on parsing or server error: %s', async chunk => {
      const cancel = vi.fn()
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(chunk)) },
        cancel,
      })
      await expect(readDemucsSSE(body)).rejects.toThrow()
      expect(cancel).toHaveBeenCalledOnce()
      expect(body.locked).toBe(false)
    })

  it('cancels a stalled reader and releases the lock when aborted', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const caller = new AbortController()
    const remove = vi.spyOn(caller.signal, 'removeEventListener')
    const result = expect(readDemucsSSE(body, caller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    caller.abort()
    await result
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
})

describe('uploadToGradio', () => {
  it('uses the Gradio 5 /gradio_api prefix when it responds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(['/tmp/in.wav']))
    vi.stubGlobal('fetch', fetchMock)

    const out = await uploadToGradio(smallFile(), ENDPOINT)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/gradio_api/upload`)
    expect(out).toEqual({ apiRoot: `${ENDPOINT}/gradio_api`, tmpPath: '/tmp/in.wav' })
  })

  it('falls back to the bare /upload route when the prefixed one 404s', async () => {
    // This is the Gradio 4 shape; a 404 here previously surfaced to the user
    // as "HF 上傳失敗（HTTP 404）" with no retry.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(null, { ok: false, status: 404 }))
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
    vi.stubGlobal('fetch', fetchMock)

    const out = await uploadToGradio(smallFile(), ENDPOINT)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(`${ENDPOINT}/upload`)
    expect(out.apiRoot).toBe(ENDPOINT)
  })

  it('reports the status when both upload routes fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(null, { ok: false, status: 503 })))
    await expect(uploadToGradio(smallFile(), ENDPOINT)).rejects.toThrow(/HTTP 503/)
  })

  it('accepts a bare string path as well as an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res('/tmp/solo.wav')))
    const out = await uploadToGradio(smallFile(), ENDPOINT)
    expect(out.tmpPath).toBe('/tmp/solo.wav')
  })
})

describe('fetchGradioFile', () => {
  it('requests the /file= route with the path encoded', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(new ArrayBuffer(8)))
    vi.stubGlobal('fetch', fetchMock)

    await fetchGradioFile(ENDPOINT, '/tmp/a b.wav')

    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/file=${encodeURIComponent('/tmp/a b.wav')}`)
  })

  it('throws with the status when the stem file is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(null, { ok: false, status: 404 })))
    await expect(fetchGradioFile(ENDPOINT, '/tmp/gone.wav')).rejects.toThrow(/HTTP 404/)
  })
})

describe('fetchStemFiles', () => {
  it('prefers an absolute url when the item carries one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(new ArrayBuffer(4)))
    vi.stubGlobal('fetch', fetchMock)

    await fetchStemFiles(ENDPOINT, [
      { url: 'https://cdn.example/vocals.wav' }, null, null, null,
    ])

    expect(fetchMock.mock.calls[0][0]).toBe('https://cdn.example/vocals.wav')
  })

  it('falls back to the /file= route when the item only has a path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(new ArrayBuffer(4)))
    vi.stubGlobal('fetch', fetchMock)

    await fetchStemFiles(ENDPOINT, [{ path: '/tmp/v.wav' }, null, null, null])

    expect(fetchMock.mock.calls[0][0]).toContain('/file=')
  })

  it('maps missing stems to null rather than dropping the key', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(new ArrayBuffer(4))))

    const out = await fetchStemFiles(ENDPOINT, [{ url: 'https://cdn/v.wav' }, null, null, null])

    expect(Object.keys(out)).toEqual(['vocals', 'drums', 'bass', 'other'])
    expect(out.drums).toBeNull()
    expect(out.vocals).toBeInstanceOf(ArrayBuffer)
  })
})

describe('runDemucsJob', () => {
  const sse = () => res(streamOf('event: complete\ndata: [{"url":"https://cdn/v.wav"},null,null,null]\n'))

  function happyPath() {
    return vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))        // upload
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))  // submit
      .mockResolvedValueOnce(sse())                       // SSE
      .mockResolvedValue(res(new ArrayBuffer(4)))         // stem download
  }

  beforeEach(() => vi.stubGlobal('fetch', happyPath()))

  it('times out a stalled SSE body after immediate headers and releases its reader', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: null\n')) },
      cancel,
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))
      .mockResolvedValueOnce(res(body))
    vi.stubGlobal('fetch', fetchMock)
    const result = expect(runDemucsJob(smallFile(), ENDPOINT))
      .rejects.toThrow('Demucs 分軌 逾時（600 秒），請稍後重試')
    await vi.advanceTimersByTimeAsync(HF_PREDICT_TIMEOUT_MS)
    await result
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates caller cancellation through SSE without downloading stems', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const cancel = vi.fn()
    const body = new ReadableStream({ cancel })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))
      .mockResolvedValueOnce(res(body))
    vi.stubGlobal('fetch', fetchMock)
    const result = expect(runDemucsJob(smallFile(), ENDPOINT, { signal: caller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    caller.abort()
    await result
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an oversized file before uploading anything', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(runDemucsJob(fileOfSize(HF_MAX_FILE_BYTES + 1), ENDPOINT))
      .rejects.toThrow(/超過分軌上限 50MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns raw encoded bytes per stem on the happy path', async () => {
    const out = await runDemucsJob(smallFile(), ENDPOINT)

    expect(Object.keys(out)).toEqual(['vocals', 'drums', 'bass', 'other'])
    expect(out.vocals).toBeInstanceOf(ArrayBuffer)
  })

  it('strips a trailing slash from the endpoint', async () => {
    const fetchMock = happyPath()
    vi.stubGlobal('fetch', fetchMock)

    await runDemucsJob(smallFile(), `${ENDPOINT}/`)

    expect(fetchMock.mock.calls[0][0]).toBe(`${ENDPOINT}/gradio_api/upload`)
  })

  it('posts the uploaded path to the named separate API', async () => {
    const fetchMock = happyPath()
    vi.stubGlobal('fetch', fetchMock)

    await runDemucsJob(smallFile(), ENDPOINT)

    const [url, opts] = fetchMock.mock.calls[1]
    expect(url).toBe(`${ENDPOINT}/gradio_api/call/separate`)
    expect(JSON.parse(opts.body)).toEqual({
      data: [{ path: '/tmp/in.wav', meta: { _type: 'gradio.FileData' } }],
    })
  })

  it('explains a sleeping Space when the submit call fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res(null, { ok: false, status: 500 })))

    await expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow(/Space 可能休眠/)
  })

  it('rejects when the Space returns no event_id', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({})))

    await expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow(/未回傳 event_id/)
  })

  it('rejects when the result stream cannot be opened', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))
      .mockResolvedValueOnce(res(null, { ok: false, status: 502 })))

    await expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow(/HTTP 502/)
  })

  it('refuses to fabricate stems when every slot is empty', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))
      .mockResolvedValueOnce(res(streamOf('event: complete\ndata: [null,null,null,null]\n'))))

    await expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow(/未回傳任何分軌資料/)
  })

  it('refuses a non-array complete payload', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockResolvedValueOnce(res({ event_id: 'evt-1' }))
      .mockResolvedValueOnce(res(streamOf('event: complete\ndata: {"oops":true}\n'))))

    await expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow(/未回傳任何分軌資料/)
  })
})

describe('response body deadlines', () => {
  // No real songs or endpoints: mimic fetch aborting a pending body read.
  const stalledResponse = (method, signal) => ({
    ok: true,
    status: 200,
    [method]: () => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })

  it('bounds upload response JSON after its headers arrive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url, { signal }) => stalledResponse('json', signal)))
    const result = expect(uploadToGradio(smallFile(), ENDPOINT)).rejects.toThrow('HF 上傳 逾時（60 秒）')
    await vi.advanceTimersByTimeAsync(HF_UPLOAD_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds submission response JSON after its headers arrive', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(res(['/tmp/in.wav']))
      .mockImplementationOnce(async (_url, { signal }) => stalledResponse('json', signal)))
    const result = expect(runDemucsJob(smallFile(), ENDPOINT)).rejects.toThrow('Demucs 任務送出 逾時（60 秒）')
    await vi.advanceTimersByTimeAsync(HF_UPLOAD_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['path', 'url'])('bounds a stem %s download body after its headers arrive', async route => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url, { signal }) => stalledResponse('arrayBuffer', signal)))
    const request = route === 'path' ? fetchGradioFile(ENDPOINT, '/tmp/vocals.wav')
      : fetchStemFiles(ENDPOINT, [{ url: 'https://cdn.example/vocals.wav' }])
    const result = expect(request).rejects.toThrow('分軌檔下載 逾時（60 秒）')
    await vi.advanceTimersByTimeAsync(HF_UPLOAD_TIMEOUT_MS)
    await result
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops downloading later stems when the caller aborts a pending body', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const fetchMock = vi.fn(async (_url, { signal }) => stalledResponse('arrayBuffer', signal))
    vi.stubGlobal('fetch', fetchMock)
    const result = expect(fetchStemFiles(ENDPOINT, [
      { url: 'https://cdn.example/vocals.wav' }, { url: 'https://cdn.example/drums.wav' },
    ], { signal: caller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    await result
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
