/**
 * Fetch track metadata from a public URL using platform oEmbed endpoints.
 * Supported: YouTube, Spotify, SoundCloud, Deezer, Apple Music
 * Unsupported: SUNO (no public API)
 */

const PLATFORMS = [
  { name: 'YouTube',     regex: /youtube\.com\/watch|youtu\.be\//,          oembed: u => `https://www.youtube.com/oembed?url=${encodeURIComponent(u)}&format=json` },
  { name: 'Spotify',     regex: /open\.spotify\.com\/(track|album|artist)/, oembed: u => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}` },
  { name: 'SoundCloud',  regex: /soundcloud\.com\//,                         oembed: u => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  { name: 'Apple Music', regex: /music\.apple\.com\//,                       oembed: u => `https://embed.music.apple.com/oembed?url=${encodeURIComponent(u)}` },
  { name: 'Deezer',      regex: /deezer\.com\/(track|album|artist)/,         oembed: u => `https://api.deezer.com/oembed?url=${encodeURIComponent(u)}&format=json` },
  { name: 'SUNO',        regex: /suno\.com\//,                               oembed: null },
]

/**
 * @param {string} url
 * @returns {{ platform: string, title: string|null, thumbnailUrl: string|null, authorName: string|null, supported: boolean }}
 */
export async function fetchUrlMeta(url) {
  let rawUrl
  try { rawUrl = new URL(url) } catch { throw new Error('無效的 URL 格式') }
  if (rawUrl.protocol !== 'https:' && rawUrl.protocol !== 'http:') throw new Error('僅支援 http/https URL')

  const platform = PLATFORMS.find(p => p.regex.test(url))
  if (!platform) throw new Error('不支援此平台（支援：YouTube、Spotify、SoundCloud、Apple Music、Deezer）')
  if (!platform.oembed) throw new Error(`${platform.name} 無公開 API，無法自動擷取資訊`)

  const oembedUrl = platform.oembed(url)
  const res = await fetch(oembedUrl, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`${platform.name} 回應錯誤 (${res.status})`)

  const data = await res.json()
  return {
    platform: platform.name,
    title: data.title ?? null,
    authorName: data.author_name ?? null,
    thumbnailUrl: data.thumbnail_url ?? null,
    supported: true,
  }
}

/** Extract platform name without making any network call */
export function detectPlatform(url) {
  try { new URL(url) } catch { return null }
  return PLATFORMS.find(p => p.regex.test(url))?.name ?? null
}
