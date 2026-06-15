// Tab navigation between Master / Stems / Anti-theft modes

const MODES = ['master', 'stems', 'antitheft']

export function initModeNav() {
  const tabs = document.querySelectorAll('.mode-tab[data-mode]')
  const panels = {
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
    })
    MODES.forEach(m => {
      const panel = panels[m]
      if (!panel) return
      panel.hidden = m !== mode
    })

    // Anti-theft is full-width (no chain panel)
    if (mode === 'antitheft') {
      app.classList.add('mode-antitheft')
      chainPanel?.setAttribute('aria-hidden', 'true')
    } else {
      app.classList.remove('mode-antitheft')
      chainPanel?.removeAttribute('aria-hidden')
    }

    // Show auth overlay in anti-theft if not logged in
    if (mode === 'antitheft') {
      document.dispatchEvent(new CustomEvent('wf:check-auth'))
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode))
  })

  // Also expose for programmatic use
  return { switchMode }
}
