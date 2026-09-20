# Native Engine Decision

狀態：DEFERRED。

使用者已明確指定不需要離線產品；本輪維持線上網頁架構，不新增 desktop shell、本機 GPU 或 VST hosting。Master Prompt 的 native/VST 路線是長期候選，不是第一輪交付。

若未來另案要求 Windows VST3，才比較 JUCE 自建 session 與 JUCE + Tracktion Engine；須逐項評估 audio/MIDI、PDC、automation、clips、recording、render、undo、persistence、maintainability，以及當時 SDK 和權重的實際 license／商用條件。尚未做該評估，沒有聲稱 browser 能直接 host 原生 VST。

無論選擇哪條 native 路線，都不能把每個音訊 buffer 透過 UI IPC 傳遞；Web UI 只傳命令和低頻 telemetry。線上 AI 工作使用獨立雲端 queue，與 native 決策分離。
