# WaveForge 漸進式架構

產品方向：線上 Web DAW。前端負責互動與播放／匯出；外部 worker 執行耗時 AI。Native / 本機模型不是此次要求。

- `processing-graph.js`：唯一核心母帶建圖定義；AudioEngine 的參數 setter 修改該圖，render-chain 使用同圖的快照。
- `render-chain.js`：target-rate resample、可選 FIR、核心 graph render。
- `final-render.js`：核心渲染後 watermark → true-peak → measurements；單曲、專輯、Final Render Preview 共用。
- `stem-mix.js`：共享 stem EQ/comp/pan/gain graph；sum 不改 gain；normalize 是明確命令。
- `stems-mastering.js`：4 軌同步 preview、雲端分軌或現有素材匯入、Bounce。
- 現有 `album.js`、`history.js`、`user-presets.js` 保留，尚不等同完整 Project。

下一階段才新增 versioned Project/Track/Clip/AssetManager。以 adapter 將現有 buffer 納入第一個 audio track，master graph 納入 master bus；先保留舊 UI 工作路徑，測 save/reload、undo/revert、asset lifecycle，再替換 transport/timeline。每個遷移需可回退及真實匯出驗證。

詳見 [稽核](DAW_ARCHITECTURE_AUDIT.md)、[人聲偵測設計](VOCAL_DRIFT_ARCHITECTURE.md)、[進度](DAW_PROGRESS.md)。
