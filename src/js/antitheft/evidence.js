import { sha256Hex } from '../audio/sha256.js'

// Interpret an ISRC's country prefix. Q-prefixes (QM/QZ/QT/QN…) are ISRC
// "user-assigned" codes that IFPI hands to digital distributors, so they almost
// always mean the upload came through an aggregator (DistroKid / TuneCore /
// CD Baby / Amuse …) rather than a traditional label — a direct DMCA to that
// distributor takes the release down across every platform at once.
export function analyzeIsrc(isrc) {
  const clean = (isrc ?? '').replace(/[-\s]/g, '')
  if (clean.length < 7) return ''
  const cc = clean.slice(0, 2).toUpperCase()
  const registrant = clean.slice(2, 5)
  const year = clean.slice(5, 7)
  if (/^Q/.test(cc)) {
    return `國碼 ${cc} 為 ISRC「使用者指定碼」，幾乎都由數位發行商（DistroKid / TuneCore / CD Baby / Amuse 等 aggregator）配發，非傳統唱片公司。`
      + `→ 建議直接對該發行商發 DMCA，一撤即全平台同步下架。登記者代碼：${registrant}，年份 20${year}。`
  }
  return `國碼 ${cc}、登記者代碼 ${registrant}、年份 20${year}。`
}

// ── Takedown evidence report ──────────────────────────────
// Build a DMCA-style evidence report for one suspected-infringement match,
// including a SHA-256 of the user's ORIGINAL file (proof of possession) and
// the exact platform links where the stolen upload is hosted.
export async function generateTakedownReport(work, r) {
  const now = new Date()
  let ownFile = '原始檔不在本分頁 — 請重新上傳同一檔案以加入檔案雜湊（持有證明）'
  if (work?.file) {
    try {
      const hex = await sha256Hex(await work.file.arrayBuffer())
      ownFile = `檔名：${work.file.name}\n檔案大小：${work.file.size} bytes\nSHA-256：${hex}\n（此雜湊證明我持有此原始錄音檔）`
    } catch (e) {
      ownFile = `檔案雜湊計算失敗：${e.message}`
    }
  }
  const platforms = Array.isArray(r.platforms) && r.platforms.length ? r.platforms : []
  const platformLines = platforms.length
    ? platforms.map(p => `- ${p.name}：${p.url}`).join('\n')
    : `- （ACRCloud 未提供直接連結，請於各平台搜尋「${r.title ?? ''} ${r.artist ?? ''}」）`
  const matchKind = r.source === '翻唱' ? '翻唱/改編（Cover）' : '音訊指紋（完全相同錄音）'

  return `WaveForge 盜用取證報告 / Copyright Infringement Evidence
產生時間：${now.toISOString()}

== 我的原創作品 (My original work) ==
作品名稱：${work?.name ?? '(未命名)'}
${ownFile}

== 偵測到的疑似盜用 (Detected infringing upload) ==
比對曲目：${r.title ?? '(未知)'} / ${r.artist ?? '—'}
專輯：${r.album ?? '—'}
發行日：${r.releaseDate ?? '—'}
廠牌 / 發行者：${r.label ?? '—'}
相似度：${r.similarity}%（比對方式：${matchKind}）
ACRCloud ID：${r.acrid ?? '—'}
ISRC：${r.isrc ?? '—'}
UPC：${r.upc ?? '—'}

上架平台與連結 (Where it is hosted)：
${platformLines}

== 發行來源分析 (Distribution source) ==
${analyzeIsrc(r.isrc) || 'ISRC 不明，無法分析發行來源。'}
可用 UPC「${r.upc ?? '—'}」與廠牌「${r.label ?? '—'}」向平台或發行商回溯上架者身分。

== 技術證據 (Technical evidence) ==
比對引擎：ACRCloud Audio Fingerprinting
說明：相似度 ${r.similarity}% 表示上架版本與我的原始錄音在音訊指紋層級${r.similarity >= 98 ? '完全相同' : '高度相似'}。

== 著作權聲明 (DMCA statement) ==
我在此聲明，我對上述原創作品擁有著作權（或經授權代表權利人）。上述平台連結所指之內容未經我授權使用了我的錄音，構成侵權。
我基於誠信相信此使用未經著作權人、其代理人或法律授權。本通知所載資訊正確無誤；在偽證罪責下，我聲明我有權就上述受侵權之專屬權利行事。
我要求平台移除或停用對該侵權內容的存取。

權利人簽署 (Signature)：__________________________
日期 (Date)：${now.toLocaleDateString('zh-TW')}
聯絡方式 (Contact)：__________________________
`
}

