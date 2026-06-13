import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const html = readFileSync(resolve(root, 'index.html'), 'utf8')
const css = readFileSync(resolve(root, 'src/css/layout.css'), 'utf8')
const main = readFileSync(resolve(root, 'src/js/main.js'), 'utf8')

describe('responsive workstation layout', () => {
  it('keeps the processing rack and monitoring panel independently scrollable', () => {
    expect(css).toMatch(/\.chain-modules\s*\{[\s\S]*?min-height:\s*220px;[\s\S]*?overflow-y:\s*auto;/)
    expect(css).toMatch(/\.meters-panel\s*\{[\s\S]*?min-height:\s*230px;[\s\S]*?overflow-y:\s*auto;/)
  })

  it('keeps vectorscope, loudness history and platform targets in the monitor grid', () => {
    expect(css).toContain('"gonio graph"')
    expect(css).toContain('"gonio platforms"')
    expect(html).toContain('id="gonio-canvas"')
    expect(html).toContain('id="loudness-graph-canvas"')
    expect(html).toContain('id="bar-spotify"')
  })

  it('shows and updates a visible waveform zoom value', () => {
    expect(html).toContain('id="zoom-level"')
    expect(main).toContain("zoomOutput.value = `${zoomLevel / 20}×`")
  })

  it('returns the fixed shell to natural document flow on mobile', () => {
    expect(css).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?#app\s*\{[\s\S]*?height:\s*auto;/)
    expect(css).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.chain-panel\s*\{[\s\S]*?overflow:\s*visible;/)
    expect(css).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.album-row\s*\{[\s\S]*?grid-template-areas:/)
    expect(css).toMatch(/@media \(max-width:\s*680px\)[\s\S]*?\.transport\s*\{[\s\S]*?position:\s*relative;/)
  })
})
