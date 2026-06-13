// 39 mastering presets across 4 dimensions.
// eqGains: [32Hz, 64Hz, 125Hz, 250Hz, 500Hz, 1kHz, 2kHz, 4kHz, 8kHz, 16kHz]
// All values are meaningful; no placeholder zeros beyond genuine neutral settings.

export const PRESETS = {
  // ── Tonal Character ────────────────────────────────────────
  warm: {
    label: 'Warm（溫暖）',
    eqGains:      [ 1.5,  1.0,  0.5,  0.5, -0.5, -0.5, -1.0, -1.5, -2.0, -2.5],
    compThreshold: -20, compRatio: 3, compKnee: 20, compAttack: 0.01, compRelease: 0.4, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 20, lpFreq: 20000,
  },
  balanced: {
    label: 'Balanced（平衡）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    compThreshold: -24, compRatio: 2, compKnee: 30, compAttack: 0.003, compRelease: 0.25, compMakeup: 0,
    limCeiling: -1.0, hpFreq: 20, lpFreq: 22000,
  },
  open: {
    label: 'Open（開闊透明）',
    eqGains:      [-0.5, -0.5, 0, 0, 0, 0.5, 0.5, 1.0, 1.5, 2.5],
    compThreshold: -26, compRatio: 2, compKnee: 30, compAttack: 0.002, compRelease: 0.2, compMakeup: 1,
    limCeiling: -1.0, hpFreq: 30, lpFreq: 22000,
  },
  punchy: {
    label: 'Punchy（力度衝擊）',
    eqGains:      [2.0, 2.5, 1.0, -0.5, -0.5, 0, 0.5, 1.0, 0.5, 0],
    compThreshold: -18, compRatio: 6, compKnee: 10, compAttack: 0.001, compRelease: 0.1, compMakeup: 3,
    limCeiling: -0.5, hpFreq: 40, lpFreq: 20000,
  },
  intimate: {
    label: 'Intimate（親密貼近）',
    eqGains:      [-1.0, -0.5, 0.5, 1.5, 1.0, 0.5, 0, -0.5, -1.0, -1.5],
    compThreshold: -22, compRatio: 4, compKnee: 15, compAttack: 0.005, compRelease: 0.3, compMakeup: 2,
    limCeiling: -1.5, hpFreq: 40, lpFreq: 18000,
  },
  cinematic: {
    label: 'Cinematic（電影史詩）',
    eqGains:      [3.0, 2.0, 0.5, 0, -0.5, 0, 0.5, 1.0, 2.0, 3.0],
    compThreshold: -28, compRatio: 2, compKnee: 40, compAttack: 0.02, compRelease: 0.8, compMakeup: 1,
    limCeiling: -2.0, hpFreq: 15, lpFreq: 22000,
  },
  loud: {
    label: 'Loud（競賽響度）',
    eqGains:      [0, 0.5, 0.5, 0, 0, 0, 0, 0.5, 0.5, 0],
    compThreshold: -12, compRatio: 10, compKnee: 5, compAttack: 0.001, compRelease: 0.05, compMakeup: 6,
    limCeiling: -0.1, hpFreq: 30, lpFreq: 22000,
  },
  dynamic: {
    label: 'Dynamic（動態保留）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 1.0],
    compThreshold: -40, compRatio: 1.5, compKnee: 40, compAttack: 0.05, compRelease: 1.0, compMakeup: 0,
    limCeiling: -2.0, hpFreq: 20, lpFreq: 22000,
  },

  // ── Genre ──────────────────────────────────────────────────
  pop: {
    label: 'Pop（流行）',
    eqGains:      [0, 0.5, 0, -0.5, 0, 0, 0.5, 1.0, 1.5, 2.0],
    compThreshold: -18, compRatio: 3, compKnee: 20, compAttack: 0.003, compRelease: 0.2, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 40, lpFreq: 20000,
  },
  hiphop: {
    label: 'Hip-hop / Trap（嘻哈）',
    eqGains:      [3.0, 4.0, 2.0, 0.5, -0.5, 0, -0.5, 0.5, 1.0, 0.5],
    compThreshold: -14, compRatio: 6, compKnee: 10, compAttack: 0.001, compRelease: 0.08, compMakeup: 4,
    limCeiling: -0.5, hpFreq: 25, lpFreq: 20000,
  },
  edm: {
    label: 'EDM / Electronic（電子舞曲）',
    eqGains:      [2.5, 3.0, 1.5, 0, -1.0, -0.5, 0, 1.0, 2.0, 3.0],
    compThreshold: -10, compRatio: 8, compKnee: 5, compAttack: 0.001, compRelease: 0.05, compMakeup: 5,
    limCeiling: -0.3, hpFreq: 20, lpFreq: 22000,
  },
  house: {
    label: 'House / Techno（浩室）',
    eqGains:      [2.0, 3.0, 1.0, -0.5, -1.0, -0.5, 0, 0.5, 1.5, 2.0],
    compThreshold: -12, compRatio: 5, compKnee: 8, compAttack: 0.001, compRelease: 0.06, compMakeup: 4,
    limCeiling: -0.5, hpFreq: 25, lpFreq: 22000,
  },
  rnb: {
    label: 'R&B / Soul（節奏藍調）',
    eqGains:      [1.5, 2.0, 1.0, 1.0, -0.5, 0.5, 0.5, 0, 0.5, 1.0],
    compThreshold: -16, compRatio: 4, compKnee: 15, compAttack: 0.005, compRelease: 0.3, compMakeup: 3,
    limCeiling: -1.0, hpFreq: 30, lpFreq: 20000,
  },
  jazz: {
    label: 'Jazz（爵士）',
    eqGains:      [0.5, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 1.0, 1.5],
    compThreshold: -32, compRatio: 1.8, compKnee: 35, compAttack: 0.02, compRelease: 0.8, compMakeup: 0,
    limCeiling: -2.0, hpFreq: 25, lpFreq: 20000,
  },
  classical: {
    label: 'Classical（古典）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0, 0.5, 1.0, 1.5],
    compThreshold: -48, compRatio: 1.2, compKnee: 40, compAttack: 0.05, compRelease: 2.0, compMakeup: 0,
    limCeiling: -3.0, hpFreq: 15, lpFreq: 22000,
  },
  metal: {
    label: 'Metal / Rock（金屬）',
    eqGains:      [1.5, 1.0, -1.0, -2.0, -1.0, 0.5, 1.5, 2.0, 1.5, 1.0],
    compThreshold: -16, compRatio: 6, compKnee: 8, compAttack: 0.001, compRelease: 0.08, compMakeup: 4,
    limCeiling: -0.5, hpFreq: 60, lpFreq: 20000,
  },
  punk: {
    label: 'Punk / Indie（龐克）',
    eqGains:      [0.5, 0, -0.5, 0, 0, 0.5, 1.0, 1.5, 1.0, 0.5],
    compThreshold: -20, compRatio: 3, compKnee: 20, compAttack: 0.003, compRelease: 0.15, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 50, lpFreq: 18000,
  },
  ambient: {
    label: 'Ambient（環境音）',
    eqGains:      [1.0, 0.5, 0, 0, 0, 0, 0.5, 1.0, 2.0, 3.5],
    compThreshold: -40, compRatio: 1.5, compKnee: 40, compAttack: 0.1, compRelease: 2.0, compMakeup: 0,
    limCeiling: -2.5, hpFreq: 20, lpFreq: 22000,
  },
  lofi: {
    label: 'Lo-fi Hip-hop',
    eqGains:      [1.0, 1.5, 1.0, 1.5, 0.5, 0, -1.0, -3.0, -5.0, -8.0],
    compThreshold: -20, compRatio: 5, compKnee: 10, compAttack: 0.01, compRelease: 0.3, compMakeup: 3,
    limCeiling: -2.0, hpFreq: 30, lpFreq: 14000,
  },
  country: {
    label: 'Country / Folk（鄉村）',
    eqGains:      [0.5, 0, 0.5, 1.0, 0.5, 0, 0.5, 1.0, 1.5, 1.5],
    compThreshold: -24, compRatio: 2.5, compKnee: 25, compAttack: 0.008, compRelease: 0.4, compMakeup: 1,
    limCeiling: -2.0, hpFreq: 30, lpFreq: 20000,
  },
  reggae: {
    label: 'Reggae / Dub（雷鬼）',
    eqGains:      [4.0, 3.5, 2.0, 1.0, -1.0, -0.5, 0, 0.5, 0.5, 0],
    compThreshold: -16, compRatio: 4, compKnee: 15, compAttack: 0.005, compRelease: 0.5, compMakeup: 3,
    limCeiling: -1.0, hpFreq: 20, lpFreq: 18000,
  },
  kpop: {
    label: 'K-pop',
    eqGains:      [0, 0.5, 0, -1.0, -0.5, 0.5, 1.0, 1.5, 2.0, 3.0],
    compThreshold: -14, compRatio: 5, compKnee: 12, compAttack: 0.002, compRelease: 0.15, compMakeup: 4,
    limCeiling: -0.5, hpFreq: 40, lpFreq: 20000,
  },
  latin: {
    label: 'Latin（拉丁）',
    eqGains:      [1.0, 1.5, 0.5, 0.5, 0, 0.5, 0.5, 1.0, 1.5, 1.5],
    compThreshold: -18, compRatio: 4, compKnee: 15, compAttack: 0.003, compRelease: 0.2, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 35, lpFreq: 20000,
  },
  gospel: {
    label: 'Gospel / Choir（福音）',
    eqGains:      [0, 0.5, 1.0, 1.5, 0.5, 1.0, 0.5, 0.5, 1.0, 2.0],
    compThreshold: -20, compRatio: 3, compKnee: 25, compAttack: 0.01, compRelease: 0.4, compMakeup: 2,
    limCeiling: -1.5, hpFreq: 60, lpFreq: 18000,
  },
  podcast: {
    label: 'Podcast / Spoken',
    eqGains:      [-2.0, -2.0, 0, 1.5, 2.0, 1.5, 0.5, 0, -0.5, -2.0],
    compThreshold: -18, compRatio: 4, compKnee: 15, compAttack: 0.005, compRelease: 0.2, compMakeup: 3,
    limCeiling: -1.5, hpFreq: 80, lpFreq: 15000,
  },
  game: {
    label: 'Game Audio（遊戲）',
    eqGains:      [0.5, 0.5, 0, 0, 0, 0.5, 1.0, 1.5, 1.5, 1.0],
    compThreshold: -16, compRatio: 3, compKnee: 20, compAttack: 0.001, compRelease: 0.1, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 50, lpFreq: 20000,
  },

  // ── Era ────────────────────────────────────────────────────
  era60s: {
    label: '60s Motown',
    eqGains:      [-0.5, 0, 1.0, 2.0, 1.5, 1.5, 0.5, -0.5, -1.5, -3.0],
    compThreshold: -24, compRatio: 3, compKnee: 20, compAttack: 0.01, compRelease: 0.5, compMakeup: 2,
    limCeiling: -3.0, hpFreq: 60, lpFreq: 14000,
  },
  era70s: {
    label: '70s Classic Rock',
    eqGains:      [1.0, 0.5, 0.5, 0, -0.5, 0, 0.5, 1.0, 1.5, 1.0],
    compThreshold: -22, compRatio: 3, compKnee: 20, compAttack: 0.008, compRelease: 0.4, compMakeup: 2,
    limCeiling: -2.5, hpFreq: 40, lpFreq: 16000,
  },
  era80s: {
    label: '80s New Wave',
    eqGains:      [-0.5, 0, -0.5, 0, 0, 0.5, 1.0, 2.0, 3.5, 3.0],
    compThreshold: -18, compRatio: 4, compKnee: 15, compAttack: 0.003, compRelease: 0.2, compMakeup: 3,
    limCeiling: -1.5, hpFreq: 50, lpFreq: 20000,
  },
  era90s: {
    label: '90s Golden Age',
    eqGains:      [2.0, 2.5, 1.0, 0, -0.5, 0, 0.5, 0.5, 1.0, 0.5],
    compThreshold: -16, compRatio: 5, compKnee: 10, compAttack: 0.002, compRelease: 0.15, compMakeup: 3,
    limCeiling: -1.0, hpFreq: 40, lpFreq: 20000,
  },
  era2000s: {
    label: '2000s Loud Wars（⚠ 過壓縮示範）',
    eqGains:      [0.5, 0.5, 0.5, 0, 0, 0, 0.5, 0.5, 0.5, 0.5],
    compThreshold: -8, compRatio: 12, compKnee: 3, compAttack: 0.001, compRelease: 0.04, compMakeup: 6,
    limCeiling: -0.1, hpFreq: 30, lpFreq: 22000,
  },
  streaming: {
    label: 'Streaming Era（現代）',
    eqGains:      [0, 0.5, 0, -0.5, 0, 0, 0.5, 1.0, 1.5, 2.0],
    compThreshold: -20, compRatio: 3, compKnee: 25, compAttack: 0.003, compRelease: 0.2, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 35, lpFreq: 20000,
  },

  // ── Platform ───────────────────────────────────────────────
  spotify: {
    label: 'Spotify（-14 LUFS）',
    eqGains:      [0, 0.5, 0, -0.5, 0, 0, 0.5, 1.0, 1.5, 1.5],
    compThreshold: -20, compRatio: 3, compKnee: 25, compAttack: 0.003, compRelease: 0.2, compMakeup: 2,
    limCeiling: -1.0, hpFreq: 35, lpFreq: 20000,
    targetLUFS: -14,
  },
  youtube: {
    label: 'YouTube（-13 LUFS）',
    eqGains:      [0, 0.5, 0, -0.5, 0, 0, 0.5, 1.0, 1.5, 2.0],
    compThreshold: -18, compRatio: 3, compKnee: 20, compAttack: 0.003, compRelease: 0.2, compMakeup: 2.5,
    limCeiling: -1.0, hpFreq: 35, lpFreq: 20000,
    targetLUFS: -13,
  },
  apple: {
    label: 'Apple Music（-16 LUFS）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0.5, 1.0, 1.5, 2.0],
    compThreshold: -24, compRatio: 2.5, compKnee: 30, compAttack: 0.005, compRelease: 0.3, compMakeup: 1,
    limCeiling: -1.0, hpFreq: 30, lpFreq: 20000,
    targetLUFS: -16,
  },
  tidal: {
    label: 'Tidal HiFi（-14 LUFS）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0.5, 0.5, 1.0, 1.5],
    compThreshold: -22, compRatio: 2, compKnee: 30, compAttack: 0.003, compRelease: 0.25, compMakeup: 1,
    limCeiling: -1.0, hpFreq: 20, lpFreq: 22000,
    targetLUFS: -14,
  },
  cd: {
    label: 'CD Master（-16 LUFS）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5],
    compThreshold: -24, compRatio: 2, compKnee: 35, compAttack: 0.005, compRelease: 0.4, compMakeup: 0,
    limCeiling: -0.3, hpFreq: 20, lpFreq: 22000,
    targetLUFS: -16,
  },
  vinyl: {
    label: 'Vinyl Cut（黑膠刻版）',
    eqGains:      [0, 0, 0.5, 1.0, 0.5, 0, 0, -0.5, -1.5, -3.0],
    compThreshold: -26, compRatio: 2, compKnee: 35, compAttack: 0.01, compRelease: 0.5, compMakeup: 0,
    limCeiling: -3.0, hpFreq: 30, lpFreq: 16000,
    targetLUFS: -18,
    isVinyl: true,
  },
  broadcast: {
    label: 'Broadcast / TV（EBU R128 -23 LUFS）',
    eqGains:      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    compThreshold: -30, compRatio: 1.5, compKnee: 40, compAttack: 0.02, compRelease: 1.0, compMakeup: 0,
    limCeiling: -2.0, hpFreq: 80, lpFreq: 18000,
    targetLUFS: -23,
  },
}
