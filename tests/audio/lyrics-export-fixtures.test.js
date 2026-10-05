import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { exportLyrics } from '../../src/js/lyrics/export.js'
import { multilingualFixture } from '../fixtures/lyrics/generate.js'

describe('retained multilingual subtitle fixtures', () => {
  it.each(['txt', 'lrc', 'srt', 'ass'])('%s bytes reproduce from the production serializer', format => {
    const saved = readFileSync(`tests/fixtures/lyrics/multilingual.${format}`, 'utf8')
    expect(exportLyrics(multilingualFixture(), format)).toBe(saved)
  })
})
