# Vocal Drift Analyzer — 第一輪設計

狀態：DESIGN ONLY / DEFERRED implementation。沒有新增假 Repair 按鈕、沒有引入 SVC、沒有聲稱能恢復歌手身份。部署方向是線上服務，AI 工作送雲端 worker，不要求使用者離線運行或下載模型。

## 職責與流程

`VocalDriftAnalyzer` 只產生分析與候選區段；`VocalRepairEngine` 是後續獨立能力。DAW playback 不依賴 inference 成功。

Full mix → 已部署 Demucs worker → immutable original vocal + accompaniment assets。已提供 vocal stem 可跳过 separation。每個 asset 記錄 SHA256、source sample rate/channels/length。分析可 resample，但結果座標必須轉回 source sample index。

1. 建立 user-confirmed reference anchors。
2. VAD / voiced detection 排除 silence、低能量、unvoiced；bleed 與多位歌手降低 confidence。
3. 雲端抽取特徵 → sliding windows → baseline calibration → region merge。
4. 回傳可解釋 drift map，讓使用者 ignore／set reference／review。
5. 後續 repair 每次另產新 asset/take，絕不覆寫來源。

## Reference 與特徵介面

Manual anchors `{id, assetHash, startSample, endSample, register, approved}`，建議 3–10 秒，多個 chest/soft/falsetto/belt/rap anchors。Auto clustering 只能提出候選，最大 cluster 不自動等於正常；混合歌手或錯誤佔多數時尤其需要確認。沒有 approved normal reference 時只標示差異，不能叫恢復。

`FeatureBackend.capabilities()` 列出可用欄位與 model/version/preprocessing。候選 CAMPPlus、ECAPA-TDNN、WavLM-derived embeddings、RMVPE-like F0 都**尚未評估或選型**；正式整合前查官方文件、模型權重 license、可維護性及歌唱 validation。

每窗 0.75–1.5 秒，hop 0.25–0.5 秒，可調整並記錄：

- identity embedding cosine distance：依 register 對應參考；無模型結果就 null，不用 MFCC 假冒身份。
- spectral envelope：MFCC、centroid、slope、rolloff；控制音量及 F0 引起的偏移。
- F0：voiced probability、continuity、octave jumps；F0 anomaly 不能單獨推升 severe identity label。
- harmonic/noise：HNR、CPP-like periodicity、flatness、breath balance；區分效果器與生成瑕疵需人工判讀。
- vibrato：rate/depth/stability，與 register、音符過渡分開；沒有足夠週期不回傳假數字。
- formant-like envelope 只作估計；不能直接推論性別／身份。

以歌曲正常 anchor 的 robust median/MAD 校準各群組，保存校準值和權重。缺 feature 將 score 設 null 並降低 confidence，不能默認零。偵測率需真實資料校準後才有數值意義；UI 不顯示無校準的「82% AI」。

## 區段與狀態契約

```json
{
  "schemaVersion": 1,
  "sourceAssetHash": "sha256",
  "sourceSampleRate": 48000,
  "modelVersion": "unselected",
  "configHash": "sha256",
  "referenceRegions": [],
  "detectedRegions": [
    {
      "id": "region-id", "startSample": 48000, "endSample": 96000,
      "totalScore": null, "confidence": null,
      "typeScores": {"identityDrift": null, "formantDrift": null, "artifactScore": null,
        "pitchAnomaly": null, "vibratoAnomaly": null},
      "nearestReference": null, "reviewState": "unreviewed", "reasons": []
    }
  ],
  "acceptedRepairs": []
}
```

Merge 使用可調 hysteresis、minimum duration、gap threshold；不可跨未發聲區域或不同 reference/register 強行合併。UI 顯示 stable/suspicious/severe/insufficient-data，加文字與原因，不能只靠顏色。時間以 sample 記錄，顯示秒數。

## 雲端工作與 cache

建議 API contract（未實作）：submit job → queued/running/succeeded/failed/cancelled → authenticated status/events → result manifest。job 綁 user、source hash、reference hash、model/preprocess/config；有 timeout、取消、重試及容量上限。server 驗證 asset ownership；音檔只用短效授權 URL，不接受任意外部 URL 讓 worker 抓取。模型和供應商 secret 不進前端。

feature cache key = source hash + model version + preprocessing/sample rate + feature config。score cache 另含 reference hash、weights、thresholds；改 anchor 可重算 score，不必重做 embedding。模型、內容、preprocess 改變必須 invalidate。保存 analysis manifest 到未來 versioned project；目前不能宣稱 reload 保留。

## 後續修復介面與門檻

DSP：局部 spectral envelope/dynamic EQ/de-ess/loudness；不能當作嚴重 identity repair。SVC：`capabilities` / `repairSegment(source, references, f0, timing, config)`；同曲固定 conditioning、model、seed/config，左右 context，僅提交中央範圍。

Take A original / Take B DSP / Take C SVC。逐段 sample-aligned、20–100ms crossfade（依區段長度 clamp）、DC 與 loudness 檢查。report 同時看 timbre、F0 correlation/RMSE、timing、spectral distance、boundary click、LUFS/peak、lyrics/phoneme。任何一項退步不得自動接受；沒有 ASR 或人工歌詞檢查就標 unverified。音色修復不保證修正生成錯字。

## 驗證計畫

synthetic tests：identity/envelope shift、pitch-only、intended falsetto、多 anchor register、metallic artifact、silence/unvoiced、chunk boundary、取消與過期結果、cache invalidation、project save/load；之後再加 repair 音高／時序／歌詞及邊界測試。

`tests/vocal-drift/evaluation-manifest.json` 提供真實資料集類別與預期時間區間欄位，目前沒有素材或分數。需使用自有或授權歌唱素材，逐曲標註 false-positive rate、召回、F0 和 boundary；不得把合成測試通過等同可用的歌唱模型。
