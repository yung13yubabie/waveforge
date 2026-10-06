# 編輯優先的介面整理

日期：2026-10-06。目的：讓波形、時間軸與正在編輯的內容先出現；用短標籤和情境控制完成操作，詳細解釋按需展開。不是只改顏色、縮小字體或增加裝飾卡片。

## 已確認的原畫面問題

- 正式版桌機 1188×761 的多軌 ruler 約在 y=580；手機 390×844 的第一屏看不到音軌，先看到大量設定及說明
- 音高圖曾因固定 800-unit SVG 導致手機軸字只剩約 4–5 CSS px；部分 fullPage 截圖受巢狀 body 捲動影響，產生大段空白，不能當作有效的行動版證據
- 歌詞原文及模型說明放在已套用歌詞的編輯區前方，常用對時需要反覆往下找

## 本次改動及功能邊界

1. **多軌**：移除大型 hero；專案／匯入／保存集中成工具列，時間軸緊接其後。只有選片段時才展開有效的 inspector；詳細格線、輸出與教學用 disclosure。未儲存提示與 ZIP 含完整原音的提醒仍可見
2. **音高**：圖是主工作區，波形及範圍是簡潔工具列；當前音高、参考音和 A/B 放在同一個 inspector。未知不等於唱錯的必要限制靠近分析；逐點資料和長說明預設收起。SVG 改用量得的 CSS 寬度，避免手機字體跟著整張图縮到不可讀
3. **歌詞**：空白時直接貼歌詞；套用／還原後優先顯示波形、句子及當句控制。原文、模型設定與詳細輸出選項按需展開。模型來源、下載量、本機處理及真正同意 checkbox 不以排版為由省略；未滿足條件仍不能啟動分析
4. **共同**：保留所有真實控制和鍵盤操作，沒有新增假分析／修音按鈕。新佈局不改音訊配方、不可變原文、時間採用／手動鎖、復原、匯出及保存契約

## 六個參考站如何落地

|參考|採用的原則|在 WaveForge 的具體用法|
|---|---|---|
|[UXSnaps：Givingli editor](https://www.uxsnaps.com/givingli-personalized-card-editor)|創作物為主，控制依選取內容出現|時間軸／音高曲線放前；片段 inspector 只處理目前選取|
|[IF：Just-in-time consent](https://catalogue.projectsbyif.com/patterns/just-in-time-consent)|同意放在相關操作前，內容具體|模型來源／大小／資料去向靠近自動分析，沒有把同意藏掉|
|[UI Playbook：Tooltip](https://uiplaybook.dev/play/tooltip)|提示短且可 focus；必要資訊不能只靠 tooltip|短控制標籤，長教學展開看；保存警告持續可見|
|[60fps：Recollect sheet](https://60fps.design/shots/recollect-pro-bottom-sheet-to-page-interaction)|按需展開並保留操作位置|作為行動版情境面板原則；本次不加裝飾粒子或無意義動畫|
|[Design Spells：Sudoku sheet](https://designspells.com/spells/smooth-sheet-transitions-in-sudoku-a-day)|過渡為狀態／情境服務|減少常駐堆疊說明；保留選取、保存、錯誤的狀態連續性|
|[ABTest：HotelTonight flow](https://abtest.design/tests/streamlining-checkout-process)|刪除不必要的前置步驟|原文套用後回到編輯，不反覆重做設定；不借用案例數字宣稱本產品成效|

以上為設計原則映射，不複製第三方資產／程式，也不宣稱相同商業成效。

## 驗收方式

- 實際 Chrome viewport：390×844、1188×761、1440×1000；檢查空白、載入、選取、進階設定和輸出狀態
- 多軌 ruler 目標：桌機 y≤250、手機 y≤330；第一屏要看到音軌。輸入／按鈕至少 44 px，不藉縮小點擊區讓畫面看似精簡
- 圖與控件不超出 viewport；音高軸字至少 11 CSS px；行動版 PNG 的 IHDR 實際尺寸須為 390×844
- 手機圖取真正 viewport，重設 body／app／panel 捲動；不以被拉長的 fullPage PNG 當作版面通過
- 真實 worker、原音／參考音互斥、音量曲線樣本、WAV／ZIP roundtrip、歌詞取消／人工鎖／各格式及真模型流程，需在新精確提交的 CI 再驗

独立 source／DOM 複核找出兩個焦點回歸：復原到空歌詞時焦點留在已隱藏的列，以及取消分析後焦點留在已隱藏的取消按鈕。現已改為回到可見的原文／分析設定標題，並保留鍵盤復原→重做及取消測試；原始重現與 52 項對應 UI 測試已複核通過。

本地單元／建置和 source review 不能代替上述瀏覽器像素驗收；新截圖及任務結果尚待對應 CI 後確認。
