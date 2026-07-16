import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchWithTimeout,
  readDemucsSSE,
  uploadToGradio,
  fetchGradioFile,
  fetchStemFiles,
  runDemucsJob,
  HF_MAX_FILE_BYTES,
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

afterEach(() => vi.unstubAllGlobals())

describe('fetchWithTimeout', () => {
  it('passes the response through when the request completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res('ok')))
    await expect(fetchWithTimeout('https://x/y', {}, 1000, '測試')).resolves.toMatchObject({ ok: true })
  })

  it('translates an abort into a labelled timeout message', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr))

    await expect(fetchWithTimeout('https://x/y', {}, 5000, 'HF 上傳'))
      .rejects.toThrow('HF 上傳 逾時（5 秒），請稍後重試')
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
