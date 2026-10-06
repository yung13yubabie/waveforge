# 音高助手與片段音量曲線

2026-10-05。以正式版本 `98d7196a9518338eb18dccf1cdb3746160c9bfbd` 的來源 tree 為基底；這份文件說明下一段實作範圍，是否上線須對照精確提交的 PR／部署紀錄。

## 已接通，沒有假按鈕

|入口|實際處理|保存／復原／輸出|測試|
|---|---|---|---|
|音高助手：選原音／聲道／最多 60 秒|`pitch/analysis-client.js` 複製所選聲道窗口，Worker 跑原創 YIN 類型分析|只读診斷，不修改或保存音訊；換來源／範圍／切頁會取消舊分析|pitch-analysis、client 單元＋pitch-assistant 真 Worker E2E|
|音名、頻率、偏高／偏低與曲線／資料表|同一組帶 source-time 的 voiced／uncertain／unvoiced 資料；未知點不補成音符|結果為目前分頁診斷，不寫入多軌 ZIP|純 tone／detune／glide／noise／多取樣率、UI 狀態及真瀏覽器|
|A 原音／B 參考音|原始 native-rate buffer 低音量試聽，與 quiet native oscillator 輪流播放；全域播放互斥|不改原檔；自然結束、Stop、切頁、換來源與延遲 resume 都有 guard|source-preview／panel 單元；E2E 觀察真正 native source／oscillator|
|這句某處大聲／小聲：新增／改點／刪點／重設／拖曳|`clip.volumeAutomation` 2–32 點、0–200% 振幅；獨立 GainNode 與原淡入淡出相乘|單一步驟 Undo／Redo；split／trim 插值；move／duplicate；ZIP 保存|daw-automation、archive、render／UI＋真 OfflineAudioContext 樣本測試|
|預聽／WAV／ZIP 再開|共用 render recipe 和快取；超載沿用既有輸出 guard|保存原音及曲線，重新開頁後還原並核對 WAV bytes|daw-automation main-wired E2E＋production suite|

## 音高的誠實限制

- 估計範圍 50–1200 Hz，64 ms 分析窗、20 ms 步距。邊界附近可能回未知，不偷偷 clamp 成合法音符
- 週期性指標不是「這一定是人聲」或辨識正確率。和聲／不同音混在一起仍可能高度週期性，產生錯誤八度或基音；不能靠它自動判定唱錯
- 合成 55–1190 Hz tone 的多取樣率誤差測試，以及 harmonic／detune／glide／silence／noise／transient 回歸，不能代替真實歌唱或全樂器精度驗收
- 60 秒分析在此執行器的一次 96 kHz tone 測量約 1.46 秒；不是手機效能 SLA。工作在 Worker，30 秒逾時，取消終止 Worker；來源不被 detach
- 最多複製 60 秒 × 192000 Hz 的單聲道 PCM，约 46 MB，另有既有音訊／瀏覽器記憶體。沒有模型或音訊網路請求
- 原音與參考音的試聽音量刻意較低；參考音播放約兩秒。並未校準實際揚聲器聲壓

## 移調原型沒有開放給使用者

`pitch/shift.js` 是內部研究。它確實改變頻率並保留長度，但末端瞬間聲音、不同左右音高等測試發現缺陷。因此沒有按鈕、沒有接匯出或 shipping import，測試會阻止正式程式 import 這個模組。詳見 [實測限制與重現](PITCH_SHIFT_DSP_LIMITS.md)。不能把數值 tone 測試通過說成專業修音已完成。

## 本輪已重現並修正的問題

- 參考音 `AudioContext.resume()` 永不完成時，原 queue 會卡住後續操作；改為可取消、有十秒期限的獨立短生命週期 context，Stop 後可重試
- 寬螢幕 SVG 的圖像縮放和滑鼠座標不一致；修正 aspect-ratio 映射並保留寬度回歸
- 原音自然播放結束要由實際 onended 更新 UI，不能永遠顯示播放中；取消／舊 generation 的 callback 不得覆蓋新播放
- 主程式協調 A/B、母帶、分軌、歌詞、多軌的播放器，避免切頁後殘留聲音；音高頁不顯示不相關的母帶操作

本地整合測試、syntax 與 build 已通過。真正 Worker／Web Audio／UI／ZIP／匯出瀏覽器測試交由 PR CI；在該精確提交真正執行前不把 test discovery 算 passed。內部移調的紅色品質關卡仍保留，不作正式功能發布。
