# WaveForge

瀏覽器端母帶處理 DAW。純前端 Web Audio API，無需後端即可運作。

> 載入音檔 → A/B/C/D 快照對比 → 調整處理鏈 → 量測響度 → 輸出 24-bit WAV。

**Live demo：** [waveforge.pages.dev](https://waveforge.pages.dev)（即將上線）

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
| `npm test` | 單元測試（Vitest，324 tests） |
| `npm run test:coverage` | 覆蓋率報告 |

---

## 功能

### 處理鏈
| 模組 | 說明 |
|------|------|
| HP / LP | 高通 / 低通濾波 |
| 10-band EQ | 線性相位圖形 EQ（80 Hz–16 kHz） |
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
- **專輯序列**：多曲拖排、ISRC 欄位、per-track 響度微調、CD gap、DDP 輸出

---

## ⚠️ 已知限制

| 項目 | 真實狀況 |
|------|---------|
| **曲風偵測** | 顯示「AI 後端」= **尚未實作**，需要 ML 後端服務。 |
| **音軌分離（Stems）** | 標示「第二期」= **尚未實作**，需 GPU 後端（Demucs）。 |
| **Peak Limiter** | 使用 `DynamicsCompressor`（ratio=20），控數位峰值；**不保證** inter-sample peak 不超 ceiling。True Peak **量測**是 4× oversampling，**限制**不是。 |
| **BPM / Key 分析** | 只分析前 45 秒（BPM）/ 30 秒（Key）。長前奏曲目結果可能不代表全曲。 |

已**正確實作並驗證**：LUFS（BS.1770-4 兩段式 gating）、True Peak（4× oversampling）、24-bit WAV 編碼、即時/離線處理鏈鏡像。

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

`OfflineAudioContext` 離線渲染，完整鏡像即時鏈（含所有 bypass 狀態與 worklet）。Dynamic EQ / De-esser 離線載入失敗時**拒絕輸出並提示**，不會默默輸出少了模組的音訊。

---

## 技術棧

Vite 8 · vanilla JS ES2022 · Web Audio API（AudioWorklet）· WaveSurfer.js 7 · Vitest 4

---

## Phase 2 規劃

- Demucs 音軌分離（需 GPU 後端：Modal / Replicate）
- 曲風 / BPM AI 分析（需 ML 後端）
- 真正的存取控制（Supabase Auth 或 Cloudflare Access）
