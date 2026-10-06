/** Quiet original-buffer audition, isolated from mastering DSP and model jobs. */
const aborted = () => new DOMException('已停止原音試聽', 'AbortError')
export function createPitchSourcePreview({ AudioContextClass, gain = 0.2, onState = () => {} } = {}) {
  if (!Number.isFinite(gain) || gain <= 0 || gain > 0.25) throw new RangeError('Pitch audition gain must be >0 and <=0.25')
  let context = null, source = null, output = null, generation = 0, disposed = false, startedAt = 0, start = 0, end = 0, playing = false, removeAbort = null, cancelPending = null
  function stop() {
    generation++
    const cancel = cancelPending; cancelPending = null; cancel?.(aborted())
    removeAbort?.(); removeAbort = null
    if (source) { source.onended = null; try { source.stop() } catch { /* Already ended. */ } source.disconnect(); source = null }
    output?.disconnect(); output = null
    playing = false; onState({ playing: false })
  }
  async function play(buffer, { start: from = 0, end: to = buffer?.duration, signal, isCurrent, onEnded } = {}) {
    if (disposed) throw new Error('原音試聽已關閉')
    if (!buffer || typeof buffer.getChannelData !== 'function' || !Number.isFinite(buffer.duration) ||
      !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to > buffer.duration || to - from > 60) {
      throw new RangeError('請選擇音檔內最多 60 秒的試聽範圍')
    }
    if (signal?.aborted) throw aborted()
    stop()
    const ticket = generation
    const check = () => { if (disposed || ticket !== generation || signal?.aborted || (isCurrent && !isCurrent())) throw aborted() }
    const abort = () => { if (ticket === generation) stop() }
    signal?.addEventListener('abort', abort, { once: true })
    removeAbort = () => signal?.removeEventListener('abort', abort)
    try {
      const Context = AudioContextClass ?? globalThis.AudioContext ?? globalThis.webkitAudioContext
      if (typeof Context !== 'function') throw new Error('此瀏覽器無法播放原音')
      if (!context || context.state === 'closed') context = new Context()
      let timer, rejectWait
      const interrupted = new Promise((_, reject) => {
        rejectWait = reject; cancelPending = reject
        timer = setTimeout(() => reject(new Error('播放啟動逾時，請再按一次試聽')), 10000)
      })
      try { await Promise.race([context.resume(), interrupted]) }
      finally { clearTimeout(timer); if (cancelPending === rejectWait) cancelPending = null }
      check()
      output = context.createGain(); output.gain.setValueAtTime(gain, context.currentTime)
      output.connect(context.destination)
      source = context.createBufferSource(); source.buffer = buffer; source.connect(output)
      source.onended = () => { if (ticket === generation) { stop(); onEnded?.({ start: from, end: to }) } }
      start = from; end = to; startedAt = context.currentTime
      source.start(0, from, to - from)
      playing = true; onState({ playing: true, start, end })
      return { start, end, gain, processed: false }
    } catch (error) {
      if (ticket === generation) stop()
      throw error
    }
  }
  return { play, stop,
    get playing() { return playing },
    get currentTime() { return playing ? Math.min(end, start + Math.max(0, context.currentTime - startedAt)) : start },
    dispose() { if (disposed) return; disposed = true; stop(); const closing = context; context = null; if (closing && closing.state !== 'closed') Promise.resolve(closing.close()).catch(() => {}) },
  }
}
