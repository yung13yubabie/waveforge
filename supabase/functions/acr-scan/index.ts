/**
 * WaveForge ACRCloud 掃描 Edge Function
 *
 * 功能：
 * 1. 驗證使用者 JWT
 * 2. 從 user_settings 取得 ACRCloud 憑證
 * 3. 計算 HMAC-SHA1 簽名
 * 4. 呼叫 ACRCloud identify API
 * 5. 將結果寫入 scan_results 表
 * 6. 發送 Email 通知（若 email_notify=true 且 RESEND_API_KEY 已設定）
 *
 * 部署：
 *   supabase functions deploy acr-scan --no-verify-jwt
 * 環境變數（在 Supabase Dashboard → Edge Functions → Secrets 設定）：
 *   RESEND_API_KEY  — Resend.com API key（可選，用於 Email 通知）
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// HMAC-SHA1 for ACRCloud signature
async function hmacSha1Base64(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// Send email via Resend
async function sendEmail(to: string, subject: string, html: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY')
  if (!apiKey) return

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'WaveForge <noreply@waveforge.app>',
      to: [to],
      subject,
      html,
    }),
  }).catch(() => { /* 通知失敗不影響主流程 */ })
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS })
  }

  try {
    // ── Auth ──────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return jsonResp({ error: '未授權' }, 401)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) return jsonResp({ error: '無效的 token' }, 401)

    // ── Parse body ────────────────────────────────────────
    const { work_id, audio_base64 } = await req.json()
    if (!audio_base64) return jsonResp({ error: '缺少 audio_base64 參數' }, 400)

    // ── Get ACRCloud credentials ──────────────────────────
    const { data: settings, error: settingsErr } = await supabase
      .from('user_settings')
      .select('acr_access_key, acr_access_secret, acr_host, email_notify')
      .eq('user_id', user.id)
      .single()

    if (settingsErr || !settings?.acr_access_key) {
      return jsonResp({ error: '請先在設定中填入 ACRCloud API Key 與 Secret' }, 400)
    }

    const {
      acr_access_key: accessKey,
      acr_access_secret: accessSecret,
      acr_host: host = 'identify-eu-west-1.acrcloud.com',
      email_notify: emailNotify,
    } = settings

    // ── Build ACRCloud request ────────────────────────────
    const timestamp = Math.floor(Date.now() / 1000)
    const sigStr = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`
    const signature = await hmacSha1Base64(accessSecret, sigStr)

    // Decode base64 audio (strip data URL prefix if present)
    const b64 = audio_base64.replace(/^data:[^;]+;base64,/, '')
    const audioBytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

    const formData = new FormData()
    formData.append('sample', new Blob([audioBytes], { type: 'audio/wav' }), 'sample.wav')
    formData.append('access_key', accessKey)
    formData.append('data_type', 'audio')
    formData.append('signature_version', '1')
    formData.append('signature', signature)
    formData.append('sample_bytes', String(audioBytes.length))
    formData.append('timestamp', String(timestamp))

    // ── Call ACRCloud ─────────────────────────────────────
    const acrRes = await fetch(`https://${host}/v1/identify`, {
      method: 'POST',
      body: formData,
    })
    const acrData = await acrRes.json()

    // ── Parse results ─────────────────────────────────────
    type ScanResult = {
      similarity: number
      title: string
      artist: string
      album?: string
      platform: string
      acrid?: string
      url: string
    }
    const results: ScanResult[] = []

    if (acrData.status?.code === 0 && acrData.metadata?.music) {
      for (const match of acrData.metadata.music) {
        const spotifyId = match.external_metadata?.spotify?.track?.id
        const youtubeId = match.external_metadata?.youtube?.vid
        const url = spotifyId
          ? `https://open.spotify.com/track/${spotifyId}`
          : youtubeId
            ? `https://www.youtube.com/watch?v=${youtubeId}`
            : '#'

        results.push({
          similarity: Math.round(match.score ?? 0),
          title:      match.title ?? '(未知)',
          artist:     match.artists?.[0]?.name ?? '—',
          album:      match.album?.name,
          platform:   spotifyId ? 'Spotify' : youtubeId ? 'YouTube' : 'ACRCloud',
          acrid:      match.acrid,
          url,
        })
      }
    }

    // ── Store results ─────────────────────────────────────
    if (work_id) {
      await supabase.from('scan_results').insert({
        work_id,
        results,
        match_count: results.length,
        acr_raw: acrData,
      })
      await supabase.from('works').update({
        last_scan: new Date().toISOString(),
      }).eq('id', work_id).eq('user_id', user.id)
    }

    // ── Email notification ────────────────────────────────
    if (results.length > 0 && emailNotify && user.email) {
      let workName = work_id ?? '您的作品'
      if (work_id) {
        const { data: w } = await supabase
          .from('works').select('name').eq('id', work_id).single()
        if (w?.name) workName = w.name
      }

      const matchList = results.slice(0, 5).map(r =>
        `<li>「${r.title}」by ${r.artist} — 相似度 ${r.similarity}% · <a href="${r.url}">${r.platform}</a></li>`
      ).join('')

      await sendEmail(
        user.email,
        `WaveForge 防盜偵測：「${workName}」發現 ${results.length} 筆相似曲`,
        `<h2>WaveForge 防盜偵測通知</h2>
         <p>您的作品「<strong>${workName}</strong>」偵測到 <strong>${results.length}</strong> 筆相似曲：</p>
         <ul>${matchList}</ul>
         <p>前往 <a href="https://yung13yubabie.github.io/waveforge/">WaveForge</a> 查看完整結果。</p>
         <p style="color:#999;font-size:12px">如需停止通知，請至 WaveForge 設定關閉 Email 通知。</p>`,
      )
    }

    return jsonResp({ results, acrStatus: acrData.status })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[acr-scan]', msg)
    return jsonResp({ error: `掃描失敗：${msg}` }, 500)
  }
})
