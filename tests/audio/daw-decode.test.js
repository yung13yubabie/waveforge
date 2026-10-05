// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDawDecoder, decodeDawAsset } from '../../src/js/daw/decode.js'
import { createProject } from '../../src/js/daw/project.js'
import { decodeArchiveAsset, exportProjectArchive, importProjectArchive } from '../../src/js/daw/archive.js'

const tick = async () => { for (let count = 0; count < 8; count++) await Promise.resolve() }
const bytes = () => new Uint8Array([1, 2, 3]).buffer
const audioBuffer = () => ({ getChannelData: () => new Float32Array(4800), sampleRate: 48000, length: 4800, duration: .1, numberOfChannels: 1 })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
class Context {
  constructor(channels, length, sampleRate) { this.channels = channels; this.length = length; this.sampleRate = sampleRate }
}
function wavHeader(sampleRate) {
  const data = new Uint8Array(44), view = new DataView(data.buffer), encoder = new TextEncoder()
  data.set(encoder.encode('RIFF')); view.setUint32(4, 36, true); data.set(encoder.encode('WAVEfmt '), 8)
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  data.set(encoder.encode('data'), 36)
  return data.buffer
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('single-flight DAW native decoding', () => {
  it('rejects overlapping calls without queuing, copying, or starting another native decoder', async () => {
    const pending = deferred(), source = vi.fn(() => pending.promise)
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    const first = decode(bytes())
    const unreadable = { get byteLength() { throw new Error('must not inspect queued bytes') } }
    await expect(decode(unreadable)).rejects.toThrow(/上一個音檔仍在背景解碼/)
    expect(source).toHaveBeenCalledTimes(1)
    const output = audioBuffer(); pending.resolve({ buffer: output })
    expect(await first).toBe(output)
  })

  it('immediately rejects cancellation while holding its slot until the real native promise settles', async () => {
    const pending = deferred(), output = audioBuffer(), source = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ buffer: output })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    const controller = new AbortController()
    let delivered = false
    const first = decode(bytes(), {}, { signal: controller.signal }).then(() => { delivered = true }, error => error)
    controller.abort()
    expect((await first).name).toBe('AbortError')
    for (let count = 0; count < 5; count++) await expect(decode(bytes())).rejects.toThrow(/背景解碼/)
    expect(source).toHaveBeenCalledTimes(1)
    expect(delivered).toBe(false)
    pending.resolve({ buffer: output }); await tick()
    expect(delivered).toBe(false)
    expect(await decode(bytes())).toBe(output)
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('defaults to a 30-second caller deadline without unlocking the native slot', async () => {
    vi.useFakeTimers()
    const pending = deferred(), source = vi.fn(() => pending.promise)
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    let result
    const first = decode(bytes()).catch(error => { result = error })
    await vi.advanceTimersByTimeAsync(29999)
    expect(result).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await first
    expect(result.name).toBe('TimeoutError')
    expect(result.message).toContain('請先儲存工程再重新整理頁面')
    expect(vi.getTimerCount()).toBe(0)
    for (let count = 0; count < 5; count++) await expect(decode(bytes())).rejects.toThrow(/背景解碼/)
    expect(source).toHaveBeenCalledTimes(1)
    pending.resolve({ buffer: audioBuffer() }); await tick()
    source.mockResolvedValue({ buffer: audioBuffer() })
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it('consumes a native rejection arriving after timeout and permits a later retry', async () => {
    vi.useFakeTimers()
    const pending = deferred(), source = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ buffer: audioBuffer() })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, timeoutMs: 5, decodeSource: source })
    const first = decode(bytes()).catch(error => error)
    await vi.advanceTimersByTimeAsync(5)
    expect((await first).name).toBe('TimeoutError')
    pending.reject(new Error('late native codec rejection')); await tick()
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it('consumes a native rejection arriving after cancellation and permits a later retry', async () => {
    const pending = deferred(), source = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue({ buffer: audioBuffer() })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    const controller = new AbortController()
    const first = decode(bytes(), {}, { signal: controller.signal }).catch(error => error)
    controller.abort(); expect((await first).name).toBe('AbortError')
    pending.reject(new Error('late native failure')); await tick()
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it('does not start decoding an already-aborted request', async () => {
    vi.useFakeTimers()
    const source = vi.fn(), decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    const controller = new AbortController(); controller.abort()
    await expect(decode(bytes(), {}, { signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(source).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the slot after a synchronous decoder or constructor error', async () => {
    const source = vi.fn().mockImplementationOnce(() => { throw new Error('sync decoder failure') }).mockResolvedValue({ buffer: audioBuffer() })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    await expect(decode(bytes())).rejects.toThrow('sync decoder failure')
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
    let fail = true
    class FailingContext extends Context { constructor(...args) { super(...args); if (fail) { fail = false; throw new Error('context unavailable') } } }
    const another = createDawDecoder({ OfflineAudioContextClass: FailingContext, decodeSource: source })
    await expect(another(bytes())).rejects.toThrow('context unavailable')
    await expect(another(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it.each([new Error('native failure'), null, undefined, false])('rejects native errors, including falsy rejection values, and releases the slot', async error => {
    const source = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ buffer: audioBuffer() })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    let rejected = false
    await decode(bytes()).catch(() => { rejected = true })
    expect(rejected).toBe(true)
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it('cleans timers/listeners after success, failure and cancellation', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'), remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = deferred()
    const source = vi.fn().mockResolvedValueOnce({ buffer: audioBuffer() }).mockRejectedValueOnce(new Error('codec')).mockReturnValueOnce(pending.promise)
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    await decode(bytes(), {}, { signal: controller.signal })
    await expect(decode(bytes(), {}, { signal: controller.signal })).rejects.toThrow('codec')
    const cancelled = decode(bytes(), {}, { signal: controller.signal }).catch(error => error)
    controller.abort(); await cancelled
    expect(add).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve({ buffer: audioBuffer() }); await tick()
  })

  it('protects caller bytes against native buffer detachment', async () => {
    const input = bytes()
    const source = vi.fn(async copied => {
      expect(copied).not.toBe(input)
      expect([...new Uint8Array(copied)]).toEqual([1, 2, 3])
      structuredClone(copied, { transfer: [copied] })
      expect(copied.byteLength).toBe(0)
      return { buffer: audioBuffer() }
    })
    await createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })(input)
    expect([...new Uint8Array(input)]).toEqual([1, 2, 3])
  })

  it('copies only the visible byte range of typed views', async () => {
    const input = new Uint8Array([99, 99, 1, 2, 3, 88])
    const source = vi.fn(async copied => { expect([...new Uint8Array(copied)]).toEqual([1, 2, 3]); return audioBuffer() })
    await createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })(new DataView(input.buffer, 2, 3))
    expect(input).toEqual(new Uint8Array([99, 99, 1, 2, 3, 88]))
  })

  it('uses the recorded compressed-asset rate, defaults to 48000, and preserves native WAV rate', async () => {
    const contexts = [], source = vi.fn(async (_bytes, context) => { contexts.push([context.channels, context.length, context.sampleRate]); return { buffer: audioBuffer() } })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    await decode(bytes())
    await decode(bytes(), { sampleRate: 44100, channels: 1 })
    await decode(wavHeader(22050), { sampleRate: 48000, channels: 1 })
    expect(contexts).toEqual([[2, 1, 48000], [1, 1, 44100], [1, 1, 22050]])
  })

  it('rejects unsupported inputs/settings without holding a slot', async () => {
    const source = vi.fn(async () => ({ buffer: audioBuffer() })), decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    await expect(decode('not bytes')).rejects.toThrow(/ArrayBuffer/)
    await expect(decode(new ArrayBuffer(0))).rejects.toThrow(/64 MiB/)
    await expect(decode(bytes(), { sampleRate: 1 })).rejects.toThrow(/取樣率/)
    await expect(decode(bytes(), { channels: 3 })).rejects.toThrow(/聲道/)
    expect(source).not.toHaveBeenCalled()
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
    expect(() => createDawDecoder({ timeoutMs: 0 })).toThrow()
    expect(() => createDawDecoder({ timeoutMs: Infinity })).toThrow()
    expect(() => createDawDecoder({ decodeSource: null })).toThrow()
  })

  it('fails clearly if the browser has no native offline decoder', async () => {
    vi.stubGlobal('OfflineAudioContext', undefined)
    await expect(createDawDecoder()(bytes())).rejects.toThrow(/瀏覽器無法/)
  })

  it('rejects malformed decoder results instead of leaving the caller waiting', async () => {
    const source = vi.fn().mockResolvedValueOnce({ wrong: true }).mockResolvedValueOnce({ get buffer() { throw new Error('broken native wrapper') } }).mockResolvedValue({ buffer: audioBuffer() })
    const decode = createDawDecoder({ OfflineAudioContextClass: Context, decodeSource: source })
    await expect(decode(bytes())).rejects.toThrow(/未產生有效音訊/)
    await expect(decode(bytes())).rejects.toThrow('broken native wrapper')
    await expect(decode(bytes())).resolves.toHaveProperty('sampleRate', 48000)
  })

  it('archive and ordinary imports use the same native gate and archive cancellation returns promptly', async () => {
    const entered = deferred(), pending = deferred(), output = audioBuffer()
    const nativeDecode = vi.fn().mockImplementationOnce(() => { entered.resolve(); return pending.promise }).mockResolvedValue(output)
    vi.stubGlobal('OfflineAudioContext', class extends Context { decodeAudioData(data) { return nativeDecode(data) } })
    const project = createProject({ assets: [{ id: 'a', name: 'source.bin', hash: '', duration: .1, sampleRate: 48000, channels: 1, length: 4800 }] })
    const zip = await exportProjectArchive(project, new Map([['a', new Blob([bytes()])]]))
    const controller = new AbortController()
    const operation = importProjectArchive(zip, { signal: controller.signal }).catch(error => error)
    await entered.promise
    controller.abort()
    expect((await operation).name).toBe('AbortError')
    await expect(decodeDawAsset(bytes())).rejects.toThrow(/背景解碼/)
    await expect(decodeArchiveAsset(bytes(), project.assets[0])).rejects.toThrow(/背景解碼/)
    expect(nativeDecode).toHaveBeenCalledTimes(1)
    pending.resolve(output); await tick()
    expect(await decodeDawAsset(bytes())).toBe(output)
    const restored = await importProjectArchive(zip)
    expect(restored.project.assets[0].id).toBe('a')
    expect(restored.buffers.get('a')).toBe(output)
  })
})
