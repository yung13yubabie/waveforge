import { generateTakedownReport } from './evidence.js'

function safeHref(url) {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') ? url : '#'
  } catch { return '#' }
}

function buildResultItem(r, i, work) {
  const cls = r.similarity >= 90 ? 'high' : r.similarity >= 70 ? 'mid' : 'low'

  const item = document.createElement('div')
  item.className = 'scan-result-item'
  item.style.animationDelay = `${i * 40}ms`

  const simEl = document.createElement('div')
  simEl.className = `result-similarity ${cls}`
  simEl.textContent = `${r.similarity}%`

  if (r.albumArt) {
    const artEl = document.createElement('img')
    artEl.src = safeHref(r.albumArt)
    artEl.alt = ''
    artEl.className = 'result-album-art'
    artEl.loading = 'lazy'
    item.appendChild(artEl)
  }

  const infoEl = document.createElement('div')
  infoEl.className = 'result-info'

  const titleEl = document.createElement('div')
  titleEl.className = 'result-title'
  titleEl.textContent = r.title ?? ''

  const metaEl = document.createElement('div')
  metaEl.className = 'result-meta'
  const artistEl = document.createElement('span')
  artistEl.textContent = r.artist ?? ''
  metaEl.appendChild(artistEl)
  if (r.releaseDate) {
    const dateEl = document.createElement('span')
    dateEl.textContent = `· ${r.releaseDate}`
    metaEl.appendChild(dateEl)
  }
  infoEl.append(titleEl, metaEl)

  // Platform link chips. Direct track links (from ACRCloud external IDs) are
  // exact; when a match has none (common for cover/humming hits), fall back to
  // precise SEARCH links built from title + artist so every result is findable.
  const linksEl = document.createElement('div')
  linksEl.className = 'result-links'
  let platforms = Array.isArray(r.platforms) && r.platforms.length
    ? r.platforms.slice()
    : (r.url && r.url !== '#' ? [{ name: r.platform || '前往', url: r.url }] : [])
  const isDirect = platforms.length > 0
  if (platforms.length === 0) {
    const q = encodeURIComponent(`${r.title ?? ''} ${r.artist ?? ''}`.trim())
    if (q) {
      platforms = [
        { name: 'YouTube 搜尋', url: `https://www.youtube.com/results?search_query=${q}` },
        { name: 'Spotify 搜尋',  url: `https://open.spotify.com/search/${q}` },
      ]
    }
  }
  if (platforms.length === 0) {
    const none = document.createElement('span')
    none.className = 'result-no-link'
    none.textContent = '無連結'
    linksEl.appendChild(none)
  } else {
    for (const p of platforms) {
      const a = document.createElement('a')
      a.className = `result-link-chip${isDirect ? '' : ' search'}`
      a.href = safeHref(p.url)
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.setAttribute('aria-label', `${isDirect ? '前往' : '搜尋'} ${p.name}`)
      a.textContent = p.name
      linksEl.appendChild(a)
    }
  }

  // Takedown evidence — generate a DMCA report .txt (+ copy to clipboard).
  const evBtn = document.createElement('button')
  evBtn.className = 'result-evidence-btn'
  evBtn.textContent = '取證'
  evBtn.setAttribute('data-tooltip', '產生下架/DMCA 證據報告（含你的檔案雜湊 + 盜用連結）')
  evBtn.addEventListener('click', async (e) => {
    e.stopPropagation()
    evBtn.disabled = true
    evBtn.textContent = '產生中…'
    try {
      const report = await generateTakedownReport(work, r)
      const safeName = (r.title || 'work').replace(/[^\w一-龥-]/g, '_').slice(0, 40)
      const blob = new Blob([report], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `takedown_${safeName}.txt`
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      try { await navigator.clipboard?.writeText(report) } catch { /* clipboard optional */ }
      evBtn.textContent = '已下載 ✓'
    } catch (err) {
      evBtn.textContent = '失敗'
      console.error('[takedown report]', err)
    } finally {
      setTimeout(() => { evBtn.disabled = false; evBtn.textContent = '取證' }, 2500)
    }
  })
  linksEl.appendChild(evBtn)

  item.append(simEl, infoEl, linksEl)
  return item
}

// Section header for a match group (原曲/指紋 vs 翻唱/Cover).
function buildResultSection(kind, count) {
  const head = document.createElement('div')
  head.className = `result-section-head ${kind === 'cover' ? 'cover' : 'exact'}`
  const label = document.createElement('span')
  label.className = 'result-section-label'
  label.textContent = kind === 'cover' ? '翻唱比對（Cover）' : '原曲比對（指紋）'
  const badge = document.createElement('span')
  badge.className = 'result-section-count'
  badge.textContent = `${count}`
  head.append(label, badge)
  return head
}

export function renderResults(work) {
  const listEl = document.getElementById('scan-results-list')
  if (!listEl) return

  if (!work?.results?.length) {
    const empty = document.createElement('div')
    empty.className = 'scan-empty'
    const icon = document.createElement('div')
    icon.className = 'scan-empty-icon'
    icon.textContent = '◎'
    const msg = document.createElement('div')
    msg.textContent = '尚無比對結果'
    empty.append(icon, msg)
    listEl.replaceChildren(empty)
    return
  }

  // Split into 原曲(指紋/exact) and 翻唱(cover), each sorted by similarity desc.
  const bySim = (a, b) => b.similarity - a.similarity
  const exact = work.results.filter(r => r.source !== '翻唱').sort(bySim)
  const cover = work.results.filter(r => r.source === '翻唱').sort(bySim)

  const fragment = document.createDocumentFragment()
  let i = 0
  if (exact.length) {
    fragment.appendChild(buildResultSection('exact', exact.length))
    for (const r of exact) fragment.appendChild(buildResultItem(r, i++, work))
  }
  if (cover.length) {
    fragment.appendChild(buildResultSection('cover', cover.length))
    for (const r of cover) fragment.appendChild(buildResultItem(r, i++, work))
  }
  listEl.replaceChildren(fragment)
}

