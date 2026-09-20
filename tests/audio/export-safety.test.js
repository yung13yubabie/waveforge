import { it, expect } from 'vitest'
import { assertIntegerHeadroom } from '../../src/js/audio/export-safety.js'

it('blocks positive and negative overload unless explicitly permitted', () => {
  for (const value of [1.1, -1.1]) {
    expect(() => assertIntegerHeadroom([new Float32Array([value])])).toThrow(/超峰值/)
    expect(() => assertIntegerHeadroom([new Float32Array([value])], true)).not.toThrow()
  }
})
it('rejects non-finite DSP output even when clipping is allowed', () => {
  expect(() => assertIntegerHeadroom([new Float32Array([NaN])], true)).toThrow(/非有限/)
})
