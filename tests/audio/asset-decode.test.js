import { it, expect } from 'vitest'
import { wavSampleRate } from '../../src/js/audio/asset-decode.js'
import { encodeWAV } from '../../src/js/audio/wav.js'

it('reads WAV native rate without decoding through the monitor context', () => {
  expect(wavSampleRate(encodeWAV([new Float32Array(100)], 96000))).toBe(96000)
  expect(wavSampleRate(encodeWAV([new Float32Array(100)], 44100))).toBe(44100)
})
it('returns unknown for unrelated formats and rejects malformed chunk sizes safely', () => {
  expect(wavSampleRate(new ArrayBuffer(3))).toBeNull()
  const data = encodeWAV([new Float32Array(100)], 48000)
  new DataView(data).setUint32(16, 0xffffffff, true)
  expect(() => wavSampleRate(data)).toThrow(/WAV/)
})
