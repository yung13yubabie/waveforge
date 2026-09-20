import { describe, it, expect, beforeEach } from 'vitest'
import { initModeNav } from '../src/js/mode-nav.js'

function buildDom() {
  document.body.innerHTML = `
    <div id="app">
      <button class="mode-tab active" data-mode="master" aria-selected="true">Master</button>
      <button class="mode-tab" data-mode="stems" aria-selected="false">Stems</button>
      <button class="mode-tab" data-mode="antitheft" aria-selected="false">Anti-theft</button>
      <div class="chain-panel"></div>
      <section id="mode-master"></section>
      <section id="mode-stems" hidden></section>
      <section id="mode-antitheft" hidden></section>
    </div>
  `
}

const tab = (mode) => document.querySelector(`.mode-tab[data-mode="${mode}"]`)
const panel = (mode) => document.getElementById(`mode-${mode}`)

describe('initModeNav', () => {
  beforeEach(buildDom)

  it('shows only the selected panel', () => {
    const { switchMode } = initModeNav()
    switchMode('stems')

    expect(panel('stems').hidden).toBe(false)
    expect(panel('master').hidden).toBe(true)
    expect(panel('antitheft').hidden).toBe(true)
  })

  it('marks only the selected tab active and aria-selected', () => {
    const { switchMode } = initModeNav()
    switchMode('stems')

    expect(tab('stems').classList.contains('active')).toBe(true)
    expect(tab('stems').getAttribute('aria-selected')).toBe('true')
    expect(tab('master').classList.contains('active')).toBe(false)
    expect(tab('master').getAttribute('aria-selected')).toBe('false')
  })

  it('switches mode when a tab is clicked', () => {
    initModeNav()
    tab('antitheft').click()

    expect(panel('antitheft').hidden).toBe(false)
    expect(panel('master').hidden).toBe(true)
  })

  it('hides the chain panel and widens the app in anti-theft mode', () => {
    const { switchMode } = initModeNav()
    switchMode('antitheft')

    expect(document.getElementById('app').classList.contains('mode-antitheft')).toBe(true)
    expect(document.querySelector('.chain-panel').getAttribute('aria-hidden')).toBe('true')
  })

  it('gives the stems mixer the full workspace', () => {
    const { switchMode } = initModeNav()
    switchMode('stems')
    expect(document.getElementById('app').classList.contains('mode-stems')).toBe(true)
    expect(document.querySelector('.chain-panel').getAttribute('aria-hidden')).toBe('true')
    switchMode('master')
    expect(document.getElementById('app').classList.contains('mode-stems')).toBe(false)
  })

  it('restores the chain panel when leaving anti-theft mode', () => {
    const { switchMode } = initModeNav()
    switchMode('antitheft')
    switchMode('master')

    expect(document.getElementById('app').classList.contains('mode-antitheft')).toBe(false)
    expect(document.querySelector('.chain-panel').hasAttribute('aria-hidden')).toBe(false)
  })

  it('requests an auth check when entering anti-theft mode', () => {
    let fired = 0
    document.addEventListener('wf:check-auth', () => fired++)

    const { switchMode } = initModeNav()
    switchMode('master')
    expect(fired).toBe(0)

    switchMode('antitheft')
    expect(fired).toBe(1)
  })

  it('does not throw when the chain panel is absent', () => {
    document.querySelector('.chain-panel').remove()
    const { switchMode } = initModeNav()

    expect(() => switchMode('antitheft')).not.toThrow()
    expect(() => switchMode('master')).not.toThrow()
  })

  it('ignores an unknown mode without unhiding anything', () => {
    const { switchMode } = initModeNav()
    switchMode('nope')

    expect(panel('master').hidden).toBe(true)
    expect(panel('stems').hidden).toBe(true)
    expect(panel('antitheft').hidden).toBe(true)
  })
})
