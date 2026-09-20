# Updated audit (2026-09-20)

The [new checkpoint](AUDIO_TRUST_CHECKPOINT_2026-09-20.md) supersedes the historical findings below: WAV now retains source rate, monitoring is separate, snapshot schema is v2, and the legacy stem UI is removed. Full DAW acceptance remains IN PROGRESS.

# WaveForge 音訊架構稽核

本輪範圍：Master Prompt §60 的 Phase 0 與人聲偵測架構。產品是線上網頁服務；`OfflineAudioContext` 指非即時匯出計算，不代表離線 App。既有 `src/css/layout.css` 工作區修改保留。

## 現況與資料生命週期

`index.html` + `main.js` 是 Vite/vanilla JS 單頁工作站。檔案透過 File API 讀入，主引擎在 48 kHz 解碼成 RAM 中的 AudioBuffer；WaveSurfer 顯示波形，實際母帶播放由 AudioEngine 負責。Source node 每次播放重建。stop/seek 使用 generation 避免舊 onended 改寫播放狀態。

主引擎仍是一首歌的 buffer，沒有 Project/Track/Clip session。transport 有 play/pause/stop/seek/full-song loop；裁剪 selection 影響匯出，不是完整 musical transport。尚無 sample transport、tempo map、錄音、MIDI。

`serialize()` 的 version 1 保存參數、bypass、A/B。History 保存最多 100 份參數快照；不是素材或分軌編輯的 undo。user-presets 將命名快照寫 localStorage；損毀讀取回空集合、寫入失敗回 false，由 UI 提示。Album 的 File 和快照只在記憶體，離頁警告不等於 autosave。尚無 project save/reload、asset relink、crash recovery。

## 原問題、風險與遷移

| 已確認問題 | 音訊／資料後果 | 本輪處理 |
|---|---|---|
| engine 與 render-chain 分別建圖，匯出缺 MBC Mix | 匯出與試聽不同 | 抽出 `processing-graph.js`，兩端共用 |
| comp bypass 只把 ratio 改 1 | makeup 未清除，仍走有延遲的壓縮器 | bypass 使用乾聲路徑，makeup unity，Mix 修改不得解除 bypass |
| enabled dynamics 但 unavailable 時被跳過 | 少效果器仍成功輸出 | 拒絕渲染，要求明確旁路 |
| 單曲 FIR 取 live 48 kHz response | 非 48 kHz 輸出頻率響應不可信 | 目標 rate 設計，先 resample 再 FIR；單曲／專輯共用 final-render |
| stem controls 只記錄參數 | 音樂人無法聽到 EQ／壓縮調整 | 共用 createStemGraph，4 source 同 AudioContext 排程 |
| mixBuffers 隱式 normalize | 音量與動態被偷偷改動 | 保留 float overload；Bounce 顯示錯誤或明確 Normalize Bounce |
| watermark 在 final limiter 前截波 | 削波失真已無法由 limiter 還原 | 保留 float headroom，交給 final limiter／輸出警告 |
| 報告固定 48kHz | 檔案規格誤導 | 實際 rate、format、duration、peak、效果選項與 trim |
| 專輯只有核心 chain | 忽略 final watermark／true peak | album 也經 final-render |

迁移採抽取現有 graph，不改演算法參數意義，不整體改寫 UI。母帶、專輯、防盜既有入口保留。

## Graph 與一致性矩陣

Realtime：source → HP/LP → 10 EQ → Dynamic EQ → M/S → De-esser → 3-band MBC + makeup / dry blend → saturation blend → limiter input → native limiter → master gain → analyser/LUFS → destination。原始 A 路徑繞過處理，但保留 master gain。

Export：trim（若選取）→ target-rate resample + FIR（若開啟）→ 同一核心 graph（FIR 開啟則 biquad EQ flat）→ watermark → final true-peak → measure → WAV/MP3。

| Module | Realtime | Export | 一致性／限制 |
|---|---|---|---|
| HP/LP | native biquads | 同 graph | 同率一致；HP bypass 仍是 1 Hz filter，非零延遲 identity wire |
| EQ | minimum-phase biquads | 同 graph 或 FIR | 普通 EQ 一致；FIR 是刻意的 phase 差異，以最終預覽檢查 |
| Dynamic EQ | dynamics-worklet | 同 processor | 模組缺失不得無聲 fallback |
| M/S | stereo encode/decode + bypass | 同 graph | mono 先 upmix；anti-phase 有測試 |
| De-esser | dynamics-worklet | 同 processor | 同率一致 |
| MBC / Mix / Makeup | 3 bands + wet/dry | 同 graph | 0/25/50/75/100；bypass 乾聲；端點及線性混合獨立 oracle |
| Saturation | WaveShaper 4x + dry/wet | 同 graph | 同率一致 |
| Limiter / input | native compressor ratio 20 | 同 graph | 不是 brickwall true-peak；ratio 1 bypass 仍有 native lookahead，input gain 保留 |
| Master Gain | both A/B | processed export | export 始終處理後，監聽 A 時提醒 |
| Linear Phase | 不套用 | target-rate FIR | 最終預覽提供實際結果 |
| True Peak | meter，native peak compression | 可選 final truePeakLimit | 不將量測一致性等同硬體／所有 codec 保證 |
| Watermark | 無 | 可選 PN 嵌入 | 預覽包含；不是強版權保障 |
| Stem DSP | shared stem graph | 同 graph + mix | 獨立試聽入口；WaveSurfer 僅視覺 |

Stem：4 buffers → 各自 EQ/comp/pan/gain → shared bus → output；Bounce 各軌同 graph 渲染→sum→明確 normalize 或 overload 阻擋→24-bit WAV→主母帶。匯入既有四軌可完整驗證，不依賴 Demucs 部署。

Album：每曲來源 File→44.1k 解碼→曲目 snapshot（gain trim 進 limInput）→final-render→588-sample CD frame assembly→16-bit TPDF WAV+CUE+MD5→store-only ZIP。這是 **CD Master Package**，不是 DDP 2.00。

## 正規化、fallback、sample rate 檢查

- waveform 的 `normalize: true` 只縮放繪圖；不是音訊 normalize。
- `mixBuffers` 原有 peak normalize 已移除；新 Normalize Bounce 為使用者明確選項，產生新 buffer。
- WAV/MP3 最終整數編碼仍有 full-scale clamp；報告呈現編碼前 overload，MP3 顯示編碼前量測，不能聲稱編碼後 true peak 相同。
- 16-bit WAV 的 TPDF 是隨機的，byte equality 不適用；PCM graph 測試在編碼前比較。
- Demucs 無設定時為已標示的 demo，不能 Bounce；訪客版權偵測也是 demo。HF Gradio route 的版本 fallback 是 endpoint 相容性，不是替代音訊處理。
- 固定 48k 主解碼、CD 44.1k、MP3 ≤48k、FIR FFT_N=4096、worklet 全域 sampleRate、LUFS K weighting、true-peak attack/release、trim sample rounding 都有 rate 相依。
- waveform/音訊 buffer 及 final preview 都使用 RAM。preview 為確保 limiter context 與浮水印對齊，先 render 完整匯出範圍再取前 10/30 秒或 selection；長曲會耗時和記憶體。

## 測試與尚未證實事項

`tests/audio/render-parity/signals.js`：impulse、100/1k/10k sine、multitone、deterministic noise、transient、stereo correlated/antiphase。Playwright 15 states × 9 signals，比較 peak/RMS residual、LUFS、peak dB、FFT magnitude，另有 MBC dry/original 與 affine blend oracle、三 rates FIR 測試。這是瀏覽器相容 realtime graph 的決定性渲染；不證明音效裝置、OS latency、跨瀏覽器或長時間 dropout。

現有 hf-space 為外部 Demucs 工作端；supabase 提供 auth、作品記錄、掃描等，不能當成已實作 DAW project 或 vocal inference API。未部署／呼叫使用者的雲端帳號。真實歌唱聽測、GPU model、長曲壓力測試、persistent projects、sample-accurate plugin PDC 尚未完成。

Web/native boundary：目前僅 Web。依使用者線上產品方向，不新增 native shell、VST host 或本機模型依賴。未來另案決策。

文件依據：Context Hub 查詢無匹配且沒有 docs_mcp，改讀 [W3C Web Audio](https://www.w3.org/TR/webaudio/)。實作版本與 API 以現有 lockfile 和 repo 為準。
