# WaveForge

瀏覽器端母帶處理 DAW（mastering DAW）。純前端 Web Audio API + Vite + vanilla JS + WaveSurfer.js v7，無建置後端即可運作。

> 載入音檔 → 即時聽 A（原始）/ B（母帶處理後）→ 調整處理鏈 → 量測響度 → 輸出 24-bit WAV。

---

## 快速開始

```bash
npm install
npm run dev        # http://localhost:5173/
```

**存取密碼**：`waveforge-dev`（或設環境變數 `VITE_ACCESS_PASSWORD`）。
登入一次後同分頁 `sessionStorage` 會記住，重整不需再輸入。

| 指令 | 用途 |
|------|------|
| `npm run dev` | 開發模式（HMR 熱更新） |
| `npm run build` / `npm run preview` | production build / 預覽 |
| `npm test` | 跑全部單元測試（vitest） |
| `npm run test:ui` | 瀏覽器測試介面 |
| `npm run test:coverage` | 覆蓋率報告 |

---

## ⚠️ 已知限制（誠實聲明 — 不要誤把「能跑」當「完整」）

| 項目 | 真實狀況 |
|------|---------|
| **存取密碼** | **不是真正的存取控制**。密碼在 build 時內嵌進前端 bundle，DevTools 可讀；`sessionStorage.wf_auth=1` 可手動繞過；lockout 是純前端記憶體，重整即重置。只擋路人，不擋攻擊者。要真保護需後端驗證。 |
| **曲風偵測** | 顯示「AI 後端」= **尚未實作**，需要 ML 後端服務。不是已完成功能。 |
| **音軌分離（Stems）** | 標示「第二期」= **尚未實作**，需 GPU 後端（Demucs）。 |
| **IRC Limiter 模式** | 停用 = 瀏覽器 `DynamicsCompressor` 無法實作，需後端離線渲染。 |
| **Peak Limiter** | 輸出限幅器是 `DynamicsCompressor`（ratio=20），只控**數位峰值**，**不是** ITU-R true-peak 限制——無法保證 inter-sample peak 不超過 ceiling。True Peak **量測**（響度計）才是真的 4× oversampling。量測是真的，限制不是。 |
| **BPM / Key 分析** | 真實演算法（自相關 / Krumhansl-Schmuckler），但**只分析前 45 秒（BPM）/ 30 秒（Key）**。長前奏曲目結果可能不代表全曲。confidence 值為訊號推導，非裝飾。 |
| **分析窗** | 同上，非全曲掃描。 |

已**正確實作**且驗證的部分：LUFS（BS.1770-4 兩段式 gating）、True Peak（4× oversampling inter-sample peak）、24-bit WAV 編碼、即時/離線處理鏈鏡像。

---

## 架構

```
index.html  ── 單頁 UI（處理鏈卡片、量表、transport）
src/
├── js/
│   ├── main.js              app 接線：載檔、旋鈕→引擎、A/B、預設、export
│   ├── auth.js              密碼門（見上方限制聲明）
│   ├── presets.js           39 個母帶預設
│   ├── audio/
│   │   ├── engine.js        Web Audio 圖：建構、播放、A/B、所有 DSP 節點
│   │   ├── lufs-worklet.js  AudioWorklet：BS.1770-4 LUFS + 4× true peak
│   │   ├── dynamics-worklet.js  AudioWorklet：De-esser + Dynamic EQ
│   │   └── analyze.js       離線 BPM / Key 偵測
│   └── ui/
│       ├── knob.js          可拖曳旋鈕
│       ├── eq-canvas.js     EQ 頻率響應曲線
│       ├── spectrum.js      即時頻譜
│       └── stems.js         音軌面板（第二期）
└── css/  tokens.css / reset.css / layout.css
```

### 即時處理鏈順序（engine.js `_buildGraph`）

```
source → inputGain → HP → LP → 10-band EQ → Dynamic EQ → M/S 矩陣
       → De-esser → Compressor → makeup → Saturator(dry/wet)
       → limInput → Limiter → processedGain ┐
source → bypassGain ───────────────────────┤(A/B crossfade)
                                            └→ outputGain → analyser → lufsNode → destination
```

**A/B 是排他的**：A 聽 `bypassGain`（原始）、B 聽 `processedGain`（處理後），任一時刻只有一條路徑出聲。WaveSurfer 僅作視覺時鐘（已靜音），所有可聽音訊由 engine 輸出。

### Export

`OfflineAudioContext` 離線渲染，**完整鏡像即時鏈**（含所有 bypass 狀態與 worklet 模組）。若 Dynamic EQ / De-esser 啟用但離線 worklet 載入失敗，**拒絕輸出並提示**，不會默默輸出少了模組的音訊。

---

## AudioWorklet 注意事項

- worklet 檔（`*-worklet.js`）以 `?url` import，Vite 輸出為**未打包的獨立 asset**。
- 因此 worklet 內**不可 import**，必須自我包含；其 DSP 數學在 `tests/audio/*.test.js` 以鏡像純函式測試（worklet processor 本身不在 jsdom 執行）。
- dynamics worklet 為**選配**：載入失敗時引擎照常運作，De-esser / Dynamic EQ 兩張卡片自動停用。

---

## 測試

```bash
npm test
```

- `tests/audio/lufs.test.js` — LUFS 數學、K-weighting、BS.1770-4 gating
- `tests/audio/truepeak.test.js` — 4× oversampling inter-sample peak
- `tests/audio/dynamics.test.js` — De-esser / Dynamic EQ / M/S 矩陣數學
- `tests/audio/analyze.test.js` — BPM / Key 偵測
- `tests/audio/chain.test.js` — 預設完整性、WAV 編碼
- `tests/audio/engine.test.js` — 引擎整合、播放/seek race、A/B 排他性

E2E（Playwright，手動跑）：見 `tests/fixtures/` 與專案內 node 腳本。

---

## 技術棧

Vite 6 · vanilla JS（ES2022 modules）· Web Audio API（AudioWorklet）· WaveSurfer.js 7 · Vitest（jsdom）
