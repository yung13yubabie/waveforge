// Tab navigation between Master / Stems / Anti-theft modes

const MODES = ['master', 'stems', 'antitheft', 'editor', 'lyrics']

export function initModeNav() {
  const tabs = document.querySelectorAll('.mode-tab[data-mode]')
  const panels = {
    editor:     document.getElementById('mode-editor'),
    lyrics:     document.getElementById('mode-lyrics'),
    master:     document.getElementById('mode-master'),
    stems:      document.getElementById('mode-stems'),
    antitheft:  document.getElementById('mode-antitheft'),
  }
  const chainPanel = document.querySelector('.chain-panel')
  const app = document.getElementById('app')

  function switchMode(mode) {
    tabs.forEach(t => {
      const active = t.dataset.mode === mode
      t.classList.toggle('active', active)
      t.setAttribute('aria-selected', String(active))
      t.tabIndex = active ? 0 : -1
    })
    MODES.forEach(m => {
      const panel = panels[m]
      if (!panel) return
      panel.hidden = m !== mode
    })

    // Anti-theft is full-width (no chain panel)
    if (mode === 'antitheft' || mode === 'lyrics' || mode === 'editor') {
      app.classList.add('mode-antitheft')
      chainPanel?.setAttribute('aria-hidden', 'true')
    } else {
      app.classList.remove('mode-antitheft')
      chainPanel?.removeAttribute('aria-hidden')
    }

    app.classList.toggle('mode-editor', mode === 'editor')
    app.classList.toggle('mode-lyrics', mode === 'lyrics')
    document.dispatchEvent(new CustomEvent('wf:mode-change', { detail: { mode } }))
    app.classList.toggle('mode-stems', mode === 'stems')
    if (mode === 'stems') chainPanel?.setAttribute('aria-hidden', 'true')

    // Show auth overlay in anti-theft if not logged in
    if (mode === 'antitheft') {
      document.dispatchEvent(new CustomEvent('wf:check-auth'))
    }
  }

  tabs.forEach(tab => {
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1
    tab.addEventListener('click', () => switchMode(tab.dataset.mode))
    tab.addEventListener('keydown', event => {
      const list = [...tabs]
      let next = list.indexOf(tab)
      if (event.key === 'ArrowRight') next = (next + 1) % list.length
      else if (event.key === 'ArrowLeft') next = (next - 1 + list.length) % list.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = list.length - 1
      else return
      event.preventDefault()
      switchMode(list[next].dataset.mode)
      list[next].focus()
    })
  })

  // Also expose for programmatic use
  return { switchMode }
}
