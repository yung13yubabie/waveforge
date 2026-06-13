# WaveForge — HANDOFF

> 交接文件。新 session 先讀這份 + `README.md`。最後更新：2026-06-13。

## 一句話現況
瀏覽器母帶 DAW（Web Audio + Vite + vanilla JS + WaveSurfer v7）。第一～四期完成，**174/174 測試綠、production build 成功、E2E 全過**。卡在「第二期需後端」需使用者決定雲端平台。

---

## 如何跑
```bash
npm install
npm run dev            # http://localhost:5173/  密碼 waveforge-dev
npm test               # vitest 174 tests
npm run build          # production build
npm run preview        # 跑正式版（測 ?url worklet / base path 用）
```
- E2E：用 Playwright（firefox）+ `tests/fixtures/*.wav`，手動 node 腳本跑（本 session 多次使用，非 CI）。
- bypass auth：`sessionStorage.setItem('wf_auth','1')` 後 reload。
- DEV-only 把手：`window.__wf = { ws, engine }`（`import.meta.env.DEV` 守衛，prod 不洩漏）。

## 架構速查
```
index.html               單頁 UI（9 模組卡片、響度計、相位相關儀、transport）
src/js/main.js           接線：載檔、旋鈕→engine、A/B、preset、export+報告、GR/相關性儀
src/js/auth.js           密碼門（前端劇場，非真存取控制）
src/js/audio/
  engine.js              Web Audio 圖、播放/seek、A/B、所有 DSP 節點、getCorrelation()
  lufs-worklet.js        BS.1770-4 LUFS + 4× oversampled true peak
  dynamics-worklet.js    De-esser + DynEQ（含 GR telemetry + bypass crossfade）
  analyze.js             離線 BPM/Key
  measure.js             export 報告：integrated LUFS / true peak / clip / correlation
src/js/ui/               knob.js(含鍵盤a11y) eq-canvas spectrum stems
tests/audio/*  tests/ui/knob.test.js  tests/setup.js(Web Audio mock)
```
即時鏈順序（engine `_buildGraph`）= export 鏈順序（main.js OfflineAudioContext），務必保持一致：
`src → inputGain → HP → LP → 10-EQ → DynEQ → M/S → De-esser → Comp → makeup → Sat → limInput → Limiter → A/B → outputGain → analyser/corr/lufs → dest`

---

## 本 session（第三+四期）做了什麼
- **第三期**：De-esser/DynEQ 即時 GR 量表（worklet postMessage→`engine.onGR`→UI 彩色條）；export 母帶報告（measure.js 量測實際渲染輸出，status 顯示 LUFS+TruePeak+削波警告）。
- **第四期**：worklet bypass 10ms crossfade（消點擊）；M/S 中性 unity 釘住；knob 鍵盤無障礙（role=slider/方向鍵/Home/End）；立體聲相位相關儀（M/S 安全網，反相紅警告）；MBC 標籤誠實化（單頻段→「Compressor」）；`.env.example`。
- **先前修過**：filename XSS（textContent）、export `?url` 改靜態 import（prod 故障）、Firefox 下載、`base:'./'`、True Peak 真 4× oversampling、DynEQ 改並聯架構（消 click/zipper）、decode 30s 逾時、seek race（onended 身分檢查）、A/B 排他（WaveSurfer 靜音）。

## 誠實未做/deferred（非缺陷或大工程）
- **De-esser RMS 偵測**：實測單極 RMS 對單樣本脈衝反而更敏感（sqrt 放大），會 regress → 需 look-ahead/滑動窗，deferred。勿盲改。
- worklet processor 本體不在 jsdom 跑（只測鏡像純函式，有漂移風險）。
- BPM/Key 只分析前 45s/30s；曲風「AI 後端」未實作。

---

## 下一步（依優先序）

### A. 第五期 ✅ 完成（4/4）
1. ✅ **真‧多頻段壓縮**：engine 3 頻段減法式分頻 + 每頻段 comp + UI；export 鏡像。
2. ✅ **16-bit export + TPDF dither**：`src/js/audio/wav.js`（純函式可測），header 選擇器。
3. ✅ **linear-phase EQ（輸出時套用）**：`fft.js` + `lin-phase-eq.js`；export 預卷積、biquad 設平；realtime 仍 biquad（誠實標示）。
4. ✅ **參考曲匹配**：`match-eq.js`（averageSpectrum + computeMatchCurve，空頻帶防護）；EQ 模組「⊕ 參考曲匹配」鈕→寫入 10 段 EQ + 報告響度差。

下一步唯一剩 **B. 第二期需後端**（卡使用者雲端決策，見下）。

### B. 第二期需外部（**卡使用者決策，勿臆測蓋後端**）
| 項目 | 需使用者提供 |
|------|------------|
| Demucs 音軌分離 | GPU 平台（Modal/Replicate/自架）+ 帳號 |
| 曲風 AI 分析 | ML 推論服務 |
| 真存取控制 / IRC limiter | 後端 host（Vercel/Railway）|

前端已備 `VITE_BACKEND_URL` 介面點、`base:'./'`、`.env.example`。**決定平台後**才接 API。

---

## ⚠️ 接手注意
- 改 DSP（worklet）必須同步改 `tests/audio/*.test.js` 的鏡像純函式，否則測試與實作漂移。
- 改即時鏈順序必須同步改 export 鏈（main.js ~line 740-880）。
- 其他 AI 報告需獨立驗證（本 session 已駁回 2 個誤報：「WAV 負樣本損壞」「M/S 矩陣損壞」，實測皆正確）。
- 詳細狀態另見 memory `project_waveforge.md`。
