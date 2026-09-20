# Current checkpoint (2026-09-20)

See [controls, stems and Audio Trust repairs](AUDIO_TRUST_CHECKPOINT_2026-09-20.md). The Full DAW All-In specification supersedes the earlier scope below. Phase A remains IN PROGRESS; earlier DONE labels refer to the previous limited milestone and do not satisfy the new production-ready criteria. Baseline 777a30f was deployed to GitHub Pages after that milestone.

# WaveForge 進度

本輪按照兩份 prompt 的「第一輪實際任務」執行。使用者補充：產品維持線上網頁，不做離線 App／安裝包／本機模型要求。

| 工作 | 狀態 | 交付 |
|---|---|---|
| 現有音訊架構 audit + parity matrix | DONE | DAW_ARCHITECTURE_AUDIT.md |
| 共用 realtime / export graph | DONE | processing-graph.js |
| MBC Mix、true bypass、bypass 期間參數還原 | DONE | engine + regression tests |
| 已啟用但不可用的 dynamics 不可靜默輸出 | DONE | render-chain 拒絕 |
| target-rate FIR，44.1/48/96kHz | DONE | resample 後處理，瀏覽器 response tests |
| 最終 PCM 預覽／原始 A/B／10秒、30秒、selection | DONE | 同 final-render，快照式預覽與下載 |
| 分軌 EQ/comp/pan/gain 即時試聽與 Bounce | DONE | 同 stem graph；支援中文檔名四軌匯入 |
| hidden peak normalization / watermark clipping | DONE | float headroom；Normalize Bounce 明確 opt-in |
| Export report 實際規格 | DONE | rate、format、depth/kbps、duration、LUFS、peaks、clip、trim、效果開關 |
| Album final watermark/true peak + 正確命名 | DONE | CD Master Package，非 DDP 2.00 |
| Render parity harness | DONE | 135 signal/state combinations + MBC oracle + FIR rates |
| Vocal Drift Analyzer 架構 | DONE（設計） | VOCAL_DRIFT_ARCHITECTURE.md；沒有模型實作 |
| 完整 regression / user-path / production smoke | DONE | 470 unit、29 E2E、8 production smoke |
| Project/Track/Clip/timeline/save/autosave | DEFERRED | 後續 Phase 1 |
| MIDI/instruments/automation/recording | DEFERRED | 本輪明確禁止先做 MIDI/VST |
| Vocal detection model / heatmap / DSP/SVC repair | DEFERRED | 候選模型未選型，真實授權歌唱資料待提供 |
| Native/VST | DEFERRED | 線上產品，本輪不新增 native dependency |

## 驗證範圍與限制

- build 是網站 dist，不是離線軟體打包；不含部署到線上站點。
- lint 為 92 個 JS 檔案的 Node syntax check，不宣稱完整 ESLint/style audit。
- 單元測試：36 files / 470 tests 已通過。
- Browser parity 是 Chromium 的 realtime-compatible graph 與 export；不包含硬體音效裝置、長時間 dropout 或跨瀏覽器認證。
- 預覽是 24-bit PCM 母帶快照，不模擬 MP3 codec 或 16-bit 隨機 dither；設定改變需要重新產生。
- 原始音檔不覆寫；完整 project persistence／stem undo／vocal repair take 尚未實作，不宣稱 production-ready full DAW。
- 線上 Demucs、Supabase、ACRCloud 和 GPU 模型未使用實際帳號執行；本輪只驗證現有四軌匯入與網站處理流程。
- 建置有單一主 chunk >500 kB 提示，未調高 warning threshold 隱藏。

## 驗證結果

最終依序執行：

1. `npm run build`：通過，網站 `dist/`（9 檔案，約 715 KB）。
2. `npm run lint`：92 個 JS 語法檢查通過。
3. `npm test`：36 test files，470 tests 通過。
4. `npm run test:e2e -- --workers=1`：29 tests 通過，包含 135 signal/state 組合。
5. `npm run test:production`：對實際 dist 的 8 tests 通過；未依賴開發版 debug globals。
6. Playwright screenshot：已檢查 final preview 與 stem cards；修正預覽遮擋操作及卡片高度被壓縮問題。
7. `git diff --check`：通過。原有 layout.css 修改未被覆蓋。

Final preview user-path 會下載預覽 WAV 與正式 96kHz/24-bit WAV，直接比較完整 bytes；中文檔名四軌經匯入、live controls、Bounce、實際下載檢查。兩項流程也要求沒有 pageerror。Smoke 同時保留未設定雲端服務時的 demo／禁用提示驗證。

本輪為網站原始碼與建置產物交付，沒有提交 commit、推送或部署。MIDI、VST、AI 偵測和修復未宣稱完成。

## 修復前失敗證據

- stem sum 預期 1.6，實際 1.0；負值預期 -1.5，實際 -1.0（隱式 normalization）。
- comp bypass makeup 預期 unity，實際最後設定 3.9810717（12dB）；旁路期間更新 threshold 後啟用沒有套用新值。
- enabled-but-unavailable Dynamic EQ 預期 reject，實際 resolve 音檔。
- 96kHz WAV header 正確，但 UI 顯示 24bit/48kHz。
- watermark 輸入 1.2 的 float samples 被截為最大 1.0。
- 新預覽面板第一版被 waveform-toolbar 攔截點擊；已修成浮動預覽。
- 四軌卡片原量測高度 146.7547px，導致控制項被裁掉；回歸要求 >330px，現保留最小 350px 並在列表捲動。
