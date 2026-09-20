# WaveForge

線上瀏覽器母帶工作站。前端 Web Audio API 負責播放及匯出；AI 分軌與防盜偵測使用外部服務。不需要離線 App 或本機 AI 模型。完整多軌 DAW 與人聲漂移修復仍依階段開發，見 [進度](docs/DAW_PROGRESS.md)。

> 載入音檔 → A/B/C/D 快照對比 → 調整處理鏈 → 量測響度 → 輸出 WAV / MP3。

**Live demo：** [yung13yubabie.github.io/waveforge](https://yung13yubabie.github.io/waveforge/)

---

## 功能矩陣（誠實狀態表）

| 功能 | 前端狀態 | 後端需求 | 未設定後端時的行為 |
|------|---------|---------|------------------|
| **核心母帶處理**（EQ/壓縮/限制器/量測/輸出） | ✅ 完整可用 | 無 | 完整可用 |
| **批量上傳 + 專輯序列** | ✅ 完整可用 | 無 | 完整可用 |
| **WAV / MP3 輸出**（44.1/48/96kHz） | ✅ 完整可用 | 無 | 完整可用（MP3 上限 48kHz） |
| **AI 分軌（Demucs 4 軌）** | ✅ 前端完成 | `VITE_HF_ENDPOINT`（HF Spaces + Gradio `separate` API） | **示範模式**：5 秒模擬 + 明確標示，不會真實分軌；Bounce 被阻擋 |
| **防盜偵測（ACRCloud 掃描）** | ✅ 前端完成 | Supabase（Auth+DB+Edge Function）+ ACRCloud 帳號 | **訪客模式**：掃描回傳明確標示的 Demo 資料 |
| **帳號登入 / Google OAuth** | ✅ 前端完成 | Supabase + Google Cloud OAuth 設定 | 登入按鈕標示不可用，modal 顯示設定指引 |
| **作品音訊指紋** | ⚠️ **未實作** | ACRCloud custom fingerprint API | 顯示「已建立作品記錄」（誠實文案，不宣稱指紋存在） |
| **曲風偵測** | ❌ **未實作** | ML 後端 | 顯示「—」（需後端 AI 分析） |
| **URL 版權查詢**（oEmbed 元資料） | ✅ 完整可用 | 無 | 完整可用（SUNO 無公開 API，明示不支援） |

後端設定範例見 [`.env.example`](.env.example)；Supabase schema 見 [`supabase/migrations/`](supabase/migrations/)。

---

## 快速開始

```bash
npm install
npm run dev        # http://localhost:5173/
```

| 指令 | 用途 |
|------|------|
| `npm run dev` | 開發模式（HMR） |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | 預覽 production build |
| `npm test` | 單元測試（Vitest） |
| `npm run verify` | 完整驗證（test + build） |
| `npm run test:e2e` | Playwright smoke test（需 `npx playwright install chromium`） |
| `npm run test:coverage` | 覆蓋率報告 |

---

## 功能

### 處理鏈
| 模組 | 說明 |
|------|------|
| HP / LP | 高通 / 低通濾波 |
| 10-band EQ | 10-band biquad EQ（32 Hz–16 kHz），匯出可選線性相位 FIR |
| Dynamic EQ | 動態頻段增益（AudioWorklet） |
| M/S | 中側矩陣（寬度、Mid/Side 獨立增益） |
| De-esser | 單頻段 de-esser（AudioWorklet） |
| 3-band MBC | 三頻多頻壓縮（低/中/高，平行壓縮 Mix 旋鈕） |
| Saturator | tape / tube / clip 三種曲線，wet/dry |
| Limiter | 磚牆限制器（ceiling + input gain + release） |

### 量測
- **LUFS**：Integrated / Short-term / Momentary（ITU-R BS.1770-4）
- **True Peak**：4× oversampling inter-sample peak
- **GR Meter**：即時增益縮減顯示
- 頻譜、向量表（Goniometer）、響度歷程圖

### 工作流程
- **A/B/C/D 快照**：A=原始 bypass、B=處理後、C/D=自存快照（Shift+click 清除）
- **100 步 Undo / Redo**
- **39 個母帶預設**：Streaming −14/−16、YouTube、Spotify、CD 等
- **用戶自存預設**（localStorage）
- **專輯序列**：多曲拖排、ISRC 欄位、per-track 響度微調、CD gap、CD Master Package（WAV+CUE+MD5 ZIP，非 DDP 2.00）

---

## ⚠️ 已知限制

| 項目 | 真實狀況 |
|------|---------|
| **曲風偵測** | **尚未實作**，需要 ML 後端服務。UI 顯示「—」。 |
| **作品音訊指紋** | **尚未實作** ACRCloud custom fingerprint 上傳。上傳作品只建立記錄，UI 誠實顯示「已建立作品記錄」。 |
| **即時 Peak Limiter** | 使用 `DynamicsCompressor`（ratio=20），控數位峰值；**不保證** inter-sample peak 不超 ceiling。輸出時可勾選「真 True-Peak 限幅」（4× oversampled 離線限制器）保證檔案 ISP ≤ ceiling。 |
| **BPM / Key 分析** | 只分析前 45 秒（BPM）/ 30 秒（Key）。長前奏曲目結果可能不代表全曲。 |
| **來源位元率偵測** | 以「檔案大小 ÷ 時長」估算，VBR 檔案顯示的是平均位元率。 |

已**正確實作並驗證**：LUFS（BS.1770-4 兩段式 gating）、True Peak（4× oversampling）、24-bit WAV 編碼、共享即時／匯出處理圖。

---

## 架構

```
index.html          單頁 UI（處理鏈卡片、量表、transport）
src/
├── js/
│   ├── main.js              app 接線：載檔、旋鈕→引擎、快照、預設、export
│   ├── presets.js           39 個母帶預設
│   ├── history.js           Undo/Redo（100 步線性堆疊）
│   ├── album.js             專輯序列資料模型
│   ├── audio/
│   │   ├── engine.js        Web Audio 圖：建構、A/B、所有 DSP 節點
│   │   ├── lufs-worklet.js  AudioWorklet：BS.1770-4 LUFS + 4× true peak
│   │   ├── dynamics-worklet.js  AudioWorklet：De-esser + Dynamic EQ
│   │   ├── render-chain.js  OfflineAudioContext 離線渲染
│   │   └── analyze.js       離線 BPM / Key 偵測
│   └── ui/
│       ├── knob.js          可拖曳旋鈕（SVG arc）
│       ├── eq-canvas.js     EQ 頻率響應曲線
│       ├── spectrum.js      即時頻譜（FFT）
│       └── stems.js         音軌面板（第二期）
└── css/  tokens.css / reset.css / layout.css
```

### 即時處理鏈（engine.js）

```
source → HP/LP → 10-band EQ → Dynamic EQ → M/S
       → De-esser → MBC in ──┬── 3-band compress → makeup ─┐（wet）
                   └── dry tap ──────────────────────────────┤（parallel mix）
                                                             └→ Saturator → limInput → Limiter
                                                                          → processedGain ─┐
source → bypassGain ──────────────────────────────────────────────────────────────────────┤（A/B）
                                                                                           └→ outputGain → LUFS worklet → destination
```

### Export

`OfflineAudioContext` 是非即時計算匯出音檔的 Web API，與網站能否離線使用無關。播放與匯出使用同一份 `processing-graph.js`。Dynamic EQ / De-esser 離線載入失敗時**拒絕輸出並提示**，不會默默輸出少了模組的音訊。

---

## 技術棧

Vite 8 · vanilla JS ES2022 · Web Audio API（AudioWorklet）· WaveSurfer.js 7 · Vitest 4

---

## 後端設定指南

> 📖 **完整申請流程（ACRCloud / Spotify / HF Space / GitHub Secrets 逐步教學）見 [docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**

### HF Spaces（AI 分軌）
1. 部署一個 Demucs Gradio Space（需暴露 `api_name="separate"` 端點，輸入音檔、輸出 vocals/drums/bass/other 四軌）
2. `.env` 填入 `VITE_HF_ENDPOINT=https://your-space.hf.space`
3. 限制：單檔 ≤ 50MB，推論 timeout 10 分鐘

### Supabase（帳號 + 防盜偵測）
1. 建立 Supabase 專案，在 Dashboard SQL Editor **依序**執行 `supabase/migrations/001_init.sql`（建表）→ `002_harden_schema.sql`（強化）。順序不能顛倒 — 002 是對 001 建立的表做增量修改，先跑 002 會報 `relation "user_settings" does not exist`。兩個腳本都可安全重跑（idempotent）。
2. 部署 Edge Function：`supabase functions deploy acr-scan`
3. Google 登入：Supabase Dashboard → Authentication → Providers → Google，填入 Google Cloud OAuth Client ID/Secret
4. Email 通知（可選）：Edge Function Secrets 設定 `RESEND_API_KEY`
5. `.env` 填入 `VITE_SUPABASE_URL` 與 `VITE_SUPABASE_ANON_KEY`（anon key 是公開的，**絕不要**把 service role key 放進前端）

### 安全原則
- ACRCloud Secret 只存在 Supabase `user_settings`（RLS 保護）；訪客模式只在記憶體，不寫入 localStorage
- 所有資料表有 RLS：使用者只能讀寫自己的資料
- Edge Function 驗證 JWT + work 所有權後才寫入掃描結果

## 未來規劃

- ACRCloud custom fingerprint 上傳（真實作品指紋）
- 曲風 AI 分析（需 ML 後端）

## Phase 0 更新

- MBC Mix 與真旁路共用 graph，啟用中的效果器不可靜默跳過。
- 44.1/48/96kHz FIR 使用目標採樣率；單曲、專輯、最終預覽共用 `final-render.js`。
- 展開「最終母帶預覽與輸出報告」可產生前 10/30 秒或選取範圍，A/B 原始／最終 PCM。主播放器仍是低延遲即時監聽。MP3 編碼不包含在此 PCM 預覽，報告明示編碼前量測。
- 分軌母帶可匯入既有 vocals/drums/bass/other（或中文名稱）四軌，同步試聽 EQ／壓縮／Pan／音量，再 Bounce。超峰值阻擋送入整數 WAV，需降音量或自行勾選 Normalize Bounce。
- [音訊稽核及限制](docs/DAW_ARCHITECTURE_AUDIT.md)、[人聲漂移偵測設計](docs/VOCAL_DRIFT_ARCHITECTURE.md)。偵測模型及修復模型尚未接入。
- `npm run lint` 執行 JavaScript 語法檢查；`npm run test:e2e -- --workers=1` 驗證真實瀏覽器音訊及使用者操作；build 後執行 `npm run test:production` 驗證實際 dist。建置輸出是網站 `dist/`，不產生離線安裝包。
