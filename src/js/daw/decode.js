// Web Audio decoding cannot be stopped once the browser starts it. Keep one
// native slot occupied until its actual promise settles, even after the caller
// cancels/times out. Never queue source buffers behind a stuck decoder.
import { decodeSourceAsset, wavSampleRate } from '../audio/asset-decode.js'

const MAX_SOURCE_BYTES = 64 * 1024 * 1024
const abortError = () => new DOMException('已取消讀取音訊；原專案仍保留', 'AbortError')
const busyError = () => new Error('上一個音檔仍在背景解碼，請等候完成後再試；原專案仍保留')
function timeoutError() {
  const error = new Error('音檔解碼逾時；背景解碼尚未結束，請稍候再試。若持續無法讀取，請先儲存工程再重新整理頁面')
  error.name = 'TimeoutError'
  return error
}

function copyBytes(bytes) {
  const isBuffer = bytes instanceof ArrayBuffer
  const isView = ArrayBuffer.isView(bytes) && bytes.buffer instanceof ArrayBuffer
  if (!isBuffer && !isView) throw new Error('音檔資料必須是 ArrayBuffer 或其檢視')
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('單一原始音檔必須介於 1 byte 與 64 MiB')
  // decodeAudioData may detach its argument. A view must copy only its visible
  // byte range, never unrelated bytes from the parent ArrayBuffer.
  return isBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

export function createDawDecoder({ OfflineAudioContextClass, timeoutMs = 30000, decodeSource = decodeSourceAsset } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('解碼期限必須介於 1 至 120000 毫秒')
  if (typeof decodeSource !== 'function') throw new Error('音檔解碼器無法使用')
  let nativeBusy = false
  let nativeSettlement = null

  const decode = async function decode(bytes, metadata = {}, { signal } = {}) {
    if (signal?.aborted) throw abortError()
    if (nativeBusy) throw busyError()
    const requestedRate = metadata.sampleRate ?? 48000
    if (!Number.isInteger(requestedRate) || requestedRate < 8000 || requestedRate > 192000) throw new Error('素材取樣率超出支援範圍')
    const channels = metadata.channels ?? 2
    if (channels !== 1 && channels !== 2) throw new Error('只支援單聲道或立體聲音檔')
    const Context = OfflineAudioContextClass ?? globalThis.OfflineAudioContext
    if (typeof Context !== 'function') throw new Error('此瀏覽器無法使用離線音檔解碼')
    const sourceBytes = copyBytes(bytes)
    // Match the existing original-file decoder: native WAV rates are retained;
    // other formats use the saved decoding rate (or 48000 for first import).
    const rate = wavSampleRate(sourceBytes) ?? requestedRate
    if (signal?.aborted) throw abortError()

    let native
    nativeBusy = true
    try {
      const context = new Context(channels, 1, rate)
      native = Promise.resolve(decodeSource(sourceBytes, context))
    } catch (error) {
      nativeBusy = false
      throw error
    }
    // Both handlers fulfill their derived promise, avoiding unhandled late
    // rejections after a timeout/abort. This is the ONLY asynchronous unlock.
    const settled = () => { nativeBusy = false; nativeSettlement = null }
    nativeSettlement = native.then(settled, settled)

    return new Promise((resolve, reject) => {
      let finished = false
      let timer
      const finish = (error, buffer) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error !== null) reject(error)
        else resolve(buffer)
      }
      const abort = () => finish(abortError())
      signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => finish(timeoutError()), timeoutMs)
      native.then(result => {
        if (finished) return // A stale result must never escape cancellation.
        try {
          if (signal?.aborted) { finish(abortError()); return }
          const buffer = result?.buffer?.getChannelData ? result.buffer : result
          if (!buffer || typeof buffer.getChannelData !== 'function') {
            finish(new Error('音檔解碼未產生有效音訊；原專案仍保留'))
            return
          }
          finish(null, buffer)
        } catch (error) { finish(error ?? new Error('音檔解碼失敗；原專案仍保留')) }
      }, error => finish(error ?? new Error('音檔解碼失敗；原專案仍保留')))
      if (signal?.aborted) abort()
    })
  }
  // A cancelled caller settles before the browser decoder. Resource owners use
  // this non-rejecting snapshot to retain reservations until native work ends.
  decode.whenIdle = () => nativeSettlement ?? Promise.resolve()
  return decode
}

// Shared by initial import and archive restore, including separate panels.
// Creation performs no browser calls; resolve the current browser class lazily.
export const decodeDawAsset = createDawDecoder()
