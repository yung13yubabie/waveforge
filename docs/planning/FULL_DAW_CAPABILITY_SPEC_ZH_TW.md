# WaveForge 上傳優先的專業 DAW 能力與介面追溯規格

更新：本地整合已加入貼原文、手動逐句對時、歌詞工程及 LRC／SRT／ASS／TXT 輸出，屬下列歌詞項目的部分實作。自動對時與第二輪補漏仍未完成；實際驗證見 ../validation/LYRICS_INTEGRATION_VALIDATION_2026-10-05.md。

日期：2026 年 10 月 5 日。這是需求、差距與驗收文件，不是已完成清單、交付日期或全部能力承諾。

## 先看結論

使用者主要上傳既有音檔；應優先把匯入、素材管理、歌曲剪輯、分析、分軌、人聲、比較、保存與交付做成完整工作流。錄音、硬體輸入與現場控制保留為低優先選配，不占初始主畫面。

專業 DAW 不只是一排效果器。必須把每項能力連成「可找到入口 → 可操作 → 引擎確實處理 → 可看懂結果 → 可保存與復原 → 預覽與匯出一致 → 有驗收證據」。本文件廣泛覆蓋常用與深入能力，不宣稱能列盡所有領域、所有未來 DAW 的每項特殊功能。

## 現況與證據邊界

依 2026-10-05 的 AUDIO_FOUNDATION_AUDIT 與 FILE_RETENTION_AUDIT：現有母帶處理、四個固定聲部控制／零點同步預聽／Bounce、WAV16/24／MP3／CD WAV+CUE+MD5 包有真實接線。母帶預設與復原只有靜態 DSP 狀態。Project/Track/Clip 時間軸、工程保存恢復、MIDI、自動化、F0/音符編輯、獨立時間伸縮、take/comp、三種人聲替換尚未實作。

本輪局部修復仍須依該分支的提交、測試與發布紀錄判斷；這份規格沒有重新跑全部程式或真實歌曲品質測試，也不把「本機已修」稱為「正式站已部署」。

- 已接通：只確認該條目所述既有窄範圍。其保存／復原／高階延伸限制仍在條目中明示
- 不完整：類別或部分引擎存在，但缺子功能、可靠性、持久化或驗收；不能整列標成完成
- 未實作：目前審查未見對應完整能力，按待建置規劃；不是隱藏一個已完成按鈕
- 核心常用：上傳型工作流經常需要的基礎；專業深化：深入製作／混音的能力；專項選配：錄音、硬體、現場、譜面或空間音訊等按用途啟用

## 既有類別最應先補的子功能

| 既有類別 | 現有基礎 | 仍缺而且會影響真實工作 | 對應 ID |
| --- | --- | --- | --- |
| 匯入與來源 | 本機單檔、來源WAV率保留、錯檔保留舊源 | 全格式能力表、多檔、多率對齊、聲道映射、RAM預檢、素材ID／重連 | ING01–ING08、AST01–AST05 |
| 母帶與效果 | EQ／Dynamic EQ／M/S／去齒音／MBC／飽和／Limiter與輸出 | 全鏈PDC、尾音、可旁路故障worklet、可重現recipe、跨率品質、參數schema | DSP01–DSP10、GRA05–GRA07、PRJ06 |
| 分析與參考 | 稀疏調性採樣、meter、參考EQ／LUFS | 範圍選擇／候選／轉調、逐時問題定位、真素材品質、獨立量測／後編碼QC | ANA01–ANA06、EXP06 |
| 四固定分軌與混音 | 各軌EQ/comp/pan/vol/mute/solo、同步零點預聽與Bounce | 單軌替換、任意位置、多率長度對齊、完整undo/save、殘漏與重建檢查、buses/sends | STM01–STM06、GRA01–GRA03 |
| 原版與final preview | 預覽及final render基礎 | 同時鐘、延遲對齊、音量匹配、選句循環、stale與revision | NAV01、NAV04、PRJ06 |
| 匯出與專輯 | WAV16/24/MP3、CD WAV+CUE+MD5 ZIP | stems政策、尾音、真正final LUFS迭代、後codec QC、完整配方、批次恢復 | EXP01–EXP10 |
| 權利工具與雲端分離 | HF整首音檔上傳、ACR片段比對、Supabase metadata | 可見server取消／刪除與真實確認、保留期不確定性、模型／素材授權、錯誤刪除處理 | PRI01–PRI04、NAV05 |
| 歌詞對時 | 新需求，尚無完整引擎與UI | 原文鎖定、多語逐句時間、補漏二輪、手動校正、LRC/SRT/ASS/TXT、保存 | LYR01–LYR06及歌詞附錄L01–L12 |

Vinyl 目前只是時長提醒，不是 RIAA 處理。IRC 不可用；沒有 genre 模型。CD WAV+CUE 包不是 DDP 2.00。版權比對不是權利裁決。這些限制應在實際入口呈現，不用假模型或假成功補空位。

## 畫面結構與操作路徑

固定播放列負責播放、定位、循環、同音量比較與監聽音量；左側管理素材／版本／逐句歌詞；中央顯示波形與時間軸；下方在音高、節奏、歌詞、MIDI中切換；右側只顯示所選內容。任何處理都要明示作用於「一行、一句、所選片段、一軌、整曲或整個工程」。

功能不必全變成工具列按鈕，但每個對使用者開放的功能至少要有可發現的選單或面板入口，並能從命令搜尋找到。進階控制收在可展開區；快捷鍵是加速方式，不能是唯一入口。禁止僅有後端函式、看不見的右鍵捷徑、無法取得焦點的圖示或不連引擎的假滑桿。

## 三份互補規格

- 本文件：跨領域能力、現有缺項與雙向追溯
- [音訊與歌聲功能深度規格 F01–F21](AUDIO_FEATURE_SPEC_ZH_TW.md)：音高、節奏、三種人聲模式與聽覺判斷
- [原文歌詞對時 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)：上傳音檔＋權威原詞、多語、二次補漏、手動校正、LRC／SRT／ASS／TXT。可先接現有單檔播放器，不必等完整 DAW

## 不產生孤兒功能的完整契約

伴隨 JSON 是 proposed registry，不是已接入產品的功能表。每項都提供穩定 ID、用途、詳細選項、具體入口、引擎／資料、保存／復原、輸出、驗收、依賴與來源。proposed_command_id、test_id 是建議名稱；component/handler/schema/renderer/tests 等實作欄位故意為 null 或空集合，禁止把填了一個名稱當成已實作。

每個詳細選項還必須在落地前拆成原子參數／動作，填寫型別、單位、預設、範圍／enum、步長、數值轉換、引擎目標、序列化位置、自動化支持、UI控制、reset及測試。檔案／二次分析等動作不能硬塞成滑桿。

### 合併與發布閘門

1. feature → UI：所有 exposed 功能有可見入口、可存取名稱、焦點、context 與禁用原因
2. UI → command：每個按鈕／選單／拖曳／快捷鍵都只派送有效command；不存在空handler、只改DOM或假進度
3. command → engine：聲音功能有真processor和支援能力；analysis／monitor／純UI功能明確標不改render
4. parameter → schema：UI、engine、preset、history、serializer與automation讀同一canonical值，雙向更新無副本漂移
5. state → save/reopen：保存含asset、clip、route、params、automation與版本；缺依賴保留placeholder，不丟opaque state
6. edit → undo/redo：正向、撤回、重做與重開均核對；異步任務晚到不得覆蓋新版
7. live → render：所有影響作品的功能都有render policy與範圍；監聽、preview、reference、UI音不得混進交付
8. tests → evidence：每個上線ID連到真的測試檔與結果；test名稱只是計畫，沒有執行證據不得PASS
9. negative paths：取消、重試、缺模型、壞檔、裝置失聯、quota、網路錯誤、stale結果仍可恢復
10. reverse scan：CI反掃UI controls、commands、schema fields、processors與renderer，未登記或無consumer一律報錯；有意內部節點需註明internal及consumer

建議做一個 registry validator 和 parameter-binding integration suite，但本文件只提出它們；這次產物驗證的是登記資料完整性，不是應用程式已沒有孤兒節點。

### 硬依賴與整合關係

JSON dependencies 表示這份規劃的必要前置，來源／render／權利等參照不全部當硬依賴。既有單檔匯入、固定四軌混音、既有匯出不要求先完成新Project模型。歌詞 LYR01–LYR06可使用獨立lyrics session與現有單檔播放；手動校正和四格式輸出不以自動對齊模型或完整DAW為前置。日後接入統一素材、任務與工程系統是整合關係，可由implementation plan另列。

### 最小交付切片

- 切片一：現有master/stem可靠性、完整render recipe、可信的過期預覽提示、故障旁路、尾音／延遲與最終品質檢查
- 切片二：上傳素材池、工程保存／重開／恢復、真正多片段時間軸、完整undo
- 可平行切片：原文歌詞對時；先完成手動校正＋四格式正確輸出，再接真實多語模型與局部二次分析
- 切片三：單軌人聲替換、逐音／逐字編輯、warp、路由／sends、automation、分軌交付
- 切片四：MIDI／樂器／MPE／奏法與更深效果鏈；依實際使用再啟用錄音、硬體、影片、樂譜和空間音訊

完整產品範圍並不表示所有切片一次交付。每一片都要從入口走到保存、復原、匯出和證據，不交一排斷頭控制項。

## 關鍵技術界線

- Web Audio 的 latency hint 不是硬體 driver buffer 保證；工作草案中的新API不代表瀏覽器都實作
- 純Web不能直接把 native VST/AU 二進位當Web Audio節點；browser DSP與未來native宿主是不同能力與部署決策
- plug-in掃描隔離和播放時crash隔離是兩件事，必須分別測試
- send、sidechain、returns、母線非線性處理會影響「各stem相加等於master」；匯出需先說清政策
- 採樣峰值、插值估計truepeak、獨立參考量測、編碼後QC與實體輸出是不同驗證層
- buffer長度不是round-trip latency；換裝置／rate之後先前校準不可默默沿用
- 原檔、工作RAM、browser cache、雲端任務、作品metadata、下載檔各有不同生命週期。關頁不等於第三方擦除
- 對齊模型只估時間；歌詞原文保持獨立。找不到要標待核對，不能均分整首偽造timestamps

以下每個條目都是本案建議契約。外部手冊只用來核對能力概念與已知限制；UI路徑、資料契約與驗收為WaveForge的原創規劃，不是逐段轉寫原廠手冊。舊版來源已在來源名中標明，不能當成所有現行版本的保證。

## 功能總覽

本版登記 136 項能力，含 862 個待原子化的詳細選項組。核心／專業／選配分別為 50／70／16 項；「已接通／不完整／未實作」分別為 3／30／103 項。數量是覆蓋範圍，不是完成率。

| 領域 | ID範圍 | 項數 |
| --- | --- | --- |
| 匯入格式與來源處理 | DAW-ING01 至 DAW-ING08 | 8 |
| 素材生命週期 | DAW-AST01 至 DAW-AST05 | 5 |
| 工程保存版本與恢復 | DAW-PRJ01 至 DAW-PRJ07 | 7 |
| 播放選取與工作區 | DAW-NAV01 至 DAW-NAV05 | 5 |
| 多軌與音訊剪輯 | DAW-EDT01 至 DAW-EDT10 | 10 |
| 分析與品質判斷 | DAW-ANA01 至 DAW-ANA06 | 6 |
| 音高人聲與演唱製作 | DAW-VOC01 至 DAW-VOC06 | 6 |
| 上傳音訊加原文歌詞對時 | DAW-LYR01 至 DAW-LYR06 | 6 |
| 現有分軌類別的深化 | DAW-STM01 至 DAW-STM06 | 6 |
| 路由效果鏈與延遲 | DAW-GRA01 至 DAW-GRA08 | 8 |
| 既有母帶和混音處理的深化 | DAW-DSP01 至 DAW-DSP10 | 10 |
| 自動化與參數時間變化 | DAW-AUTO01 至 DAW-AUTO05 | 5 |
| 編排速度拍號和參考 | DAW-ARR01 至 DAW-ARR05 | 5 |
| MIDI與逐音表情 | DAW-MID01 至 DAW-MID08 | 8 |
| 樂器與取樣 | DAW-INS01 至 DAW-INS04 | 4 |
| 輸出交付與編碼後驗證 | DAW-EXP01 至 DAW-EXP10 | 10 |
| 權利隱私與資料流 | DAW-PRI01 至 DAW-PRI04 | 4 |
| 交接協作和連線恢復 | DAW-COL01 至 DAW-COL04 | 4 |
| 完整性效能與無障礙 | DAW-QUA01 至 DAW-QUA08 | 8 |
| 選配錄音附錄 | DAW-REC01 至 DAW-REC05 | 5 |
| 選配控制器同步影片與配器 | DAW-ADV01 至 DAW-ADV06 | 6 |

## 匯入格式與來源處理

### DAW-ING01 單曲匯入與安全替換

層級：核心常用｜現況：已接通

- 白話用途：把既有音檔帶入，失敗時不丟掉上一首
- 子功能與選項：選檔與拖放；檔名和來源資訊；解碼中狀態；取消與重試；錯檔保留舊來源
- 具體介面入口：檔案→匯入音訊；來源列→更換／清除
- 引擎與資料契約：File到解碼PCM；來源generation避免晚到結果覆蓋新檔；顯示真實格式
- 保存與復原：現有來源只在工作階段；未有專案持久化，清除和替換須有明確範圍
- 預覽與匯出：輸出只引用已接受來源，不能引用解碼失敗或過期結果
- 驗收：先載A再載損毀B；A仍可播／匯出；快速載B再C只接受C
- 前置依賴：基礎資料模型，無其他登記項硬性前置
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-ING02 格式與編碼能力表

層級：核心常用｜現況：不完整

- 白話用途：知道哪些檔案能可靠讀入
- 子功能與選項：WAV PCM整數／浮點；AIFF／FLAC；MP3／AAC／Ogg依實際codec；位元深度；格式與副檔名不符；不支援說明
- 具體介面入口：匯入對話框→支援格式；來源詳情→解碼方式
- 引擎與資料契約：按實際解碼器白名單；偵測容器／codec／聲道；WAV原生率與browser fallback分開
- 保存與復原：保存原檔規格、實際解碼率、解碼器版本；不可只存檔名
- 預覽與匯出：解碼後差異、lossy來源和轉碼次數記入交付紀錄
- 驗收：逐格式fixture確認rate／channels／duration；偽副檔名與損毀檔安全失敗
- 前置依賴：DAW-ING01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

### DAW-ING03 批次與多檔匯入

層級：核心常用｜現況：未實作

- 白話用途：一次上傳多個伴奏、聲部或錄音
- 子功能與選項：順序；建立獨立音軌／同軌連排；起點；同名檔；逐檔進度；部分成功；重複資產合併
- 具體介面入口：檔案→批次匯入；匯入佇列→重試／略過
- 引擎與資料契約：資產佇列與並行上限；每檔獨立結果；操作交易邊界
- 保存與復原：整批建立一個可撤回操作；保留已入庫原資產
- 預覽與匯出：只納入成功且未略過的片段；失敗不以靜音冒充完成
- 驗收：混合好壞檔、重複檔與取消；確認軌道／順序／undo和重開一致
- 前置依賴：DAW-PRJ01、DAW-AST01、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-ING04 取樣率與重採樣

層級：核心常用｜現況：不完整

- 白話用途：不同來源率也能在同一工程正確發聲
- 子功能與選項：來源率；工程率；監聽率；輸出率；轉換品質；估計耗時；已轉換標示
- 具體介面入口：來源詳情；專案→音訊規格；匯出→取樣率
- 引擎與資料契約：不重標rate冒充SRC；轉換器版本／品質；duration和pitch不變；多rate對齊
- 保存與復原：保留原檔並存轉換配方和cache鍵；可重建快取
- 預覽與匯出：live與offline明確使用目標率；不同品質模式標示
- 驗收：44.1／48／96k正弦及脈衝：長度、頻率、混疊、邊界；跨率分軌對齊
- 前置依賴：DAW-ING02、DAW-AST01
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)；[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

### DAW-ING05 聲道與聲道配置

層級：專業深化｜現況：未實作

- 白話用途：避免左右對調、單聲道加倍或多聲道丟失
- 子功能與選項：mono／stereo；split／interleaved；通道命名；L/R mapping；downmix配方；聲道選取
- 具體介面入口：匯入→聲道配置；片段詳情→通道
- 引擎與資料契約：明確channel layout與矩陣；不同來源channel count不可無聲截斷
- 保存與復原：mapping為非破壞設定且可復原；原asset不改
- 預覽與匯出：輸出layout及downmix寫入recipe，不悄悄轉stereo
- 驗收：左右獨立脈衝、mono、反相、多聲道fixtures驗證route及音量
- 前置依賴：DAW-ING02、DAW-GRA01
- 技術參照：[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

### DAW-ING06 來源時間與BWF標記

層級：專業深化｜現況：未實作

- 白話用途：多檔從原本的時間位置對齊
- 子功能與選項：BWF時間戳；時間碼；起始offset；原始建立時間；忽略／套用；衝突處理
- 具體介面入口：匯入→依原時間對齊；來源詳情→中繼資料
- 引擎與資料契約：解析支援格式的時間欄位；sample位置與時碼換算
- 保存與復原：保留原metadata，套用offset是可撤回edit
- 預覽與匯出：分軌可保留共同起點和需要的中繼資料
- 驗收：已知時間戳、多sample rate、缺資料與異常值fixture不錯位
- 前置依賴：DAW-ING04、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Apple Logic AAF 匯出](https://support.apple.com/en-euro/guide/logicpro/lgcp7355bedf/mac)

### DAW-ING07 上傳前資源檢查

層級：核心常用｜現況：未實作

- 白話用途：避免大檔把頁面記憶體耗盡
- 子功能與選項：檔案大小／時長；解碼後RAM估算；可用空間；分塊策略；安全上限；取消
- 具體介面入口：匯入前摘要；資源列→記憶體／磁碟
- 引擎與資料契約：限制由實測配置；stream／chunk decode能力分開；不把壓縮檔大小當PCM大小
- 保存與復原：未完成asset不標ready；中斷可清理或續作
- 預覽與匯出：缺來源／未完整decode時禁止假成功輸出
- 驗收：長檔、超限、低記憶體、取消與重新匯入都保留工程
- 前置依賴：DAW-AST01、DAW-QUA01
- 技術參照：[Ableton Live 12 官方手冊 資源與CPU策略](https://www.ableton.com/en/live-manual/12/computer-audio-resources-and-strategies/)；[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

### DAW-ING08 跨工程交換匯入

層級：專業深化｜現況：未實作

- 白話用途：接收其他製作人交來的編輯資料
- 子功能與選項：SMF MIDI；tempo map；AAF／EDL選配；支援／丟失清單；consolidated audio fallback
- 具體介面入口：檔案→匯入工程資料；轉換摘要→確認
- 引擎與資料契約：每格式獨立parser與loss model；外掛／routing不假稱全等
- 保存與復原：建立新工程或可撤回merge；保留來源檔和轉換報告
- 預覽與匯出：轉換後以WaveForge工程渲染；未支援項明示
- 驗收：代表性交換fixture核對位置／fade／automation；unsupported項不能被靜默丟棄
- 前置依賴：DAW-PRJ01、DAW-EDT01、DAW-MID01
- 技術參照：[Apple Logic AAF 匯出](https://support.apple.com/en-euro/guide/logicpro/lgcp7355bedf/mac)；[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

## 素材生命週期

### DAW-AST01 素材池與穩定身份

層級：核心常用｜現況：未實作

- 白話用途：檔名改了也知道是哪份聲音
- 子功能與選項：asset ID；內容hash；原檔／代理／衍生檔；使用次數；來源位置；解碼狀態
- 具體介面入口：左側→素材；素材詳情→被哪些片段使用
- 引擎與資料契約：內容身份與檔名分離；媒體不可變；衍生資產帶source ID
- 保存與復原：工程只存穩定引用與配方；撤回不立即刪原檔
- 預覽與匯出：渲染按asset ID解析，不依目前選取或DOM
- 驗收：同名不同檔、改名、重複匯入、複製工程後仍引用正確
- 前置依賴：DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-AST02 素材重新連結

層級：核心常用｜現況：未實作

- 白話用途：移動檔案後救回工程
- 子功能與選項：缺失清單；依hash／名稱／規格候選；人工確認；批次重連；錯誤配對撤回
- 具體介面入口：專案→檢查素材→重新連結
- 引擎與資料契約：失聯placeholder保留片段；驗證候選身份與長度；禁止自動猜錯
- 保存與復原：重連交易可undo；原未解決引用仍保留
- 預覽與匯出：缺檔預設阻擋完整輸出，可明確匯出已知部分並附報告
- 驗收：錯名同名、部分missing、取消重連與重開不丟edit
- 前置依賴：DAW-AST01、DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-AST03 收集與打包工程

層級：核心常用｜現況：未實作

- 白話用途：換電腦或交接也能重開
- 子功能與選項：複製用到的原檔；衍生檔；模型／外掛清單；相對路徑；checksum；容量摘要
- 具體介面入口：檔案→另存副本／打包工程
- 引擎與資料契約：打包manifest與完整性校驗；第三方受限sample不擅自散布
- 保存與復原：原工程不改；pack生成新版本；取消不留下完整成功標記
- 預覽與匯出：交付包與audio exports分開列出
- 驗收：在沒有原路徑的乾淨目錄打開並渲染；核對缺項報告
- 前置依賴：DAW-PRJ01、DAW-AST01、DAW-PRI01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-AST04 素材瀏覽與試聽

層級：專業深化｜現況：未實作

- 白話用途：找到聲音而不打斷正式編曲
- 子功能與選項：名稱／標籤／時長／格式搜尋；收藏；原速／跟工程拍速預聽；音量；停止
- 具體介面入口：左側素材庫→搜尋／預聽；結果→加入工程
- 引擎與資料契約：preview專用路由；讀取metadata cache；未授權遠端庫不自動抓取
- 保存與復原：偏好與收藏存用户設定；加入才改工程／進undo
- 預覽與匯出：素材預聽不能混入master或輸出
- 驗收：播放中預聽、切換素材、停止與export隔離測試
- 前置依賴：DAW-AST01、DAW-GRA01
- 技術參照：[Ableton Live 12 官方手冊 素材瀏覽器](https://www.ableton.com/en/live-manual/12/working-with-the-browser/)；[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

### DAW-AST05 快取與未使用素材整理

層級：專業深化｜現況：未實作

- 白話用途：省空間但不刪作品需要的檔案
- 子功能與選項：原檔／分析cache／rendercache區別；引用分析；可回復清理；估計空間；保留期
- 具體介面入口：專案→儲存空間→檢查／清理
- 引擎與資料契約：跨版本引用圖；cache可重建，原資產需明確策略
- 保存與復原：只移回收區，清理與永久刪除分開；保留可恢復紀錄
- 預覽與匯出：被渲染snapshot使用的檔案不可中途清走
- 驗收：歷史版本引用、進行中render、符號路徑與中斷不丟資料
- 前置依賴：DAW-AST01、DAW-PRJ03、DAW-EXP01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

## 工程保存版本與恢復

### DAW-PRJ01 工程新建儲存重開

層級：核心常用｜現況：未實作

- 白話用途：讓處理過的歌下次能繼續
- 子功能與選項：工程schema；儲存／另存；標題；dirty狀態；模板；最近開啟
- 具體介面入口：檔案→新建／開啟／儲存／另存
- 引擎與資料契約：Project/Asset/Track/Clip/Graph/Automation分離；原子寫入
- 保存與復原：一個完整可重開snapshot，不是只有DSP preset；儲存失敗不得清dirty
- 預覽與匯出：render捕捉確定revision，不能依當下可變UI
- 驗收：建立多素材工程→儲存→關閉→重開；edit與輸出等效；quota失敗不覆好檔
- 前置依賴：基礎資料模型，無其他登記項硬性前置
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-PRJ02 完整操作歷史

層級：核心常用｜現況：不完整

- 白話用途：任何改動都能知道如何退回
- 子功能與選項：跨片段／stem／routing／automation歷史；動作名；拖曳合併；redo分支；重設局部
- 具體介面入口：編輯→復原／重做；歷史側欄→定位
- 引擎與資料契約：統一commands／transactions；連續調整coalescing；異步結果綁revision
- 保存與復原：現有歷史僅static DSP；擴充到工程delta與必要snapshot
- 預覽與匯出：撤回後輸出應對應回復狀態；監聽操作可不入音訊undo但需註明
- 驗收：移片段、改stem、換候選、改route逐一undo/redo；分支後redo失效正確
- 前置依賴：DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-PRJ03 自動儲存與崩潰恢復

層級：核心常用｜現況：未實作

- 白話用途：頁面或裝置出問題後少丟工作
- 子功能與選項：autosave間隔；snapshot+journal；恢復提示；最後好版本；損毀隔離；quota
- 具體介面入口：專案→恢復中心；啟動→恢復副本／放棄
- 引擎與資料契約：journal有schema與checksums；原子commit；媒體durability獨立
- 保存與復原：恢復開副本，不覆蓋最後好檔；未完成交易可回滾
- 預覽與匯出：恢復後先做資產與render recipe檢查
- 驗收：在載入／保存／生成回寫中強制終止；恢復內容可重播可輸出
- 前置依賴：DAW-PRJ01、DAW-PRJ02、DAW-AST01
- 技術參照：[Ableton 崩潰恢復](https://help.ableton.com/hc/en-us/articles/115001878844-Recovering-a-Set-manually-after-a-crash)

### DAW-PRJ04 版本與分支比較

層級：專業深化｜現況：未實作

- 白話用途：保留不同混音與修改方向
- 子功能與選項：命名版本；差異；還原；fork；標記候選；變更說明
- 具體介面入口：專案→版本；A/B→選版本
- 引擎與資料契約：不可變revision DAG；共享assets；render cache含revision
- 保存與復原：切回不改掉未保存分支；可另存或取消
- 預覽與匯出：版本交付檔带revision與完整recipe
- 驗收：版本A/B只改指定參數，切回和重開不混用cache
- 前置依賴：DAW-PRJ01、DAW-PRJ02
- 技術參照：[Apple Logic 版本與備份](https://support.apple.com/guide/logicpro/use-project-alternatives-and-backups-lgcpa158ef77/mac)

### DAW-PRJ05 工程遷移與相容性

層級：專業深化｜現況：未實作

- 白話用途：更新軟體後舊歌仍開得回來
- 子功能與選項：schema版本；migration；未知欄位保留；向前不相容提示；唯讀開啟
- 具體介面入口：開啟工程→相容性摘要；檔案→轉換副本
- 引擎與資料契約：有測試的migration鏈；runtime／DSP版本另記
- 保存與復原：升級前備份；不能破壞原工程；回滚策略
- 預覽與匯出：舊DSP有變更時提示音色差異並選擇重渲染
- 驗收：各schema golden fixtures；未知device/state保存不失落
- 前置依賴：DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Apple Logic 版本與備份](https://support.apple.com/guide/logicpro/use-project-alternatives-and-backups-lgcpa158ef77/mac)

### DAW-PRJ06 可重現處理配方

層級：核心常用｜現況：不完整

- 白話用途：知道匯出的聲音到底用了哪些設定
- 子功能與選項：來源hash；範圍；所有DSP／bypass；輸出rate/depth；watermark；loudness target；演算法版本
- 具體介面入口：匯出→配方摘要；專案→處理紀錄
- 引擎與資料契約：canonical render recipe包括params和capability版本
- 保存與復原：補足現有snapshot漏trim／watermark／export設定；版本化且可還原
- 預覽與匯出：輸出job只讀snapshot；改設定標stale，不悄悄換配方
- 驗收：同recipe固定條件重渲染比對；隨機dither／模型另列非確定來源
- 前置依賴：DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-PRJ07 模板與預設管理

層級：專業深化｜現況：未實作

- 白話用途：快速開始而不覆蓋当前作品
- 子功能與選項：工程模板；音軌／FXchainpreset；命名；匯入／匯出；版本；缺依賴
- 具體介面入口：檔案→從模板；預設庫→試用／套用／重設
- 引擎與資料契約：預設與工程明確分離；套用是command；範圍限制
- 保存與復原：預設覆寫可回復；工程記套用後具體值不只名稱
- 預覽與匯出：preset可重現需固定device IDs與assets
- 驗收：缺外掛preset不丟狀態；套用前後undo與重開一致
- 前置依賴：DAW-PRJ01、DAW-PRJ02
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

## 播放選取與工作區

### DAW-NAV01 穩定播放與定位

層級：核心常用｜現況：不完整

- 白話用途：在同一句反覆聽而不迷路
- 子功能與選項：play／pause／stop；seek；前後句；時間／小節；選取循環；scrub；follow開關
- 具體介面入口：固定播放列；時間尺；檢視→跟隨
- 引擎與資料契約：single transport clock；狀態機；sample／beat換算；音訊與視覺分離
- 保存與復原：游標與檢視狀態可保存，但不污染DSPundo
- 預覽與匯出：匯出不受臨時播放位置影響，使用明確範圍
- 驗收：seek/stop/ended競態；末端循環；快速連點；長檔同步
- 前置依賴：DAW-PRJ01、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-NAV02 軌道與片段選取模型

層級：核心常用｜現況：未實作

- 白話用途：清楚知道正在改字、句、軌還是整曲
- 子功能與選項：單選／多選；時間範圍；track/clip focus；鎖定；全選；選取摘要
- 具體介面入口：時間軸；編輯→選取；右側→範圍摘要
- 引擎與資料契約：選取模型不依DOM；命令聲明scope與precondition
- 保存與復原：選取變化可有導覽歷史；內容修改才入音訊undo
- 預覽與匯出：所有render/AI操作捕捉明確selection ID/range
- 驗收：框選／鍵盤選取／跨軌／隱藏軌操作不超出範圍
- 前置依賴：DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-NAV03 工作區與可發現命令

層級：專業深化｜現況：未實作

- 白話用途：功能有入口且高手不用翻很多層
- 子功能與選項：面板顯示；音軌高度；縮放；檢視快照；命令搜尋；快捷鍵衝突
- 具體介面入口：檢視選單；命令面板；設定→快捷鍵
- 引擎與資料契約：同一command registry供按鈕／選單／palette；context filter
- 保存與復原：版面和快捷鍵存偏好，工程內容不改
- 預覽與匯出：純UI功能明確render N/A，不創建假音訊狀態
- 驗收：每個exposed command可由選單及palette找到；context禁用有原因
- 前置依賴：DAW-QUA01
- 技術參照：[Ableton Live 12 官方手冊 無障礙與鍵盤](https://www.ableton.com/en/live-manual/12/accessibility-and-keyboard-navigation/)

### DAW-NAV04 單時鐘同音量A B

層級：核心常用｜現況：不完整

- 白話用途：公平比較修改而非比較誰更大聲
- 子功能與選項：原版／處理版；同句循環；LUFS匹配；match增益顯示；final preview；stale標示
- 具體介面入口：固定A/B區；按住聽原版；比較設定
- 引擎與資料契約：same clock／position；必要crossfade；latency align；gain match獨立monitor path
- 保存與復原：比較偏好與version IDs可存；不覆DSP或輸出增益
- 預覽與匯出：匹配只影響監聽；真正final配方另預覽
- 驗收：不同延遲／音量版本切換無跳位；match不進export；設定變更使舊preview失效
- 前置依賴：DAW-NAV01、DAW-PRJ06、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)；[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-NAV05 任務中心與取消重試

層級：核心常用｜現況：未實作

- 白話用途：知道分析和雲端處理進行到哪裡
- 子功能與選項：queued/running/cancelling/failed/done；真進度；retry；錯誤詳情；revision；結果套用
- 具體介面入口：任務列→展開／取消／重試／套用
- 引擎與資料契約：client job與server job ID；冪等結果；過期generation不得寫回
- 保存與復原：結果形成新asset/版本；取消不刪原資料；紀錄結果歸屬
- 預覽與匯出：render／AI若取消未確認server停止，明說狀態
- 驗收：斷網、晚到結果、取消後重試、切工程不串結果；百分比不得捏造
- 前置依賴：DAW-PRJ01、DAW-PRI02
- 技術參照：[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

## 多軌與音訊剪輯

### DAW-EDT01 多軌時間軸

層級：核心常用｜現況：未實作

- 白話用途：自由排列任意聲音片段
- 子功能與選項：audio/MIDI軌；clip起點／長度／source offset；lane；重排；鎖軌；重名
- 具體介面入口：新增音軌；時間軸工具列；片段檢查器
- 引擎與資料契約：Project/Track/Clip模型；sample/beat timebase；graph排程
- 保存與復原：位置與來源non-destructive，所有edit交易可undo
- 預覽與匯出：offline與live讀同一clip排程與graph
- 驗收：空隙／重疊／長檔／混合rate；重開與render起點對齊
- 前置依賴：DAW-PRJ01、DAW-AST01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-EDT02 分割裁切與滑移

層級：核心常用｜現況：未實作

- 白話用途：剪掉不要的部分但保留原音
- 子功能與選項：split；trim start/end；slip source；duplicate；copy/paste；delete；heal
- 具體介面入口：片段工具列；右鍵→分割／裁切；數值檢查器
- 引擎與資料契約：source offset與project範圍分開；越界驗證
- 保存與復原：只改edit references；原音不變；一次拖曳一步undo
- 預覽與匯出：輸出精確落在clip範圍且不漏起尾sample
- 驗收：分割後重拼音訊等效；trim往回可找回；undo與serialization保持
- 前置依賴：DAW-EDT01、DAW-PRJ02
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-EDT03 淡入淡出與交叉淡化

層級：核心常用｜現況：未實作

- 白話用途：接縫不突然喀聲或忽大忽小
- 子功能與選項：fade長度／形狀；equal gain/power；linked handles；auto-crossfade；聽接縫
- 具體介面入口：片段角handle與數值欄；接縫→預聽
- 引擎與資料契約：envelope計算與重疊規則；不同內容相位不可保證消失
- 保存與復原：每clip fade資料與join ID；可undo／reset
- 預覽與匯出：render與preview用同一fade曲線及長度
- 驗收：脈衝／連續sine／反相／不同recording；邊界無不合理截斷
- 前置依賴：DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-EDT04 漣漪刪除與插入時間

層級：專業深化｜現況：未實作

- 白話用途：剪掉一段時後面的內容一起跟上
- 子功能與選項：單軌／選軌／全工程ripple；markers／automation跟隨；locked例外；影響預览
- 具體介面入口：編輯→漣漪模式／刪除時間／插入時間
- 引擎與資料契約：timeline transaction整批移動；anchor與timebase明確
- 保存與復原：一筆可逆多物件操作；預覽受影響數量
- 預覽與匯出：新排列與metadata一致輸出
- 驗收：跨軌、鎖軌、tempo marker、automation、take邊界不散掉
- 前置依賴：DAW-EDT01、DAW-PRJ02、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)；[REAPER 官方技術能力](https://www.reaper.fm/about.php)

### DAW-EDT05 多軌連動剪輯與相位保護

層級：專業深化｜現況：未實作

- 白話用途：鼓組或同時錄的聲道一起移
- 子功能與選項：edit groups；link/unlink；相對offset；共同cut/warp；保護同步
- 具體介面入口：音軌群組→連動編輯；工具列→群組暫停
- 引擎與資料契約：group membership與相對sample位置；多mic共同anchors
- 保存與復原：group與每軌offset可存可undo
- 預覽與匯出：linked編集保持相對時間；不得各軌獨立自動warp
- 驗收：多mic脈衝／鼓組fixture剪接與重開後相對offset不變
- 前置依賴：DAW-EDT01、DAW-EDT08
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-EDT06 範圍吸附與精準輸入

層級：專業深化｜現況：未實作

- 白話用途：不用靠滑鼠猜位置
- 子功能與選項：sample/ms/beat；absolute/relative snap；triplet；off；nudge；鎖定長度
- 具體介面入口：時間軸→格線；片段檢查器→起點／終點／長度
- 引擎與資料契約：units轉換與rounding政策；高精度內部time
- 保存與復原：數值和拖曳用同command；可undo
- 預覽與匯出：輸出以engine sample界限，UI四捨五入不改資料
- 驗收：tempo變更與多rate時往返轉換、鍵盤nudge、負起點政策
- 前置依賴：DAW-EDT01、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-EDT07 片段增益與包絡

層級：專業深化｜現況：未實作

- 白話用途：先把字句大小整好再進效果器
- 子功能與選項：clip gain；增益節點；mute region；normalize預览；峰值上限
- 具體介面入口：片段→音量；下方→包絡；正規化對話框
- 引擎與資料契約：clip前置gain stage與track fader分離；明確normalize策略
- 保存與復原：非破壞envelope與操作history；原PCM保留
- 預覽與匯出：clip前置增益實際影響後續compressor和export
- 驗收：gain前後位置正確；reset復原；normalization不自動偷偷執行
- 前置依賴：DAW-EDT01、DAW-GRA01
- 技術參照：[Ableton Live 12 官方手冊 片段包絡](https://www.ableton.com/en/live-manual/12/clip-envelopes/)

### DAW-EDT08 音訊伸縮與變速

層級：專業深化｜現況：未實作

- 白話用途：改長短或對拍，並決定音高要不要跟著變
- 子功能與選項：warp anchors；time stretch／repitch；演算法；transient保護；formant選配；品質
- 具體介面入口：節奏編輯器→對齊點；片段→速度／長度
- 引擎與資料契約：time mapping；audio算法版本與quality；單／多聲部能力區別
- 保存與復原：保留原audio和warp map，可reset；cache由recipe鍵控
- 預覽與匯出：offline mode與preview差異必須披露並提供final audition
- 驗收：已知onset定位、長音音高、瞬態／尾音、極端拉伸；群組相位
- 前置依賴：DAW-EDT01、DAW-ANA03、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊速度與伸縮](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/)

### DAW-EDT09 片段合併與原位轉音訊

層級：專業深化｜現況：未實作

- 白話用途：把複雜修改結成一段又可回原版
- 子功能與選項：consolidate；bounce-in-place；dry/wet；tail；replace/newtrack；source保留
- 具體介面入口：片段／音軌→合併／原位轉音訊
- 引擎與資料契約：子圖render snapshot；資產provenance；選區／tails
- 保存與復原：產生新asset和可undo引用替換；來源與devices保存
- 預覽與匯出：重新bounce不重複套已印入效果；render recipe可見
- 驗收：關閉外掛後freeze可播；恢復原軌；邊界與尾音一致
- 前置依賴：DAW-PRJ06、DAW-EXP01
- 技術參照：[Ableton Live 12 官方手冊 Bounce to Audio](https://www.ableton.com/en/live-manual/12/bounce-to-audio/)

### DAW-EDT10 聲音修補與頻譜編輯

層級：專業深化｜現況：未實作

- 白話用途：只清掉喀聲、嗡聲或某段噪音
- 子功能與選項：spectrogram選取；declick；dehum；denoiseprofile；repair強度；delta試聽；範圍fade
- 具體介面入口：下方→清理；框選時間頻率→預覽／套用
- 引擎與資料契約：不同repair engine分開；不能用EQ假裝補不存在波形
- 保存與復原：原音＋operation stack；每次repair新版本可退回
- 預覽與匯出：只有所選區域變；演算法與模型有權利／用途資訊
- 驗收：合成click/hum及授權真素材聽測；不吞子音／氣音；範圍外一致
- 前置依賴：DAW-EDT01、DAW-PRJ04
- 技術參照：[Apple Logic Effects 官方手冊](https://help.apple.com/pdf/logicpromac-effects/en_US/logic-pro-mac-effects-user-guide.pdf)；[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

## 分析與品質判斷

### DAW-ANA01 音訊健檢與可定位問題

層級：核心常用｜現況：不完整

- 白話用途：分析結果能帶你回到出問題的地方
- 子功能與選項：sample peak；true peak；LUFS；DC；silence；clipping；phase/correlation；分析範圍
- 具體介面入口：分析→檢查；問題列→跳到該處
- 引擎與資料契約：每測量帶算法／window／range／rate；certainty不是保證
- 保存與復原：analysis artifact綁asset/revision，改音訊後失效可重算
- 預覽與匯出：source與final metrics分開；不拿輸入量測冒充輸出
- 驗收：已知信號及獨立oracle；空音／mono／反相；點結果定位正確
- 前置依賴：DAW-AST01、DAW-NAV01
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)；[Apple Logic Loudness Meter](https://support.apple.com/en-ae/guide/logicpro/lgce12d9d256/10.7/mac/11.0)

### DAW-ANA02 調性與和弦分析

層級：核心常用｜現況：不完整

- 白話用途：給旋律參考而非替你判定音樂對錯
- 子功能與選項：range；top candidates；key／chord時間變化；無調性；人工確認；分析覆蓋資訊
- 具體介面入口：分析→調性／和弦；參考軌→確認／修正
- 引擎與資料契約：目前調性為有範圍揭露的稀疏採樣；chord及modulation另需引擎
- 保存與復原：保留analysis候選與user target分開；確認可撤回
- 預覽與匯出：分析不改聲音；只有明確修音command影響export
- 驗收：三rate與前段靜音；轉調／藍調／polyphony corpus；分數不冒充正確率
- 前置依賴：DAW-AST01、DAW-ANA06
- 技術參照：[Ableton Live 12 官方手冊 調律系統](https://www.ableton.com/en/live-manual/12/using-tuning-systems/)

### DAW-ANA03 拍速與拍點分析

層級：專業深化｜現況：未實作

- 白話用途：把音樂時間格線對準既有錄音
- 子功能與選項：BPM候選；倍速／半速；downbeat；拍號；tempo map；tap校正；信心
- 具體介面入口：分析→節拍；拍點軌→設第一拍／調整
- 引擎與資料契約：onset／beat／downbeat分層；偵測和warp分離
- 保存與復原：tempo建議可存但不自動改audio；接受是undoable
- 預覽與匯出：未接受analysis不得讓export變速
- 驗收：固定／變速、弱起、半倍速、無鼓；人工修正後grid和audio同步
- 前置依賴：DAW-AST01、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 音訊速度與伸縮](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/)；[Ableton Live 12 官方手冊 律動模板](https://www.ableton.com/en/live-manual/12/using-grooves/)

### DAW-ANA04 參考曲比較與配對

層級：專業深化｜現況：不完整

- 白話用途：用喜歡的歌曲比較音色和大小
- 子功能與選項：多references；range matching；level match；frequency/LUFS；限制EQ幅度；reset
- 具體介面入口：參考→加入／切換；比較→套用建議
- 引擎與資料契約：各buffer實際rate；range-aware分析；建議與套用分開
- 保存與復原：來源與對照range保存；套EQ入history；外部audio權利不推定
- 預覽與匯出：reference/preview永不混入export；只套用明確選擇的修改
- 驗收：相同內容跨rate不得產生大EQ差；undo；參考只監聽
- 前置依賴：DAW-NAV04、DAW-PRJ06
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)；[Apple Logic Loudness Meter](https://support.apple.com/en-ae/guide/logicpro/lgce12d9d256/10.7/mac/11.0)

### DAW-ANA05 分離與生成品質檢查

層級：專業深化｜現況：未實作

- 白話用途：知道新聲音是否殘漏或傷了音頭
- 子功能與選項：原mix對照；vocal漏伴奏；bleed；artifact時間標記；transient／stereo；候選比較
- 具體介面入口：結果→品質檢查；問題標記→循環試聽
- 引擎與資料契約：客觀指標只標已測部分；人工授權corpus與聽測不可省
- 保存與復原：QC帶source/model/config/revision；接受／拒絕留記錄
- 預覽與匯出：未合格結果可保留候選但不能標validated delivery
- 驗收：synthetic只能驗邊界；真音樂多風格盲聽、延遲／相位／殘漏檢查
- 前置依賴：DAW-STM01
- 技術參照：[Ableton Live 12 官方手冊 聲部分離](https://www.ableton.com/en/live-manual/12/stem-separation/)

### DAW-ANA06 分析工作流與不確定度

層級：專業深化｜現況：未實作

- 白話用途：不讓AI猜測變成不可見自動修正
- 子功能與選項：source/final選擇；range；算法版本；coverage；候選；確認；失效與重算
- 具體介面入口：分析結果→詳情／接受目標／忽略
- 引擎與資料契約：AnalysisResult與MusicalTarget是不同資料型別；revision守衛
- 保存與復原：analysis可重建，人工確認意圖持久化；取消不改audio
- 預覽與匯出：只有ProcessingCommand才改輸出；analysis本身render N/A
- 驗收：舊分析晚到、新版本改完、無可信結果都不套錯目標
- 前置依賴：DAW-PRJ01、DAW-NAV05
- 技術參照：[Ableton Live 12 官方手冊 音訊速度與伸縮](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/)；[Ableton Live 12 官方手冊 調律系統](https://www.ableton.com/en/live-manual/12/using-tuning-systems/)

## 音高人聲與演唱製作

### DAW-VOC01 音高曲線與音符編輯

層級：專業深化｜現況：未實作

- 白話用途：看見唱得高低再選擇怎麼修
- 子功能與選項：F0／voicing；note split/merge；target；pitch center；drift；vibrato；transition
- 具體介面入口：下方→旋律；音符檢查器；播放目標音
- 引擎與資料契約：F0與note model；單聲部／多聲部能力明示；參照深度F04–F06
- 保存與復原：非破壞note ops與target保存／undo；原曲線保留
- 預覽與匯出：render真正用pitch引擎；不能只移圖形
- 驗收：唱名未知仍可導音比對；氣音不硬編音符；聲音與圖／export一致
- 前置依賴：DAW-EDT01、DAW-ANA06
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)；[Apple Logic 奏法編輯](https://support.apple.com/en-euro/guide/logicpro/lgcp8c1f6f14/mac)

### DAW-VOC02 移調與共振峰

層級：專業深化｜現況：未實作

- 白話用途：分清唱高低與改聲音質感
- 子功能與選項：整句／單音transpose；cents；formant shift；preserve；transition；range
- 具體介面入口：旋律→升降；音色→共振峰；重設所選
- 引擎與資料契約：獨立pitch/time/formant處理與支持矩陣；深度F06
- 保存與復原：每dimension可獨立undo/reset；原audio不變
- 預覽與匯出：品質模式與延遲/tails計入final render
- 驗收：音高改變時長可保持；共振峰不等同指定人聲身份
- 前置依賴：DAW-VOC01、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊速度與伸縮](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/)

### DAW-VOC03 替換上傳人聲與拼接

層級：核心常用｜現況：未實作

- 白話用途：用另一份錄音換某句，先服務上傳流程
- 子功能與選項：只換vocal文件；起點；gain；time-align；takes；comp；crossfade；保留伴奏
- 具體介面入口：選vocal片段→替換錄音→上傳；版本列→使用
- 引擎與資料契約：candidate assets／take lanes／comp map；現四檔重匯不能代替
- 保存與復原：保留原vocal、stem處理和新候選；完整undo與持久化
- 預覽與匯出：只在選區替換，輸出其餘伴奏/句外不變
- 驗收：不必重匯四檔；錯檔保留舊版本；接縫／對齊／重開驗證
- 前置依賴：DAW-EDT01、DAW-EDT03、DAW-PRJ04、DAW-STM03
- 技術參照：[Ableton Live 12 官方手冊 多版本錄音拼接](https://www.ableton.com/en/live-manual/12/comping/)

### DAW-VOC04 AI人聲音色轉換

層級：專業深化｜現況：未實作

- 白話用途：保持演唱內容，生成已授權聲音候選
- 子功能與選項：模型；授權；語言／音域；範圍；短句試做；版本；成本／佇列
- 具體介面入口：人聲→AI音色→預覽此句／生成／使用版本
- 引擎與資料契約：專門voice-conversion provider；不能用formant滑桿冒充；深度F13–F14
- 保存與復原：source/model/version/consent/job綁定；原音不覆寫
- 預覽與匯出：只輸出使用者選中的完成候選；未生成禁export該候選
- 驗收：相同歌詞旋律節奏保真、瑕疵聽測、失敗／過期不串結果
- 前置依賴：DAW-VOC03、DAW-NAV05、DAW-PRI01、DAW-PRI02
- 技術參照：[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

### DAW-VOC05 歌詞對齊與改詞重唱

層級：專業深化｜現況：未實作

- 白話用途：讓文字、音節、旋律和時間對得上
- 子功能與選項：原新詞；音節邊界；一字多音；發音；字數時長；melody lock；句前後context
- 具體介面入口：下方→歌詞；選句→改詞重唱→短句預覽
- 引擎與資料契約：alignment＋singing-generation獨立能力；深度F15–F16
- 保存與復原：原詞、target melody、候選和模型版本可回復
- 預覽與匯出：選句之外不重唱；輸出前顯示實際採用版本
- 驗收：新詞真的唱出；多字不截斷；中文多音字、長音、接縫測試
- 前置依賴：DAW-VOC01、DAW-VOC04、DAW-ANA06
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)

### DAW-VOC06 演唱表情與人聲層次

層級：專業深化｜現況：未實作

- 白話用途：細調字句、和聲、加倍而非一個感情旋鈕
- 子功能與選項：字音量；尾音；breath/sibilance；double；harmony interval；range；dry/wet
- 具體介面入口：人聲→表情／和聲；逐字檢查器
- 引擎與資料契約：表情參數需真engine支援；和聲新track／asset；深度F12/F17
- 保存與復原：獨立layers、來源與參數可mute／undo／reset
- 預覽與匯出：和聲和原唱分軌；渲染scope和latency對齊
- 驗收：音域／和弦衝突提示，保留氣息選項；不以隨機抖動假裝自然
- 前置依賴：DAW-VOC01、DAW-ANA02、DAW-GRA01
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

## 上傳音訊加原文歌詞對時

### DAW-LYR01 原文歌詞匯入與鎖定

層級：核心常用｜現況：不完整

本地已做：已整合貼上原文、一行一句、空行與重複句保留及明確套用動作；自動文字辨識未接入。 整合後瀏覽器操作尚未重驗。

- 白話用途：音檔加正確的一行一句歌詞，模型只找時間
- 子功能與選項：rawText；lineId；重複句；空行；非演唱行標記；原文版本；差異檢查
- 具體介面入口：歌詞→貼上原詞→逐行預覽→以這份原文對時
- 引擎與資料契約：原文不可變；analysisText／phoneme mapping獨立；參照歌詞附錄L01/L02
- 保存與復原：保存收到的原字串與行序；改原文產生新revision可undo
- 預覽與匯出：TXT原文保持文字換行；所有字幕格式回指原lineId
- 驗收：對時及重跑不改標點/字詞/重複行；Unicode與原文差異檢查
- 前置依賴：DAW-ING01
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

### DAW-LYR02 多語逐句自動對時

層級：核心常用｜現況：未實作

- 白話用途：尋找每句真的何時開始和結束
- 子功能與選項：主要語言；混語行；發音提示；voiced/unvoiced；模型能力；原始時間offset
- 具體介面入口：歌詞→語言／發音；對時→第一輪；結果→每句範圍
- 引擎與資料契約：ASR可輔助定位，不能覆原詞；FFmpeg只準備音訊；參照L02–L04
- 保存與復原：結果帶lineId/source hash/model/range；原音座標保持；可撤回
- 預覽與匯出：只用已採用timings輸出；找不到就待確認，不平均分配假成功
- 驗收：國語/外語/混語、crop/SRCoffset、前奏長靜音、模型未接時禁用自動
- 前置依賴：DAW-LYR01
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

### DAW-LYR03 漏句與低信心第二輪

層級：核心常用｜現況：未實作

- 白話用途：找出疑點後只重跑需要的句子
- 子功能與選項：missing/duplicate/overlap；前奏間奏；重複副歌；confidence reasons；retryrange；保留已确認
- 具體介面入口：左歌詞低信心清單→跳句；選行→重跑此段；候選比對
- 引擎與資料契約：qualitydiagnostics與forcedaligner分開；限定搜尋窗；L05–L07
- 保存與復原：已手調/確認行鎖定；二次結果成候選，接受才替換；undo
- 預覽與匯出：未解決行在匯出前明示；不把低可信偷偷當完成
- 驗收：漏句、實唱與原詞不同、間奏、重複句；局部重跑不動已確認行
- 前置依賴：DAW-LYR02
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

### DAW-LYR04 波形校正與鍵盤打點

層級：核心常用｜現況：不完整

本地已做：已整合波形定位、毫秒數值、鍵盤打點、逐句播放與循環；拖動時間邊界、縮放與逐字對齊尚未完成。 整合後瀏覽器操作尚未重驗。

- 白話用途：用看和聽把每句時間調準
- 子功能與選項：開始/結束handles；ms步進；循環前後文；打點快捷鍵；聲學/顯示offset；overlap政策
- 具體介面入口：左歌詞清單＋中央波形＋右時間欄；按句播放／拖動／鍵盤微調
- 引擎與資料契約：句級timing model；聲學邊界與字幕顯示邊界分離；L08/L09
- 保存與復原：每次拖曳或打點一個undo；選取和原文不變
- 預覽與匯出：導出使用明確displaytiming；不是改audio；不要求完整DAW才可做
- 驗收：無鼠鍵盤操作、句首句尾、快速連點、undo、播放時保持同一source
- 前置依賴：DAW-LYR01
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

### DAW-LYR05 歌詞專案與可恢復對時

層級：核心常用｜現況：不完整

本地已做：已整合歌詞JSON保存、同原檔核對、本機單一備份及本頁復原；不包含音檔、完整DAW工程或持久化復原紀錄。 整合後瀏覽器操作尚未重驗。

- 白話用途：下次打開仍保留原詞、時間和確認狀態
- 子功能與選項：projectsource；rawtextrevision；timings；confidence；manual locks；job IDs；autosave
- 具體介面入口：歌詞→儲存／開啟；恢復中心；原文差異
- 引擎與資料契約：lyricsession可先獨立於完整DAW；版本化schema；L11
- 保存與復原：原子保存／恢復副本／undojournal；音訊失聯可重連
- 預覽與匯出：render/subtitle輸出都帶lyricsrevision；舊結果不冒充新歌詞
- 驗收：保存重開、來源更換、原詞修訂、quota與崩潰；不混入舊timings
- 前置依賴：DAW-LYR01、DAW-LYR04
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

### DAW-LYR06 LRC SRT ASS TXT四格式

層級：核心常用｜現況：不完整

本地已做：已整合LRC/SRT/ASS/TXT逐句輸出與格式檢查；LRC拒絕重疊，SRT/ASS可明確允許；未做逐字卡拉OK與所有播放器相容性驗證。 整合後瀏覽器操作尚未重驗。

- 白話用途：把已確認的逐句時間交給播放器或剪輯軟體
- 子功能與選項：LRC句首；SRT起訖序號；ASSstyles/events；TXT原文/帶時碼選擇；UTF8；rounding；重疊；karaoke另選
- 具體介面入口：歌詞→匯出→LRC／SRT／ASS／TXT→驗證摘要／下載
- 引擎與資料契約：各格式獨立serializer/parser與escaping；真音節時間才可做ASSkaraoke；L10/L12
- 保存與復原：exportrecipe綁文字/timingrevision；不改原詞；可重跑
- 預覽與匯出：校驗start<end、邊界、格式精度與原文一致；不以字幕可解析推定聽對
- 驗收：roundtrip各parser、CJK/混語/換行/特殊字元、時碼排序、播放器實測；無等分fake timing
- 前置依賴：DAW-LYR04、DAW-LYR05
- 技術參照：[WaveForge 原文歌詞對時附錄 L01–L12](LYRICS_ALIGNMENT_SPEC_ZH_TW.md)

## 現有分軌類別的深化

### DAW-STM01 雲端分離與結果狀態

層級：核心常用｜現況：不完整

- 白話用途：從完整歌曲得到可處理聲部
- 子功能與選項：配置／可用性；模型版本；來源長度；upload/progress；retry；cancel；結果核對
- 具體介面入口：分軌→分離；任務中心；資料傳送說明
- 引擎與資料契約：實際HF/Gradio/SSE流程已存在；server停止／delete缺失要分開
- 保存與復原：source hash/模型/輸出映射保存；晚結果不可覆新工程
- 預覽與匯出：只允許真實完成且可解碼的stems進bounce
- 驗收：缺stem、空檔、timeout、不同長度、失敗重試；mock不是品質證明
- 前置依賴：DAW-ING01、DAW-NAV05、DAW-PRI02
- 技術參照：[Ableton Live 12 官方手冊 聲部分離](https://www.ableton.com/en/live-manual/12/stem-separation/)

### DAW-STM02 四固定聲部混音

層級：核心常用｜現況：已接通

- 白話用途：現有分離聲部能真的調音量與效果
- 子功能與選項：vocal/drums/bass/other；EQ/comp；pan/vol；mute/solo；零點同步；Bounce
- 具體介面入口：分軌頁→每軌控制／播放／Bounce
- 引擎與資料契約：現有shared stem graph真DSP與同步零點source；不是任意clip timeline
- 保存與復原：現有stem edits未有完整undo／持久化，須清楚顯示
- 預覽與匯出：現有offline Bounce接母帶；避免重複套DSP
- 驗收：每control確實改聲；mute/solo與bounce一致；新範圍不冒稱已支援
- 前置依賴：DAW-ING01
- 技術參照：[Ableton Live 12 官方手冊 混音](https://www.ableton.com/en/live-manual/12/mixing/)

### DAW-STM03 獨立聲部匯入替換

層級：核心常用｜現況：未實作

- 白話用途：只換一軌，不重匯整組且不丟設定
- 子功能與選項：單軌替換；保留／重設處理選擇；名稱映射；mono/stereo；長度檢查
- 具體介面入口：stem軌頭→更換檔案／新增聲部
- 引擎與資料契約：stem asset與channel strip解耦；accept generation守衛
- 保存與復原：替換前保留資產／params；可undo，保存reference
- 預覽與匯出：未換聲部不變；render使用確認的新asset
- 驗收：錯檔不中斷；交換聲部名不錯配；對齊/控制值/undo保留
- 前置依賴：DAW-AST01、DAW-PRJ02
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-STM04 分軌長度與延遲對齊

層級：專業深化｜現況：未實作

- 白話用途：不同來源或模型輸出放回去不漂移
- 子功能與選項：原長度；trim/pad規則；sample offset；跨rate；可視對齊；相位反轉檢查
- 具體介面入口：分軌→對齊檢查；每軌→offset
- 引擎與資料契約：source sample位置與rate轉換；alignmentmanifest
- 保存與復原：對齊metadata可存可undo，不改原stem
- 預覽與匯出：共同起點、共同長度；尾音政策明示
- 驗收：脈衝、多rate、短長stem、反相；recombine與original殘差有解釋
- 前置依賴：DAW-ING04、DAW-STM03
- 技術參照：[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-STM05 分離殘漏與重建試聽

層級：專業深化｜現況：未實作

- 白話用途：聽清楚是模型瑕疵還是混音改動
- 子功能與選項：乾stem sum；原mix差值；solo bleed；共同gain；model candidates；QC標記
- 具體介面入口：分軌→原mix／乾合成／修改後；聽差值
- 引擎與資料契約：原始sum/reference對齊；模型允許的重建誤差另測
- 保存與復原：分析與標記綁版本；候選互不覆蓋
- 預覽與匯出：不能把sum不等於original一概歸為錯誤，也不宣稱完美分離
- 驗收：真素材testset測vocalbleed／瞬態／stereo；source與sum同音量聽
- 前置依賴：DAW-STM04、DAW-ANA05、DAW-NAV04
- 技術參照：[Ableton Live 12 官方手冊 聲部分離](https://www.ableton.com/en/live-manual/12/stem-separation/)

### DAW-STM06 分軌編輯歷史與專案化

層級：專業深化｜現況：未實作

- 白話用途：分軌改動不會一重開就不見
- 子功能與選項：每軌snapshot；effects順序；asset引用；版本；stemgroup標記
- 具體介面入口：分軌→儲存到工程；歷史→stem操作
- 引擎與資料契約：固定stems升級成真正Track實體／group
- 保存與復原：全stem操作進統一history與持久化，禁止各面板隱藏副本
- 預覽與匯出：bounce對應同一savedrevision
- 驗收：改gain/replace/mute/route後undo、存關重開、export一致
- 前置依賴：DAW-PRJ01、DAW-PRJ02、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Ableton Live 12 官方手冊 混音](https://www.ableton.com/en/live-manual/12/mixing/)

## 路由效果鏈與延遲

### DAW-GRA01 統一音訊圖與音軌模型

層級：核心常用｜現況：未實作

- 白話用途：編輯、混音與匯出使用同一套真資料
- 子功能與選項：audio/MIDI/instrument/bus/return/master；channel layout；topology；gainstage
- 具體介面入口：軌道→新增類型；混音台→signalflow
- 引擎與資料契約：typed graph；input/output ports；cycle validation；single transport
- 保存與復原：graph與tracks持久化，變更transaction可undo
- 預覽與匯出：live/offline sharedgraph但還需獨立算法oracle
- 驗收：同graph來源與outputscope；阻止無意feedback；改route不中斷state
- 前置依賴：DAW-PRJ01、DAW-AST01
- 技術參照：[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

### DAW-GRA02 群組母線與回送

層級：專業深化｜現況：未實作

- 白話用途：多軌一起處理或共用混響
- 子功能與選項：bus/group；return；pre/postfader；sendlevel/pan；solo-safe；mute規則
- 具體介面入口：混音台→送出／輸出；新增→母線／回送
- 引擎與資料契約：signalflow與sendtap明確；多路彙總；reference路由隔離
- 保存與復原：route/pan/send值可undo保存；刪bus須預覽影響
- 預覽與匯出：stem export需明示return/master是否包含
- 驗收：send pre/post、solo、mute、bus刪除與reload；無重複聲音
- 前置依賴：DAW-GRA01
- 技術參照：[Ableton Live 12 官方手冊 混音](https://www.ableton.com/en/live-manual/12/mixing/)；[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

### DAW-GRA03 側鏈與偵測來源

層級：專業深化｜現況：未實作

- 白話用途：讓鼓點控制低音壓縮而非直接加在聲音裡
- 子功能與選項：source track；pre/post tap；filter；listen；gain；mono/stereo link
- 具體介面入口：效果器→側鏈；路由矩陣→偵測輸入
- 引擎與資料契約：control sidechain port與audio混合分離；防循環
- 保存與復原：sidechain graph與settings可存／undo
- 預覽與匯出：solo/stem輸出要保留所需偵測來源，即使不輸出其聲音
- 驗收：kick-trigger fixture；solo/bounce/stem保留動作；missing source明示
- 前置依賴：DAW-GRA01、DAW-GRA02
- 技術參照：[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)；[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)

### DAW-GRA04 效果鏈與並行處理

層級：專業深化｜現況：未實作

- 白話用途：看得懂先後順序和乾濕混合
- 子功能與選項：insert reorder；bypass；wet/dry；parallelchains；macro範圍；gain match
- 具體介面入口：每軌→效果鏈；拖動與上下移按鈕；鏈內→A/B
- 引擎與資料契約：stable device/param IDs；latency-aware dry/wet；channel validation
- 保存與復原：完整device狀態可存；reorder/replace可undo
- 預覽與匯出：render同順序；並行延遲必須補償，不只音量混合
- 驗收：串並聯脈衝、移除plugin、bypass／mix端點；保存等效
- 前置依賴：DAW-GRA01、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-GRA05 缺失或故障效果器恢復

層級：專業深化｜現況：未實作

- 白話用途：外掛壞了也能救工程
- 子功能與選項：missing／blocked／unsupported／license／crashed；placeholder；retry；explicit bypass
- 具體介面入口：效果鏈警示→詳情／重試／暫時旁路；設定→元件狀態
- 引擎與資料契約：保留opaque state／automation／routing；故障隔離；scan與runtime分開
- 保存與復原：不因缺外掛刪參數；可恢復原instance；bypass入history
- 預覽與匯出：必要processor不可無聲跳過成功輸出；須明確決策
- 驗收：processor載入失敗仍能點旁路；重裝／恢復後state回來
- 前置依賴：DAW-GRA04、DAW-PRJ05
- 技術參照：[Ableton 外掛缺失原因](https://help.ableton.com/hc/en-us/articles/115000349184-VST-AU-plug-in-doesn-t-appear-in-Live-s-Browser)；[REAPER 官方技術能力](https://www.reaper.fm/about.php)；[Steinberg Cubase 9 Plug-in Sentinel 歷史實作參考](https://helpcenter.steinberg.de/hc/en-us/articles/207348390-Plug-in-Sentinel-for-Cubase-9)

### DAW-GRA06 全鏈延遲與渲染尾音

層級：專業深化｜現況：不完整

- 白話用途：各軌、乾濕和導出尾音對齊
- 子功能與選項：reported latency；lookahead；oversampling；PDC；tail duration；dynamic latency；bypasspolicy
- 具體介面入口：工程→音訊診斷；每device→延遲；匯出→尾音
- 引擎與資料契約：現有局部MBC補償不等於全圖PDC；圖級latency/tail計算
- 保存與復原：延遲相關設定與algorithm version入recipe；改變使cache失效
- 預覽與匯出：分配補償前後sample和tails；不能只render source長度
- 驗收：impulse／EOFsignal／reverbtail／sidechain／ratechanges；live/offline同步
- 前置依賴：DAW-GRA01、DAW-PRJ06
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)；[Ableton Live 12 官方手冊 資源與CPU策略](https://www.ableton.com/en/live-manual/12/computer-audio-resources-and-strategies/)

### DAW-GRA07 凍結與解凍

層級：專業深化｜現況：未實作

- 白話用途：處理太重時先算好，仍可回去調
- 子功能與選項：freeze範圍；pre/postFX；channel；tail；quality；stale判定；unfreeze
- 具體介面入口：軌頭→凍結／解凍；狀態標記
- 引擎與資料契約：cache取代子圖；依asset/param/automation/tempo版本失效
- 保存與復原：保留原clip/instrument/FX完整資料；不破壞undo
- 預覽與匯出：凍結與非凍結輸出在允許誤差內；缺cache可重建
- 驗收：改tempo/automation/send後失效；關閉重開；原設定完整恢復
- 前置依賴：DAW-GRA06、DAW-EDT09
- 技術參照：[Apple Logic 凍結音軌](https://support.apple.com/en-euro/guide/logicpro/lgcpf1cbfd51/mac)；[Ableton Live 12 官方手冊 資源與CPU策略](https://www.ableton.com/en/live-manual/12/computer-audio-resources-and-strategies/)

### DAW-GRA08 第三方外掛宿主

層級：專項選配｜現況：未實作

- 白話用途：用支援的平台外掛而非假裝瀏覽器能載VST
- 子功能與選項：browser DSP/WAM；native VST/AU等選配；format/OS/CPU表；scan/quarantine；state
- 具體介面入口：設定→外掛管理；素材→效果器；鏈→載入
- 引擎與資料契約：現在純Web不具native binary host；要另架構決策；不默默安裝nativehelper
- 保存與復原：plugin ID/version/opaque state/assets保存；缺失placeholder
- 預覽與匯出：offline/realtime能力分開；DRM/architecture不相容明示
- 驗收：scan crash與playbackcrash分別測；callback/state安全；不自動降級替代format
- 前置依賴：DAW-GRA05、DAW-PRI03
- 技術參照：[REAPER 官方技術能力](https://www.reaper.fm/about.php)；[Steinberg Cubase 9 Plug-in Sentinel 歷史實作參考](https://helpcenter.steinberg.de/hc/en-us/articles/207348390-Plug-in-Sentinel-for-Cubase-9)；[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

## 既有母帶和混音處理的深化

### DAW-DSP01 參數化均衡器

層級：核心常用｜現況：不完整

- 白話用途：有針對性調低濁感或刺耳頻段
- 子功能與選項：band type；Hz；gain dB；Q/bandwidth；slope；perbandbypass；M/S/左右選配；phase mode
- 具體介面入口：母帶／每軌→EQ；曲線點與數值欄；聽選定頻段
- 引擎與資料契約：既有ten-band/HP/LP實際DSP；擴充參數依engine能力，不畫假旋鈕
- 保存與復原：參數／bypass／phase模式可存undo；reset範圍明示
- 預覽與匯出：FIR/linearphase若只offline需finalpreview且補latencytail
- 驗收：impulse/frequency-response／極端Q／Nyquist／多rate；bypassidentity與控制值往返
- 前置依賴：DAW-GRA04、DAW-GRA06
- 技術參照：[Apple Logic Channel EQ](https://support.apple.com/en-ie/guide/logicpro/lgcef1edc1d7/mac)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-DSP02 動態均衡與多頻段壓縮

層級：專業深化｜現況：不完整

- 白話用途：只在某頻段太強時壓住
- 子功能與選項：bandedges；threshold；ratio；attack/release；range；knee；makeup；mix；link
- 具體介面入口：母帶→DynamicEQ/MBC；每段展開；gain-reduction表
- 引擎與資料契約：現有processors真接通；分频與wet/dry延遲需校準
- 保存與復原：每band狀態與history保存；worklet失敗可明確旁路
- 預覽與匯出：preview/export同processors；crossovers／delay進recipe
- 驗收：各band訊號、dry/wet端點、makeup／bypass、多rate和EOF
- 前置依賴：DAW-GRA05、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)；[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-DSP03 壓縮器

層級：核心常用｜現況：不完整

- 白話用途：控制忽大忽小並保留音頭
- 子功能與選項：threshold；ratio；knee；attack/release；detector；sidechainfilter；makeup；mix；meter
- 具體介面入口：音軌→壓縮；基本／進階；輸入輸出與壓縮量
- 引擎與資料契約：detector/envelope/gainlaw；attack是反應形狀非統一延時保證
- 保存與復原：parameters與bypass可存undo；預設不隱藏autogain
- 預覽與匯出：render同狀態；lookahead/PDC／tail補償
- 驗收：階梯振幅、tonebursts、輸入輸出曲線、bypass和並行相位
- 前置依賴：DAW-GRA03、DAW-GRA06
- 技術參照：[Apple Logic Compressor](https://support.apple.com/en-tj/guide/logicpro/lgcef1bec9f3/mac)

### DAW-DSP04 Gate與Expander

層級：專業深化｜現況：未實作

- 白話用途：減少空隙底噪，不吞掉小聲字
- 子功能與選項：threshold；range；attack；hold；release；hysteresis；lookahead；sidechainlisten
- 具體介面入口：清理／效果→Gate；開關狀態與衰減量
- 引擎與資料契約：gate狀態機；hysteresis防抖；不是通用降噪替代
- 保存與復原：設定可存undo，原audio保留
- 預覽與匯出：看前／尾音延遲一致；噪音門不得截掉句尾
- 驗收：閾值附近抖動、柔聲、氣息、長reverbtail；旁路與EOF
- 前置依賴：DAW-GRA04、DAW-GRA06
- 技術參照：[Apple Noise Gate 舊版原理參考](https://help.apple.com/logicpro/mac/9.1.6/en/logicpro/effects/chapter_4_section_10.html)

### DAW-DSP05 齒音與人聲清晰度

層級：核心常用｜現況：不完整

- 白話用途：減少嘶聲但保留咬字
- 子功能與選項：frequency/range；threshold；wide/split若支持；listen；reduction meter；bypass
- 具體介面入口：人聲／母帶→去齒音；試聽偵測頻段
- 引擎與資料契約：既有deesserworklet；明確detector與band能力
- 保存與復原：參數可undo；失敗時仍可旁路不鎖死
- 預覽與匯出：相同range與version進export；不把去齒音稱AI換聲
- 驗收：sibilantfixture／無齒音／弱子音；失敗恢復與音量匹配
- 前置依賴：DAW-GRA05、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)

### DAW-DSP06 飽和與失真

層級：核心常用｜現況：不完整

- 白話用途：增加諧波與質感但控制音量偏差
- 子功能與選項：drive；curve；mix；output；oversampling；DCfilter；gain match
- 具體介面入口：母帶／音軌→飽和；進階→品質；原版比較
- 引擎與資料契約：現有waveshaper；oversampling latency依實際實作校驗
- 保存與復原：algorithm/quality/drive/mix保存與undo
- 預覽與匯出：live與offline若品質不同明示；防止重複gain match入輸出
- 驗收：頻譜／混疊／DC／多rate／dry/wet對齊；不拿變大聲冒充更好
- 前置依賴：DAW-GRA06、DAW-NAV04
- 技術參照：[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-DSP07 Limiter與最終峰值保護

層級：核心常用｜現況：不完整

- 白話用途：把交付最大聲限制在選定範圍
- 子功能與選項：input；ceiling；release；lookahead；truepeak estimator；stereo link；減量；失敗policy
- 具體介面入口：母帶→Limiter；匯出→峰值安全；QC結果
- 引擎與資料契約：現有finalPCM estimator檢查不等於獨立認證／編碼後保證
- 保存與復原：完整設定與estimator版本入recipe；可undo
- 預覽與匯出：量化／codec後需另QC；tail與EOF處理；不得無聲clamp
- 驗收：獨立ISP向量、EOF、quiet不boost、立體聲關係、PCM與post-codec分別驗
- 前置依賴：DAW-GRA06
- 技術參照：[Apple Logic Limiter](https://support.apple.com/en-asia/guide/logicpro/lgcef1becd08/mac)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-DSP08 混響與空間

層級：專業深化｜現況：未實作

- 白話用途：用共用空間讓聲部融合
- 子功能與選項：algorithm／IR；predelay；decay；damping；early/late；width；dry/wet；tail
- 具體介面入口：音軌效果／send return→混響；IR匯入
- 引擎與資料契約：algo/convolution引擎；IRasset權利；RT/offlinetail
- 保存與復原：IR引用與params可存undo；missingIRplaceholder
- 預覽與匯出：tail政策／returnstem inclusion／offline品質明示
- 驗收：脈衝尾音、predelay、stereo、乾濕相位；結尾不截斷
- 前置依賴：DAW-GRA02、DAW-GRA06、DAW-AST01
- 技術參照：[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)

### DAW-DSP09 Delay與調變效果

層級：專業深化｜現況：未實作

- 白話用途：節拍回聲和可控的聲音變化
- 子功能與選項：ms/beat同步；dotted/triplet；feedback；filter；pingpong；chorus/flanger rate/depth；wet/dry
- 具體介面入口：效果器→Delay／Modulation；節奏同步開關
- 引擎與資料契約：tempo-aware DSP與feedback安全；各效果獨立能力
- 保存與復原：tempo sync設定、LFO phase／seed策略可存
- 預覽與匯出：tail、feedback循環上限、realtime/offline一致
- 驗收：tempo變更、seek/loop、feedback極限、無NaN／無失控爆音
- 前置依賴：DAW-ARR01、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 音訊效果參照](https://www.ableton.com/en/live-manual/12/live-audio-effect-reference/)

### DAW-DSP10 立體聲與相位工具

層級：專業深化｜現況：不完整

- 白話用途：調寬窄並檢查單聲道相容
- 子功能與選項：pan/balance區分；width；M/S；polarity；mono check；channel swap；correlation
- 具體介面入口：混音台→聲像；母帶→M/S；監聽→Mono
- 引擎與資料契約：既有M/S；channel matrix與panlaw；monitor-only check分離
- 保存與復原：影響作品的matrix保存undo；monitorcheck存偏好
- 預覽與匯出：mono check不烘入export，除非明確選mono交付
- 驗收：L/R/mono/anti-phase fixtures；不加大造成假寬度；回復與render一致
- 前置依賴：DAW-GRA01、DAW-ING05
- 技術參照：[Ableton Live 12 官方手冊 混音](https://www.ableton.com/en/live-manual/12/mixing/)；[Apple Logic 聲像法則](https://support.apple.com/en-gu/guide/logicpro/lgcp4f230784/mac)

## 自動化與參數時間變化

### DAW-AUTO01 自動化曲線編輯

層級：專業深化｜現況：未實作

- 白話用途：讓音量、效果隨時間變化
- 子功能與選項：參數選取；節點／曲線；copy/paste；snap；scale；lane；值與單位
- 具體介面入口：音軌→顯示自動化；參數選單→建立曲線
- 引擎與資料契約：stable paramIDs；sample/beat timestamp；插值／smoothing規則
- 保存與復原：曲線為工程資料，修改transaction可undo
- 預覽與匯出：同時間求值用於live/offline，不取render當下UI值
- 驗收：節點／段／tempochange／seek／loop；存關重開和輸出一致
- 前置依賴：DAW-PRJ01、DAW-GRA04
- 技術參照：[Ableton Live 12 官方手冊 自動化](https://www.ableton.com/en/live-manual/12/automation/)

### DAW-AUTO02 自動化讀寫模式

層級：專業深化｜現況：未實作

- 白話用途：知道推桿會暫時改還是覆寫已有曲線
- 子功能與選項：Off/Read；Touch；Latch；Write；write-enable；返回時間；危險提示
- 具體介面入口：每軌自動化模式；播放列→寫入許可
- 引擎與資料契約：模式狀態機；Touch放手返回／Latch保持／Write覆寫明確
- 保存與復原：一次寫入pass可undo；事故不永久毀曲線
- 預覽與匯出：回放使用提交曲線；模式本身不意外改export
- 驗收：進出Touch/Latch/Write、stop、斷控制器；既有曲線保護
- 前置依賴：DAW-AUTO01
- 技術參照：[Apple Logic 自動化模式](https://support.apple.com/en-euro/guide/logicpro/lgcpb1a6ab26/mac)

### DAW-AUTO03 相對與Trim自動化

層級：專業深化｜現況：未實作

- 白話用途：整體調輕一點又保留原起伏
- 子功能與選項：absolute/relative；trim lane；合併；automation override；re-enable
- 具體介面入口：自動化lane→相對／偏移；控制列→恢復自動化
- 引擎與資料契約：primary/secondary曲線與優先序；參數支援矩陣
- 保存與復原：合併可undo；原曲線副本保留
- 預覽與匯出：render同疊加規則，禁止手動覆寫狀態默默固定
- 驗收：曲線合併前後等效、零trim、極端數值限幅與單位
- 前置依賴：DAW-AUTO01、DAW-AUTO02
- 技術參照：[Apple Logic 自動化模式](https://support.apple.com/en-euro/guide/logicpro/lgcpb1a6ab26/mac)；[Ableton Live 12 官方手冊 自動化](https://www.ableton.com/en/live-manual/12/automation/)

### DAW-AUTO04 片段與軌道自動化關係

層級：專業深化｜現況：未實作

- 白話用途：移動片段時效果到底跟誰走
- 子功能與選項：clip/track lanes；跟片段／鎖歌曲；loopenvelope；regionrelative；copy範圍
- 具體介面入口：自動化→跟隨片段／鎖定時間；片段包絡
- 引擎與資料契約：獨立timebase與composition規則；重疊clip優先序
- 保存與復原：移clip與其automation同交易undo
- 預覽與匯出：render按明確優先序，不雙倍乘錯增益
- 驗收：move/duplicate/ripple/loop/crop後曲線位置與音訊一致
- 前置依賴：DAW-AUTO01、DAW-EDT04
- 技術參照：[Ableton Live 12 官方手冊 片段包絡](https://www.ableton.com/en/live-manual/12/clip-envelopes/)；[Ableton Live 12 官方手冊 自動化](https://www.ableton.com/en/live-manual/12/automation/)

### DAW-AUTO05 自動化密度與平滑

層級：專業深化｜現況：未實作

- 白話用途：高密度旋鈕資料不爆CPU或跳音
- 子功能與選項：thin/simplify；精度；平滑；discrete參數；rate限流；可視原曲線
- 具體介面入口：lane→簡化／平滑；預覽差異
- 引擎與資料契約：error-bounded curve簡化；DSP可接受參數速度
- 保存與復原：簡化前保存可undo；量化／離散參數不插錯值
- 預覽與匯出：輸出差異在設定容差內；不以UI刷新率替代音訊精度
- 驗收：密集資料、高速cutoff、mute/bypass離散值、長檔性能
- 前置依賴：DAW-AUTO01、DAW-QUA02
- 技術參照：[Ableton Live 12 官方手冊 自動化](https://www.ableton.com/en/live-manual/12/automation/)

## 編排速度拍號和參考

### DAW-ARR01 速度與拍號時間圖

層級：核心常用｜現況：未實作

- 白話用途：同時用秒和小節理解上傳歌曲
- 子功能與選項：BPM；tempo changes/ramps；meter；timebase；pickup；snap；manual anchors
- 具體介面入口：全域軌→速度／拍號；播放列數值；設第一拍
- 引擎與資料契約：sample↔musical time map；精度和不同anchor semantics
- 保存與復原：tempo/meter變更可undo；按clip timebase決定是否重排／伸縮
- 預覽與匯出：render節拍同步FX和MIDI使用同tempo；audio是否stretch明示
- 驗收：變速／變拍／弱起／triplet、seek與loop；數值往返不漂
- 前置依賴：DAW-PRJ01、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 音訊速度與伸縮](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/)；[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-ARR02 標記段落與編排

層級：核心常用｜現況：未實作

- 白話用途：把主歌副歌當段落管理
- 子功能與選項：markers；regions；顏色／名稱；移動複製段；regionlist；annotation
- 具體介面入口：全域軌→段落；標記清單；編輯→搬移段落
- 引擎與資料契約：region span與timeline編集聯動；範圍衝突規則
- 保存與復原：段落操作可undo；對應assets／automation一起移
- 預覽與匯出：export可按regions批次；共同命名與起點
- 驗收：複製副歌帶clips／automation／tempo；重叠標記和空段處理
- 前置依賴：DAW-EDT04、DAW-PRJ02
- 技術參照：[Ableton Live 12 官方手冊 線性編排與剪輯](https://www.ableton.com/en/live-manual/12/arrangement-view/)

### DAW-ARR03 調性和弦與旋律參考軌

層級：專業深化｜現況：未實作

- 白話用途：給修音與寫旋律有依據的目標
- 子功能與選項：key timeline；chords；inversions；scale；reference MIDI；人工確認
- 具體介面入口：全域軌→和弦／調性；旋律→參考來源
- 引擎與資料契約：musical target獨立於analysis；keychanges與chord時間
- 保存與復原：人工修正與來源可存undo；非破壞
- 預覽與匯出：本身不改audio；只有明確工具採用才作用
- 驗收：外調音不自動標錯；轉調與target切換；F07深度連結
- 前置依賴：DAW-ANA02、DAW-ANA06、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 調律系統](https://www.ableton.com/en/live-manual/12/using-tuning-systems/)；[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)

### DAW-ARR04 律動與量化模板

層級：專業深化｜現況：未實作

- 白話用途：把選中音向節奏靠近，保留表情
- 子功能與選項：grid；strength；swing；timing/velocity/duration；extractgroove；commit/reset
- 具體介面入口：節奏編輯器→量化／律動庫；套用範圍
- 引擎與資料契約：MIDI與audio不同處理器；template seed／origin；原位置保留
- 保存與復原：預覽非破壞，commit仍可undo；模板版本保存
- 預覽與匯出：輸出作用與preview一致，audio需warp引擎
- 驗收：0/50/100strength、triplet、swing、原起音回復與多軌相位
- 前置依賴：DAW-EDT08、DAW-MID03、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 律動模板](https://www.ableton.com/en/live-manual/12/using-grooves/)

### DAW-ARR05 片段啟動與現場排列

層級：專項選配｜現況：未實作

- 白話用途：用片段試不同組合再記成歌曲
- 子功能與選項：sessiongrid；launch/stop quantize；scenes；followactions；legato；recordarrangement
- 具體介面入口：檢視→片段矩陣；scene按鈕；錄下編排
- 引擎與資料契約：launchscheduler和arrangement ownership；禁止雙重播放
- 保存與復原：表演事件可記成timeline／undo；原clips保留
- 預覽與匯出：輸出固定已錄arrangement，不依現場隨機UI
- 驗收：同拍launch、scene切換、stop、回arrangement不雙播
- 前置依賴：DAW-NAV01、DAW-ARR01、DAW-EDT01
- 技術參照：[Ableton Live 12 官方手冊 片段啟動](https://www.ableton.com/en/live-manual/12/launching-clips/)

## MIDI與逐音表情

### DAW-MID01 MIDI音軌與鋼琴卷軸

層級：專業深化｜現況：未實作

- 白話用途：用音符編輯旋律，MIDI本身不是聲音
- 子功能與選項：note on/off；pitch；start/length；velocity；channel；pianoroll／eventlist
- 具體介面入口：新增→MIDI軌；雙擊clip→鋼琴卷軸
- 引擎與資料契約：noteevents與instrument連結；sample-accurate scheduler
- 保存與復原：note／clip資料可存undo，匯入SMF保留支持欄位
- 預覽與匯出：MIDI需instrument才有audio；SMF匯出另列
- 驗收：draw/move/resize/delete、重開、zero-length/overlap／跨loop無stucknote
- 前置依賴：DAW-PRJ01、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)

### DAW-MID02 MIDI控制曲線與踏板

層級：專業深化｜現況：未實作

- 白話用途：保留彈奏強弱和踏板表情
- 子功能與選項：CC；pitchbend；channelpressure；polyaftertouch；sustain；program/bank；RPN/NRPN支援表
- 具體介面入口：MIDI 編輯器→表情lane／eventlist
- 引擎與資料契約：time-stamped events、chase policy；instrumentcapability
- 保存與復原：原事件保存，編輯可undo；未知事件不默默丟棄
- 預覽與匯出：SMF／render對各event支援與loss清楚
- 驗收：seek到長音中、pedalstop、loop、panic與重開不殘音
- 前置依賴：DAW-MID01
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)；[Ableton Live 12 官方手冊 MPE編輯](https://www.ableton.com/en/live-manual/12/editing-mpe/)

### DAW-MID03 MIDI選取變換與節奏修整

層級：專業深化｜現況：未實作

- 白話用途：快速整理一段音符又能保留原版
- 子功能與選項：quantize；transpose；legato；length/velocityscale；duplicate；humanize seed；filterselect
- 具體介面入口：鋼琴卷軸→工具；預览／套用；選取摘要
- 引擎與資料契約：純note transforms；bounded ranges；seededrandom非好聽保證
- 保存與復原：原note資料與transform可undo；preset保存具體值
- 預覽與匯出：MIDI及audio render同結果，range只作用選取
- 驗收：越界pitch、velocity0語義、重疊note、triplet、seed重現
- 前置依賴：DAW-MID01、DAW-PRJ02
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)；[Ableton Live 12 官方手冊 律動模板](https://www.ableton.com/en/live-manual/12/using-grooves/)

### DAW-MID04 鼓編輯器與步進音序

層級：專業深化｜現況：未實作

- 白話用途：用格子安排鼓點和重音
- 子功能與選項：drummap；stepdivision；velocity；probability；ratchet；perlanepattern；swing
- 具體介面入口：MIDI→鼓格；stepcontrols；鼓件→音色
- 引擎與資料契約：pattern to notes；概率使用可固定seed；mappinginstrument
- 保存與復原：pattern與drummap存工程；每次修改可undo
- 預覽與匯出：offline隨機seed可選固定；render說明是否重抽
- 驗收：pattern長度與tempo變化、概率端點、多ratchet不漏noteoff
- 前置依賴：DAW-MID01、DAW-INS02
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)；[Ableton Live 12 官方手冊 片段啟動](https://www.ableton.com/en/live-manual/12/launching-clips/)

### DAW-MID05 MPE逐音表情

層級：專業深化｜現況：未實作

- 白話用途：和弦裡每個音各自滑音或改質感
- 子功能與選項：per-note pitch/pressure/timbre；zones；bendrange；MPEcapableinstrument；curves
- 具體介面入口：音符→表情；軌道→MPE設定
- 引擎與資料契約：noteidentity與channelallocation；能力協商不能當普通CC
- 保存與復原：每noteexpression保存；拆合note保持曲線關係
- 預覽與匯出：audio render需instrument支援；SMF降級／loss明示
- 驗收：重疊同pitch、zoneoverflow、bendrange、seek/loop/panic
- 前置依賴：DAW-MID01、DAW-MID02
- 技術參照：[Ableton Live 12 官方手冊 MPE編輯](https://www.ableton.com/en/live-manual/12/editing-mpe/)

### DAW-MID06 樂器奏法與Keyswitch

層級：專業深化｜現況：未實作

- 白話用途：切換小提琴長弓短弓等演奏方式
- 子功能與選項：articulation IDs；keyswitch/CC/program映射；names；chase；latch/momentary
- 具體介面入口：音符→奏法；樂器→奏法映射表
- 引擎與資料契約：奏法metadata與輸出事件分離；不要把歌聲咬字混為樂器奏法
- 保存與復原：articulationset版本與noteIDs保存undo
- 預覽與匯出：輸出映射或render，交換格式未支援需報告
- 驗收：從中間播放仍對奏法；keyswitch不發成意外音；換樂器可重映射
- 前置依賴：DAW-MID01、DAW-MID02
- 技術參照：[Apple Logic 奏法編輯](https://support.apple.com/en-euro/guide/logicpro/lgcp8c1f6f14/mac)

### DAW-MID07 微分音與調律

層級：專項選配｜現況：未實作

- 白話用途：製作非十二平均律音樂
- 子功能與選項：tuningtable；referencepitch；scale；perinstrument支援；bendrange；fallback
- 具體介面入口：全域→調律；樂器→調律兼容
- 引擎與資料契約：frequency mapping／MPE／instrument調律能力；不可只換標籤
- 保存與復原：tuningasset與version存工程；可undo／bypass
- 預覽與匯出：不支援的plugin需先render或揭露近似損失
- 驗收：已知頻率向量、八度／移調、不同樂器音高一致
- 前置依賴：DAW-MID05、DAW-INS01
- 技術參照：[Ableton Live 12 官方手冊 調律系統](https://www.ableton.com/en/live-manual/12/using-tuning-systems/)

### DAW-MID08 音訊轉音符與切片

層級：專業深化｜現況：未實作

- 白話用途：從上傳旋律或鼓節奏取得可編輯素材
- 子功能與選項：melody／harmony／drums；threshold；onset；confidence；slice markers；人工修正
- 具體介面入口：片段→轉MIDI／切片到樂器；結果→新軌
- 引擎與資料契約：分析輸出候選note/slices；不同模型／mono/poly能力分離
- 保存與復原：原audio留存；轉換新track，undo可移除引用
- 預覽與匯出：分析誤差可修；轉換不是與原錄音完全等效
- 驗收：單音、和弦、鼓、噪音；輸出音符與來源對照，不假稱準確轉譜
- 前置依賴：DAW-ANA06、DAW-MID01、DAW-INS02
- 技術參照：[Ableton Live 12 官方手冊 音訊轉MIDI](https://www.ableton.com/en/live-manual/12/converting-audio-to-midi/)

## 樂器與取樣

### DAW-INS01 內建樂器與音色庫

層級：專業深化｜現況：未實作

- 白話用途：MIDI能真正發出聲音
- 子功能與選項：instrument選取；preset；polyphony；envelope；filter；tuning；pan/gain；panic
- 具體介面入口：樂器軌→選音色；參數面板；MIDI鍵盤預聽
- 引擎與資料契約：有版本的synth／sampler；real/offlineprocessor一致
- 保存與復原：全部preset值與sampleasset引用保存，不能只存名稱
- 預覽與匯出：離線render有聲；不支援offline的引擎明示
- 驗收：同note/velocity、voice-stealing、all notes off、rate與重開一致
- 前置依賴：DAW-GRA01、DAW-MID01
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-INS02 取樣器與鼓架

層級：專業深化｜現況：未實作

- 白話用途：把上傳聲音變成可彈奏樂器
- 子功能與選項：samplezones；rootnote；key/velocityranges；loop/crossfade；chokegroup；oneshot/gate；outputs
- 具體介面入口：樂器→取樣器／鼓架；拖素材到pad；zoneeditor
- 引擎與資料契約：sample playback／zone/voice規則；素材授權引用
- 保存與復原：sampleassets與zones持久化，改映射可undo
- 預覽與匯出：多outputroute與tail正確，pack含必要素材
- 驗收：loop邊界、不同velocityzone、choke、missingasset與offline對齊
- 前置依賴：DAW-INS01、DAW-AST01、DAW-GRA02
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-INS03 MIDI效果與琶音

層級：專業深化｜現況：未實作

- 白話用途：把和弦按規律變成音符組合
- 子功能與選項：arpeggiator；chord；scale；velocity；noteecho；rate/gate/octaves；seed
- 具體介面入口：MIDI效果鏈；預覽→印成音符
- 引擎與資料契約：MIDI beforeinstrument；tempo-aware；重複noteoff安全
- 保存與復原：preset/state保存；print生成新notes可undo
- 預覽與匯出：realtime與offline事件相同；print後避免雙套
- 驗收：seek/stop/loop不殘音；rate變更與print重放一致
- 前置依賴：DAW-MID01、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 MIDI 編輯](https://www.ableton.com/en/live-manual/12/editing-midi/)；[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-INS04 多音色與多輸出樂器

層級：專項選配｜現況：未實作

- 白話用途：大型samplelibrary分開混音
- 子功能與選項：MIDIparts/channels；outputpairs；articulations；memory；purge；missingcontent
- 具體介面入口：樂器檢查器→parts／輸出；建立對應軌
- 引擎與資料契約：instrumentparts與audioports graph；resource lifecycle
- 保存與復原：多part狀態／assets保存；routingmapping可undo
- 預覽與匯出：stem依輸出／樂器part範圍明示
- 驗收：各part不串音；缺sample保留state；freeze限制明確
- 前置依賴：DAW-INS01、DAW-GRA01、DAW-GRA07
- 技術參照：[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)；[REAPER 官方技術能力](https://www.reaper.fm/about.php)

## 輸出交付與編碼後驗證

### DAW-EXP01 統一渲染任務與配方

層級：核心常用｜現況：不完整

- 白話用途：預覽和交付真正使用同一個已確定版本
- 子功能與選項：範圍；revision；所有DSP；offline/realtime；quality；cancel；stale；checksum
- 具體介面入口：匯出→檢查配方→渲染；任務中心
- 引擎與資料契約：現有final render共用基礎；新增immutablecomplete recipe／jobstate
- 保存與復原：job引用source與snapshot，輸出不可回頭改工程；可重跑
- 預覽與匯出：成功必須真的有有效檔；取消／失敗不留成功假象
- 驗收：改參數、換源、關頁、重試競態；預覽與file數值對照
- 前置依賴：DAW-PRJ06、DAW-NAV05、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-EXP02 現有立體聲音檔輸出

層級：核心常用｜現況：已接通

- 白話用途：把母帶下載成目前支援格式
- 子功能與選項：WAV16/24；MP3；範圍；檔名；目前輸出rate；overload選項
- 具體介面入口：匯出→WAV／MP3；下載完成狀態
- 引擎與資料契約：現有final render及encoder，downloadtrigger不等於使用者已落盤
- 保存與復原：保存render設定仍不完整，需PRJ06；下載不應清工程
- 預覽與匯出：生成檔案含真規格；原始／處理版選擇明示
- 驗收：解析header、decode驗時長聲道；前後PCM適用容差；不宣稱post-codecTP保証
- 前置依賴：DAW-ING01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-EXP03 分軌與母線批次輸出

層級：專業深化｜現況：未實作

- 白話用途：把可重新混音的檔案交給別人
- 子功能與選項：tracks／buses／regions；共同start/end；dry/wet；pre/postfader；returns/main；命名
- 具體介面入口：匯出→分軌／母線；包含效果摘要
- 引擎與資料契約：依signalgraph選render scopes；sidechain依賴仍處理
- 保存與復原：batchrecipe含每檔scope及revision；部分fail可重跑
- 預覽與匯出：明說stems能否recombine；非線性master不保證各軌獨立處理相加相等
- 驗收：共同長度／起點／tails；sum測試與非線性差異；solo不漏sidechain
- 前置依賴：DAW-GRA02、DAW-GRA03、DAW-EXP01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

### DAW-EXP04 尾音與循環輸出

層級：專業深化｜現況：未實作

- 白話用途：混響尾巴完整，循環回頭不接錯
- 子功能與選項：tail none/fixed/auto；maxduration；loopwrap；preroll；rangeboundary；latency
- 具體介面入口：匯出→邊界與尾音；預聽接點
- 引擎與資料契約：graph tails/PDC；loop tail是否wrap政策；避免無限feedback
- 保存與復原：設定入recipe；預覽與export同範圍
- 預覽與匯出：音樂長度和檔案長度分開；tails可padding或獨立尾檔
- 驗收：EOFimpulse、長delay/reverb、loop兩端、silence門檻不切低尾音
- 前置依賴：DAW-GRA06、DAW-EXP01
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-EXP05 檔案規格與Dither

層級：專業深化｜現況：不完整

- 白話用途：用正確格式交付，避免不必要重複量化
- 子功能與選項：PCM16/24/32float；rate；codecbitrate；dither off/TPDF等實支持；mono/stereo；metadata
- 具體介面入口：匯出→進階規格；用途預設→顯示實際值
- 引擎與資料契約：encoder支持矩陣；dither在最終降bitdepth；浮點中間檔策略
- 保存與復原：recipe記bitdepth／dither／encoder版本；非確定noise標明
- 預覽與匯出：不在每個中間步重複dither；不把32float當無限音質
- 驗收：量化noise／DC／低振幅tone、headers、decode、禁重複dither
- 前置依賴：DAW-EXP01、DAW-ING04
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-EXP06 編碼後品管

層級：專業深化｜現況：不完整

- 白話用途：交出的WAV或MP3也檢查，不只看內部PCM
- 子功能與選項：redecode；sample/truepeak；LUFS；duration/channels；invaliddata；report／retry
- 具體介面入口：匯出結果→QC報告／重新處理
- 引擎與資料契約：獨立post-encode decode＋calibratedmeter；不能用同估計器自證全部正確
- 保存與復原：QC綁filehash與recipe，重編碼舊報告失效
- 預覽與匯出：未通過可阻擋宣稱合格；必要明確降低ceiling再重算
- 驗收：已知ISP／codecovershoot向量、長檔、尾音和數值；前編碼與後編碼分開
- 前置依賴：DAW-EXP05、DAW-DSP07
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)；[Apple Logic Loudness Meter](https://support.apple.com/en-ae/guide/logicpro/lgce12d9d256/10.7/mac/11.0)

### DAW-EXP07 專輯響度與順序

層級：專業深化｜現況：不完整

- 白話用途：一組歌銜接自然且交付可重現
- 子功能與選項：trackorder；間隔；targetLUFS；trim；limiter；iterativemeasure；pertrackQC
- 具體介面入口：專輯→排序／間隔；對齊響度→預覽／實測
- 引擎與資料契約：現有alignment估算不能當實測；每曲render後重測，必要有界迭代
- 保存與復原：每曲recipe與order保存／undo，不只RAM；比較保留
- 預覽與匯出：實際final響度與峰值報告；不保證所有歌達標無副作用
- 驗收：不同動態曲、limiter非線性、source rate；測到的final值才標達標
- 前置依賴：DAW-PRJ06、DAW-EXP06
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)；[Apple Logic Loudness Meter](https://support.apple.com/en-ae/guide/logicpro/lgce12d9d256/10.7/mac/11.0)

### DAW-EXP08 CD與專輯交付包

層級：專業深化｜現況：不完整

- 白話用途：知道包內是什麼，不誤稱工業格式
- 子功能與選項：44.1k/16bit；trackindex/gaps；CUE；MD5；ZIP；titlemetadata；DDP選配
- 具體介面入口：專輯→CD Master Package；交付摘要
- 引擎與資料契約：現有WAV+CUE+MD5ZIP是CDpackage，不是DDP2；framealignment
- 保存與復原：albumlayout和render recipe需持久化；任何改動使舊包stale
- 預覽與匯出：檢查cue/time/checksum／frame與PCM一致；不冒稱pressing認證
- 驗收：gap/index邊界、長專輯、中文檔名、ZIP完整性；DDP需另完整引擎測試
- 前置依賴：DAW-EXP07
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-EXP09 格式交換與交付損失報告

層級：專業深化｜現況：未實作

- 白話用途：讓收件人知道哪些編辑可继续用
- 子功能與選項：SMF；AAF／EDL選配；consolidatedstems；tempo/markers；pluginprint；lossmatrix
- 具體介面入口：匯出→工程交換；相容性／不支援摘要
- 引擎與資料契約：writer按版本subset；plugin/midi/automation等保留能力明示
- 保存與復原：輸出副本不變原工程；記recipientformat與revision
- 預覽與匯出：不宣稱AAF等於完整session；附audiofallback與unsupported項
- 驗收：輸入輸出roundtripfixtures逐欄核對，不能只看檔案存在
- 前置依賴：DAW-ING08、DAW-EXP03
- 技術參照：[Apple Logic AAF 匯出](https://support.apple.com/en-euro/guide/logicpro/lgcp7355bedf/mac)；[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

### DAW-EXP10 批次工作與可續交付

層級：專業深化｜現況：未實作

- 白話用途：多首／多版本不靠手動一直點
- 子功能與選項：queue；range presets；命名碰撞；重試；部分完成；資源上限；背景狀態
- 具體介面入口：匯出→加入佇列；任務中心→批次
- 引擎與資料契約：immutable jobs／bounded resources／resume eligibility
- 保存與復原：jobmanifest與完成hash保存，重試不可覆錯版本
- 預覽與匯出：每檔獨立QC，整批缺一不可假全完成
- 驗收：一檔失敗、取消、低disk、改工程後queue仍用原revision
- 前置依賴：DAW-EXP01、DAW-EXP06、DAW-NAV05
- 技術參照：[Ableton Live 12 官方手冊 檔案與工程](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

## 權利隱私與資料流

### DAW-PRI01 聲音素材與模型權利

層級：核心常用｜現況：不完整

- 白話用途：知道哪份素材可上傳、改造或交付
- 子功能與選項：來源；license；同意；模型用途；期限／撤回；敏感音訊；禁止冒充
- 具體介面入口：素材詳情→權利；AI生成前→資料和模型摘要
- 引擎與資料契約：rightsmetadata與asset/model綁定；不是版權真偽判定器
- 保存與復原：授權記錄最少化保存，秘密不入工程；撤回狀態可追蹤
- 預覽與匯出：pack/export檢查授權範圍但不作法律保證；不預設可散布samplelibrary
- 驗收：缺授權、過期模型、敏感voice、匯出package提示與權限隔離
- 前置依賴：DAW-AST01
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-PRI02 本機與雲端資料流

層級：核心常用｜現況：不完整

- 白話用途：分清哪一步會把整首或片段送出去
- 子功能與選項：本機master；HF整檔；ACR片段；metadata庫；保留期；servercancel/delete；delete結果
- 具體介面入口：操作前資料摘要；設定→資料管理；任務→取消／請求刪除
- 引擎與資料契約：實際service capabilities；clientabort≠serverstop≠erase；未知留存明說
- 保存與復原：work/scanrecords與project分開；delete需verified結果，清頁不假刪雲端
- 預覽與匯出：輸出含metadata可選清除；logs去識別／不含rawaudio
- 驗收：攔截網路確認dest/payload；取消／關頁／刪除error；第三方不保證即時擦除
- 前置依賴：DAW-PRI01
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-PRI03 處理元件與擴充權限

層級：專業深化｜現況：未實作

- 白話用途：避免外掛或專案悄悄執行不受信任內容
- 子功能與選項：trustedsource；signature/hash；quarantine；network/files；permissions；sandbox；update
- 具體介面入口：設定→元件管理／權限；載入警示
- 引擎與資料契約：browser DSP/nativehost分層；decode安全；plugin/runtime isolation策略
- 保存與復原：授權token不寫project；只存引用；設定變更audit
- 預覽與匯出：offlineexport不能意外發網路；安全限制需可解釋
- 驗收：惡意metadata／壓縮炸彈／plugincrash／越權路徑；sandbox不是絕對保證
- 前置依賴：DAW-PRJ05
- 技術參照：[Steinberg Cubase 9 Plug-in Sentinel 歷史實作參考](https://helpcenter.steinberg.de/hc/en-us/articles/207348390-Plug-in-Sentinel-for-Cubase-9)；[REAPER 官方技術能力](https://www.reaper.fm/about.php)；[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-PRI04 比對與作品紀錄的真實說明

層級：專業深化｜現況：不完整

- 白話用途：查到相似內容，不把結果當版權裁決
- 子功能與選項：ACR掃描範圍；rawaudioexcerpts；matches；falsepositive；demo標記；metadatahistory
- 具體介面入口：權利工具→掃描詳情／作品紀錄／刪除結果
- 引擎與資料契約：目前送音訊片段經edge到ACR；Supabase長期metadata；結果只做候選
- 保存與復原：來源／時間／範圍保存；刪除需核對API錯誤；不可宣稱離頁全清
- 預覽與匯出：一般audio export不因掃描結果擅自添加標記／限制
- 驗收：空結果/誤匹配/網路錯誤/demo；UI文案與實際資料流相符
- 前置依賴：DAW-PRI02
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

## 交接協作和連線恢復

### DAW-COL01 時間點註解與審閱版本

層級：專業深化｜現況：未實作

- 白話用途：把回饋對準同一個交付版本
- 子功能與選項：time/rangecomments；author；resolved；versionpin；attachments；permissions
- 具體介面入口：專案→審閱；時間軸→加註解；版本→分享預覽
- 引擎與資料契約：commentstore與projectrevision綁定；非即時同步可先做
- 保存與復原：評論歷史獨立，不能改別人的原音；身份與權限明確
- 預覽與匯出：審閱連結只讀render，是否可下載／原檔分開
- 驗收：舊版本評論不漂到新句；revokedlink、改權限、快取限制測試
- 前置依賴：DAW-PRJ04、DAW-PRI01、DAW-PRI02
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-COL02 安全交接與共享權限

層級：專業深化｜現況：未實作

- 白話用途：指定人能打開正確檔案
- 子功能與選項：owner/editor/reviewer；invite；expiry；download；assetaccess；撤回
- 具體介面入口：分享→對象與權限；管理存取
- 引擎與資料契約：最小權限；source與render分離；server權限實作不是只藏按鈕
- 保存與復原：ACL與auditlog；敏感資訊最少化；撤回不能追回已下載拷貝
- 預覽與匯出：export/package不自動公開；交付權限可驗證
- 驗收：未授權／過期／轉寄連結／assetURL不得繞過ACL
- 前置依賴：DAW-COL01、DAW-PRI02
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-COL03 多人同編與衝突

層級：專項選配｜現況：未實作

- 白話用途：同時修改不互相蓋掉
- 子功能與選項：presence；softlocks；commandmerge；conflictUI；offlinequeue；ownership
- 具體介面入口：協作列；衝突面板→保留哪個版本
- 引擎與資料契約：serverrevision＋idempotentcommands；conflictresolution需另設計，不是加WebSocket
- 保存與復原：每人undo語意；本機未同步副本；不可默默lastwritewins丟工作
- 預覽與匯出：render需一致committedrevision，未同步明示
- 驗收：同時改同clip/param、掉線、rejoin、undo別人改動邊界
- 前置依賴：DAW-PRJ04、DAW-PRJ02、DAW-COL02
- 技術參照：[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

### DAW-COL04 離線與連線恢復

層級：專業深化｜現況：未實作

- 白話用途：斷網仍知道哪些能做、哪些在等
- 子功能與選項：本機可編；雲端不可用；queueduploads；retry；重複提交；account失效
- 具體介面入口：連線狀態列；任務中心；離線工程提示
- 引擎與資料契約：localdurability與servercapability分層；不能把OfflineAudioContext叫離線app
- 保存與復原：本機保存先成功；再同步狀態獨立；衝突可見
- 預覽與匯出：本機支持的export仍可用；雲端依賴阻擋且解釋
- 驗收：飛航／token過期／弱網／重試冪等；重開不丟未同步工作
- 前置依賴：DAW-PRJ03、DAW-NAV05
- 技術參照：[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)；[W3C Permissions 規格](https://www.w3.org/TR/permissions/)

## 完整性效能與無障礙

### DAW-QUA01 功能與UI雙向登記

層級：核心常用｜現況：未實作

- 白話用途：沒有看得到用不了或做了找不到的功能
- 子功能與選項：featureID；commands；visibleentry；contextdisabledreason；schema；tests；evidence
- 具體介面入口：幫助→功能與限制；選單／commandpalette；開發驗收報告
- 引擎與資料契約：單一capabilityregistry；按鈕、命令、schema、renderpolicy互查
- 保存與復原：registry不是用户project；版本隨release，未實作不顯示成功能力
- 預覽與匯出：所有聲音功能都宣告renderpolicy或明確N/A
- 驗收：CI查orphan command/UI/schema/renderer/test；鍵盤e2e真走閉環
- 前置依賴：DAW-PRJ01
- 技術參照：[Ableton Live 12 官方手冊 無障礙與鍵盤](https://www.ableton.com/en/live-manual/12/accessibility-and-keyboard-navigation/)；[W3C WCAG 2.2](https://www.w3.org/TR/wcag/)

### DAW-QUA02 效能與資源診斷

層級：核心常用｜現況：不完整

- 白話用途：長素材與多軌時不爆音不假死
- 子功能與選項：CPU/DSPload；RAM/cache；dropouts；disk；longtasks；waveformLOD；cancel
- 具體介面入口：狀態列→性能；設定→品質／快取
- 引擎與資料契約：audio時鐘與UI分離；boundedworkers；visible-rangepaint；assetstream策略
- 保存與復原：診斷脫敏，設定可保存；不將私音訊寫log
- 預覽與匯出：offline可耗時但可取消；實時overload不隱藏
- 驗收：長檔與4/16軌階梯；不同rate/browser；stats記真硬體及限制
- 前置依賴：DAW-ING07、DAW-GRA06
- 技術參照：[Ableton Live 12 官方手冊 資源與CPU策略](https://www.ableton.com/en/live-manual/12/computer-audio-resources-and-strategies/)；[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)

### DAW-QUA03 獨立音訊正確性驗證

層級：核心常用｜現況：不完整

- 白話用途：不是兩次用了同一段錯碼就算一致
- 子功能與選項：syntheticvectors；independentoracle；goldenfixtures；nulltest；metercalibration；musicalcorpus
- 具體介面入口：診斷報告；輸出QC；測試可追溯版本
- 引擎與資料契約：共用graphparity只驗wiring，另測algorithm與physicalplayback
- 保存與復原：驗證記commit／browser/device／fixture／tolerance；不可捏造pass
- 預覽與匯出：pre-encode／post-encode／physicalmonitor分開標驗證範圍
- 驗收：impulse/tone/noise/ISP/EOF、reallicensedcorpus盲聽；非確定render策略
- 前置依賴：DAW-EXP06、DAW-NAV04
- 技術參照：[Ableton Live 12 官方手冊 音訊事實與測試方法](https://www.ableton.com/en/live-manual/12/audio-fact-sheet/)

### DAW-QUA04 鍵盤與輔助技術

層級：核心常用｜現況：不完整

- 白話用途：不用精準拖滑鼠也能完成製作
- 子功能與選項：focus；labels/states；nudge數值；no-drag替代；keyboardshortcuts；screenreader
- 具體介面入口：所有主要操作；設定→快捷鍵／無障礙
- 引擎與資料契約：command與語意DOM；虛擬timeline提供可操作list替代
- 保存與復原：使用者偏好保存；中文輸入不触發全域快捷鍵
- 預覽與匯出：無障礙模式不得更改audio／render recipe
- 驗收：純鍵盤完整流程、screenreader、IME composition、200% zoom、focusreturn
- 前置依賴：DAW-QUA01、DAW-NAV03
- 技術參照：[Ableton Live 12 官方手冊 無障礙與鍵盤](https://www.ableton.com/en/live-manual/12/accessibility-and-keyboard-navigation/)；[W3C WCAG 2.2](https://www.w3.org/TR/wcag/)

### DAW-QUA05 狀態與錯誤恢復

層級：核心常用｜現況：不完整

- 白話用途：失敗時知道怎麼繼續而不是重來
- 子功能與選項：empty/loading/error/disabled/stale；retry；bypassfailedDSP；cancel；保留輸入
- 具體介面入口：控制項旁原因；錯誤面板；任務center
- 引擎與資料契約：state machine與errorcode；不只toast；不把ready/DSPenabled混為一談
- 保存與復原：失敗不清資料；恢復command可undo；save失敗保持dirty
- 預覽與匯出：缺必需processor時failclosed，但提供真正能用的恢復入口
- 驗收：worklet 初始化失敗＋預設已開；關閉／重試／換源；無fake-success
- 前置依賴：DAW-GRA05、DAW-NAV05、DAW-PRJ03
- 技術參照：[Ableton 外掛缺失原因](https://help.ableton.com/hc/en-us/articles/115000349184-VST-AU-plug-in-doesn-t-appear-in-Live-s-Browser)

### DAW-QUA06 參數單位與輸入契約

層級：核心常用｜現況：未實作

- 白話用途：每個旋鈕數字有意思且可完整保存
- 子功能與選項：type；unit；range；default；step；enum；null/NaN；reset；automationability
- 具體介面入口：每欄label/單位/數字；進階說明；重設
- 引擎與資料契約：canonicalparam schema供UI/engine/serializer；log頻率／dB映射明確
- 保存與復原：保存canonical值，不靠DOM字串；未支援值需遷移／拒絕
- 預覽與匯出：offline和live讀同schema；能力缺失不得靜默略過
- 驗收：每param邊界／無效輸入／preset／undo／reopen／export一條鏈
- 前置依賴：DAW-QUA01、DAW-PRJ05
- 技術參照：[Ableton Live 12 官方手冊 樂器效果與延遲補償](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/)

### DAW-QUA07 動態顏色與小螢幕

層級：核心常用｜現況：未實作

- 白話用途：視覺精緻但不妨礙看懂和操控
- 子功能與選項：reducedmotion；highcontrast；density；panelresize；touch；no-color-only；followoff
- 具體介面入口：設定→顯示；面板／播放列；可收合工作區
- 引擎與資料契約：必要資料feedback與裝飾分離；resizing不重建engine
- 保存與復原：視覺偏好不進audiohistory；工程選取保留
- 預覽與匯出：顏色／動畫不影響render；無裝飾仍能操作
- 驗收：reducedmotion/zoom/phone/keyboard；動畫中快速關開無殘遮罩
- 前置依賴：DAW-NAV03、DAW-QUA04
- 技術參照：[W3C WCAG 2.2](https://www.w3.org/TR/wcag/)

### DAW-QUA08 音訊裝置輸出與監聽安全

層級：專業深化｜現況：未實作

- 白話用途：音量可控，換裝置不突然巨響
- 子功能與選項：outputdevice若可用；monitorgain；mute/dim；mono；referencelevel；devicechange
- 具體介面入口：播放列→監聽；設定→音訊輸出；狀態警示
- 引擎與資料契約：monitor-only path；capability featuredetect；defaultdevice變更policy
- 保存與復原：偏好可存但需安全初始音量；不改masterdata
- 預覽與匯出：monitorvolume／mono check／UI音不烘入檔案
- 驗收：換耳機/揚聲器、suspend/resume、device失聯；不暴增或失去控制
- 前置依賴：DAW-GRA01、DAW-PRI02
- 技術參照：[W3C Web Audio 規格](https://www.w3.org/TR/webaudio/)；[Ableton Live 12 官方手冊 Routing and I/O](https://www.ableton.com/en/live-manual/12/routing-and-i-o/)

## 選配錄音附錄

本領域為低優先選配；不應要求上傳型使用者設定硬體，或把它放在主工作流前方。

### DAW-REC01 錄音裝置與監聽

層級：專項選配｜現況：未實作

- 白話用途：日後需要時錄麥克風，現階段不上主路徑
- 子功能與選項：inputdevice/channel；arm；monitoron/auto/off；gainmeter；permission；hardwaredirectmonitor說明
- 具體介面入口：選配→錄音；軌頭→arm／monitor；設定→裝置
- 引擎與資料契約：capture與monitor分離；不能把browser latencyhint當driverbuffer
- 保存與復原：recordedasset原子落地；deviceconfig機器本地；完整undo引用
- 預覽與匯出：錄音可作source，monitorchain是否印入明示
- 驗收：拒絕權限、拔裝置、雙重監聽、回授、同時多input能力測試
- 前置依賴：DAW-PRJ01、DAW-AST01、DAW-QUA08
- 技術參照：[Ableton Live 12 官方手冊 錄音](https://www.ableton.com/en/live-manual/12/recording-new-clips/)；[Ableton 監聽延遲](https://help.ableton.com/hc/en-us/articles/360011924559-How-to-reduce-latency-while-monitoring)

### DAW-REC02 錄音Punch與倒數

層級：專項選配｜現況：未實作

- 白話用途：只補錄指定區間
- 子功能與選項：countin；preroll/postroll；punchin/out；looprecord；takepolicy；metronomelevel
- 具體介面入口：選配錄音→範圍／Punch；播放列錄音鍵
- 引擎與資料契約：recordtransport與sampleboundaries；錄前暖場不覆音
- 保存與復原：每take不可變保存；接受comp可undo
- 預覽與匯出：未使用take不混入export；punch邊界fade明確
- 驗收：range前後保留；countin/punch/stop/loop；取消保留可救rawtake
- 前置依賴：DAW-REC01、DAW-EDT03、DAW-ARR01
- 技術參照：[Ableton Live 12 官方手冊 錄音](https://www.ableton.com/en/live-manual/12/recording-new-clips/)

### DAW-REC03 多次錄音與Comp

層級：專項選配｜現況：未實作

- 白話用途：從幾次演唱拼最好的句子
- 子功能與選項：take lanes；audition；swipecomp；split；crossfade；groupcomp；ratings
- 具體介面入口：選配錄音／上傳版本→takes；主lane→選用
- 引擎與資料契約：take/comp source map；多軌linkedcomp；跟VOC03共用
- 保存與復原：原takes不覆；comp操作可undo／版本化
- 預覽與匯出：只render主comp；fades/timing一致
- 驗收：不同take重疊、快速試聽、groupcomp相位、重開與bounce
- 前置依賴：DAW-VOC03、DAW-EDT05
- 技術參照：[Ableton Live 12 官方手冊 多版本錄音拼接](https://www.ableton.com/en/live-manual/12/comping/)

### DAW-REC04 延遲校準與低延遲模式

層級：專項選配｜現況：未實作

- 白話用途：需要即時演奏時不要聽到明顯拖拍
- 子功能與選項：reporteddevice；processing；loopbackmeasurement；offset；low latency；buffer能力
- 具體介面入口：選配→裝置校準；監聽→低延遲；診斷
- 引擎與資料契約：bufferduration≠roundtrip；校準與deviceprofile；旁路高latency需披露
- 保存與復原：profile按裝置／rate保存；未量測標估計
- 預覽與匯出：不把錄音補償doubleapply；offline正常chain保持
- 驗收：loopback不同rate/buffer，devicechange使calibration失效；PDC對齊
- 前置依賴：DAW-REC01、DAW-GRA06
- 技術參照：[Ableton 延遲原理](https://help.ableton.com/hc/en-us/articles/360010545559-How-Latency-Works)；[Ableton 監聽延遲](https://help.ableton.com/hc/en-us/articles/360011924559-How-to-reduce-latency-while-monitoring)

### DAW-REC05 MIDI錄音與事後捕捉

層級：專項選配｜現況：未實作

- 白話用途：即興彈奏變成可編輯音符
- 子功能與選項：record/overdub/replace；stepentry；inputfilter；countin；capturebuffer；quantize
- 具體介面入口：MIDI軌→錄音；選配→取回剛才演奏
- 引擎與資料契約：time-stamped events／rollingbuffer權限和長度；capture意圖可見
- 保存與復原：每take保存可undo；不暗中長期記錄未同意輸入
- 預覽與匯出：MIDI events進instrumentrender；重複take不雙套
- 驗收：pedal/bend/chase/tempochange；停止送noteoff；capturebuffer有界
- 前置依賴：DAW-MID01、DAW-MID02、DAW-REC01
- 技術參照：[Ableton Live 12 官方手冊 錄音](https://www.ableton.com/en/live-manual/12/recording-new-clips/)

## 選配控制器同步影片與配器

本領域為低優先選配；不應要求上傳型使用者設定硬體，或把它放在主工作流前方。

### DAW-ADV01 控制器對映

層級：專項選配｜現況：未實作

- 白話用途：用旋鈕推桿操作已存在功能
- 子功能與選項：MIDIlearn；absolute/relative；pickup/scaling；min/max；feedback；bank；conflict
- 具體介面入口：選配→控制器；參數→學習；映射清單
- 引擎與資料契約：mapping到stableparam/command IDs；inputnotes與remotecontrol分開
- 保存與復原：deviceprofile與projectmapping作用域明確；可撤回
- 預覽與匯出：remote只是改同state，不另起隐藏DSP；render讀提交值
- 驗收：不同encoder模式、斷線/重連、bank切換無跳音、mapping衝突
- 前置依賴：DAW-QUA01、DAW-MID02
- 技術參照：[Ableton Live 12 官方手冊 MIDI與鍵盤控制](https://www.ableton.com/en/live-manual/12/midi-and-key-remote-control/)；[W3C Web MIDI 規格](https://www.w3.org/TR/webmidi/)

### DAW-ADV02 外部硬體效果迴路

層級：專項選配｜現況：未實作

- 白話用途：日後把聲音送出硬體再接回
- 子功能與選項：send/returnports；level；latencyping；manualoffset；mono/stereo；missingdevice
- 具體介面入口：選配→外部效果器；路由→硬體loop
- 引擎與資料契約：需真正hardwareIO，純web能力有限；回授防護與latency
- 保存與復原：deviceport別名和校準值存profile；project存邏輯loop
- 預覽與匯出：含硬體時要求realtime render；missingloop阻擋成功輸出
- 驗收：ping/feedback/port失聯、realtime錄回、tails；不以offline靜音替代
- 前置依賴：DAW-GRA06、DAW-REC04
- 技術參照：[Ableton 外部硬體效果器](https://help.ableton.com/hc/en-us/articles/360005113200-Using-external-audio-effects)

### DAW-ADV03 外部同步與時間碼

層級：專項選配｜現況：未實作

- 白話用途：和其他樂器、軟體或影片共同走時間
- 子功能與選項：Clock send/receive；transport/SPP；MTC/LTC選配；master/slave；offset；syncdelay；loss
- 具體介面入口：選配→同步；播放列→鎖定狀態
- 引擎與資料契約：tempoClock與timecode分開；協議方向與browser支持矩陣
- 保存與復原：同步設置scope明確；masterloss不改工程tempo暗中
- 預覽與匯出：offline render需先固定時間圖；外部同步capture另記
- 驗收：seek/loop/stop/dropout、錯clock源、重新lock、MTC無tempo假設
- 前置依賴：DAW-ARR01、DAW-NAV01
- 技術參照：[Ableton Live 12 官方手冊 Link與MIDI同步](https://www.ableton.com/en/live-manual/12/synchronizing-with-link-tempo-follower-and-midi/)

### DAW-ADV04 影片與配樂對時

層級：專項選配｜現況：未實作

- 白話用途：需要配影像時精確對聲畫
- 子功能與選項：videoimport；frame-rate rational；DF/NDF；starttimecode；offset；proxy；markers
- 具體介面入口：選配→影片；視訊窗；全域→時間碼
- 引擎與資料契約：video與audio clocks／compensation獨立；variableframerate處理policy
- 保存與復原：videoasset/reference/proxy與offset保存undo
- 預覽與匯出：exportaudio到指定時碼；videoexport支援另列
- 驗收：29.97/30差異、longdrift、seek、PDC、offlineaudio起點
- 前置依賴：DAW-ADV03、DAW-GRA06、DAW-AST01
- 技術參照：[Ableton Live 12 官方手冊 影片工作流](https://www.ableton.com/en/live-manual/12/working-with-video/)；[Apple Logic 同步設定](https://support.apple.com/en-in/guide/logicpro/lgcp7c04a41a/mac)

### DAW-ADV05 樂譜與配器交付

層級：專項選配｜現況：未實作

- 白話用途：用五線譜交給樂手
- 子功能與選項：notation；displayquantize；rests/ties；articulations；lyrics；parts；MusicXML/PDF選配
- 具體介面入口：選配→樂譜；音符→樂譜屬性；匯出→分譜
- 引擎與資料契約：演奏MIDI與顯示譜面分離；版面engine另需實作
- 保存與復原：scorestate／parts／fonts保存；不因排版改演奏
- 預覽與匯出：MusicXML與PDF支持範圍／loss明示，不只截圖
- 驗收：複拍/連音/跨小節/移調樂器/中文字，列印與MIDI音訊一致
- 前置依賴：DAW-MID01、DAW-MID06、DAW-ARR01
- 技術參照：[Apple Logic 樂譜](https://support.apple.com/en-euro/guide/logicpro/lgcp8535e072/mac)

### DAW-ADV06 環繞與空間音訊

層級：專項選配｜現況：未實作

- 白話用途：需要多喇叭或空間交付時擴充
- 子功能與選項：channel layouts；surroundpanner；objects選配；LFE；downmix；monitorcalibration；formats
- 具體介面入口：選配→工程聲道格式；空間panner；匯出layout
- 引擎與資料契約：多channelgraph／metadata和合法格式encoder，不能用stereowidening冒充
- 保存與復原：layout/object metadata與version保存；可回復
- 預覽與匯出：每格式需獨立delivery/QC，商業renderer授權另評估
- 驗收：speakeridentification、downmix、phase、peak/loudness、missingrenderer
- 前置依賴：DAW-ING05、DAW-GRA01、DAW-EXP06
- 技術參照：[Apple Logic 聲像法則](https://support.apple.com/en-gu/guide/logicpro/lgcp4f230784/mac)；[REAPER 官方技術能力](https://www.reaper.fm/about.php)

## 驗收資料與測試層次

建議固定一組合成fixture：脈衝、已知頻率／振幅正弦、多音、確定性噪音、瞬態、長靜音、最後一sample訊號、左右不同與反相信號；分別覆蓋44.1／48／96 kHz、mono／stereo、短檔／長檔。另需有權使用的真實歌曲與多語歌聲，才能驗證分離、音準、伸縮與對時的音樂品質。

對決定性無處理路径做sample位置與null test；對dither、隨機生成、不同SRC或時變演算法先定合理的驗收方式，不能拿byte equality當所有情境的標準。對比兩個共用builder只能證明接線一致，不能代替獨立DSP真值、實機或跨瀏覽器驗證。

UI測試必須從真實按鈕或命令入口開始，實際修改state，存關重開，復原重做，再聽／讀取輸出；單獨呼叫底層函式通過不足以宣告使用者功能完成。

## 交付前的孤兒節點檢查清單

- [ ] 每個上線feature ID有可見入口和命令搜尋結果
- [ ] 每個UI control有command、context、禁用原因、可存取名稱和鍵盤替代
- [ ] 每個command有處理能力；沒有只改label或假成功的分支
- [ ] 每個參數填妥型別／單位／範圍／預設／轉換／保存／reset／測試
- [ ] 每個音訊處理器與圖節點有consumer，內部節點明確標記internal
- [ ] 每個會改作品的動作可保存、重開、undo/redo或明說不可逆前置確認
- [ ] 每個會改聲音的功能進入實際render；純監聽功能則確實排除
- [ ] 每個異步結果綁來源和revision，取消／失敗／過期不污染工程
- [ ] 每個完成宣告都有測試證據與已知限制，沒跑的明寫未跑
- [ ] 每個輸出檔可解碼／解析，內容、位置、範圍、格式與交付摘要相符
- [ ] 每個外傳操作明示資料、目的地、用途與可核實留存／刪除狀態
- [ ] 每個無法支援的能力誠實停用或不公開，不借漂亮動態冒充處理

## 本份產物的驗證狀態

已驗證：資料列完整、ID唯一、依賴可解析且無循環、來源鍵存在、每項都有UI／engine／save-undo／render／acceptance、JSON可解析、同伴規格連結對應檔案存在。

未驗證：JSON尚未接入WaveForge執行時；提議command/test ID不是現有程式名稱；未替每個新功能實作引擎、UI、schema或測試。這份文件不能作為完整DAW上線證明。
