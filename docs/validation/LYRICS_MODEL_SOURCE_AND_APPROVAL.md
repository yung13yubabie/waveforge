# 本機 Whisper 歌詞定位：模型來源、同意與驗證關卡

日期：2026-10-05

## 目前已做與尚未做

已完成來源與版本調查、browser Worker/client、下載完整性驗證、獨立模型快取、取消／逾時、嚴格時間驗證及 mock lifecycle tests。

**使用者已批准本文件的固定來源下載與執行。七檔共 66,406,756 bytes 已全部通過長度／SHA-256；實際 Node CPU decoder probe 確認四層 cross-attention outputs，並完成 CC0 英文清唱推論與負例。建置版瀏覽器 live 下載／WASM／UI 功能也已通過 CI；人工歌唱邊界與多語準確度尚未校準。**

20 秒片段輸出 25 個有界詞時間，重跑一致；5 秒短窗也有合法時間。原始輸出、fixture hash、UTC 時間、matcher 的四個候選／一個未對上結果及第二輪未改善紀錄，見 [實際模型證據](real-model/README.md)。這不是人工 transcript 或準確率 gold。程式仍在缺少必要輸出時拒絕自動定位，絕不以均分曲長替代。

本次固定來源的實測已獲核准；此批准與產品內每頁的模型下載同意是兩件事，UI 同意門檻仍保留。CPU 成功不替代瀏覽器或人工準確率驗收，程式碼合併／部署仍須明列各層狀態。

## 單一來源與版本

- Model：`Xenova/whisper-tiny`，多語 tiny，非 `.en`
- Revision：`5332fcc35e32a33b86612b9a57a89be7906102b1`
- 模型卡明列：Apache-2.0。發布時保留上游歸屬及適用授權聲明
- JS library：`@huggingface/transformers@3.8.1`，Apache-2.0
- 執行後端：WASM，單執行緒；encoder fp32、merged decoder q8
- ORT：`onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`，MIT；使用 lockfile 版本
- 不使用未明確宣告授權的 `onnx-community/*_timestamped` 權重作預設

來源：

- [固定模型卡](https://huggingface.co/Xenova/whisper-tiny/blob/5332fcc35e32a33b86612b9a57a89be7906102b1/README.md)
- [固定版本檔案 metadata](https://huggingface.co/api/models/Xenova/whisper-tiny/revision/5332fcc35e32a33b86612b9a57a89be7906102b1?blobs=true)
- [Transformers.js 3.8.1 原始碼](https://github.com/huggingface/transformers.js/tree/3.8.1)
- [Whisper 官方模型卡與限制](https://github.com/openai/whisper/blob/main/model-card.md)

## 下載 manifest

所有模型 URL 都是下列固定 base 加上表內 path，禁止使用 `main`：

`https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/`

| Path | Bytes | SHA-256 |
| --- | ---: | --- |
| onnx/encoder_model.onnx | 32,909,539 | 39e81b6c86a5b2b4beda1bb3145486a769d594801f780a66cad1ae72c7ad2c5e |
| onnx/decoder_model_merged_quantized.onnx | 30,727,765 | 6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0 |
| config.json | 2,248 | 2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94 |
| generation_config.json | 3,716 | 68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c |
| preprocessor_config.json | 339 | a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d |
| tokenizer.json | 2,480,466 | 27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566 |
| tokenizer_config.json | 282,683 | 2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce |

7 檔合計 **66,406,756 bytes**，約 66.41 MB／63.33 MiB。權重 hash 來自 Hub LFS metadata；JSON hash 原先由同一固定來源的 read-only 請求計算；本次實際下載後已逐檔重新核對，通過後才執行模型。

下載量另包括 app JS 和同站 ORT runtime：`ort-wasm-simd-threaded.jsep.wasm` 21,596,019 bytes、`.mjs` 44,484 bytes，共 21,640,503 bytes。Vite `?url` 會以內容雜湊檔名發布這兩個 lockfile 依賴資產，**不使用預設 CDN runtime**。壓縮傳輸量與瀏覽器是否已有 app cache 另計，不把上述 66.41 MB 說成首次整體流量上限。

## 使用者同意與不自動下載

`createWhisperClient()` 預設 `modelSourceApproved:false`。沒有明確傳入 `true` 時，`transcribe()` 拒絕，既不建立 Worker，也不觸發 import、模型下載或快取讀取。

UI 需先說明固定來源、授權、模型量及額外 runtime，使用者當頁勾選同意後，service 才建立 approved client。單純開啟手動歌詞面板或 import config/client 不應下載任何模型。

已核准並完成的 CPU 實測動作：下載本文件列出的 7 個固定版檔案，在本機檢查 ONNX 輸出，並以既有 CC0 片段執行推論。權重保存在 repository 外，未提交或發布。音訊不傳給 Hugging Face 或其他推論服務；同來源的真實瀏覽器驗證另由獨立 CI step 執行，不在部署流程自動開啟模型測試。

## 推論與輸出契約

- 輸入：已重採樣的 mono 16 kHz `Float32Array`；單窗至少 320 samples（20 ms，一個 encoder frame）且不超過 20 秒；全部 sample 必須有限
- 語言：必須提供 pinned checkpoint 支援的明確 code，如 `zh`、`en`、`ja`；共 99 個語言 token，不含 `yue`
- `task:'transcribe'`、`return_timestamps:'word'`、`chunk_length_s:0`、`force_full_sequences:false`
- Service 自行規劃最多 20 秒及 2 秒 overlap；底層 client 不再分窗或加 offset
- 回傳 `{ chunks:[{ text,timestamp:[start,end] }], engine,engineVersion,model,revision,language,sampleRate,duration,timestampOrigin,timingMethod,modelValidation }`
- 時間單位為秒，全部相對當次窗起點。原曲 offset 由 service 加一次
- 不回傳虛構 confidence；`modelValidation` 為 `browser-smoke-verified-but-quality-uncalibrated`，明確區分瀏覽器功能通過與品質未校準
- 非有限、負值、倒序、零長度、重疊、超出窗口、缺失 timestamp、空白 word 均拒絕整個 window result。空 chunks 是合法的「沒有辨識結果」，不能補成成功

3.8.1 word 模式會使用 cross-attention + DTW，並不預測 segment timestamp tokens；generate 直接使用一般生成路徑，沒有 v4 新 seek-loop。[pipeline 原始碼](https://github.com/huggingface/transformers.js/blob/3.8.1/src/pipelines.js#L1804-L1815)、[model 原始碼](https://github.com/huggingface/transformers.js/blob/3.8.1/src/models.js#L3495-L3525)

### 僅限 3.8.1 的 frame-unit 修正

獨立 source review 確認一個不能只靠分窗避開的上游問題：`pipelines.js:1878` 計算 `floor(samples/160)`，其單位是 100 Hz mel frames；`models.js:3579` 卻將此數字直接作為 50 Hz encoder cross-attention 軸的裁切長度。因此 20 秒窗會要求 2000 encoder frames，超過 padded graph 的 1500，保留多餘 padding。此問題先由源碼／合成契約確認；本次 CPU 真實推論也記錄 20 秒輸入的 2000→1000 與 5 秒輸入的 500→250 frame 修正。

Worker 在通過版本與 graph output 檢查後，僅包裝該 model instance 的 `_extract_token_timestamps`：把 mel-frame count 轉為 `floor(melFrames/2)`，再原封不動委派輸出 tensors、alignment heads 和 time precision。這與 [Python v4.46.3 的 `num_frames // 2`](https://github.com/huggingface/transformers/blob/v4.46.3/src/transformers/models/whisper/generation_whisper.py#L211-L220) 一致。**不縮放已生成時間、不平均端點、不改 DTW 本身。**

包裝只接受精確 runtime `3.8.1`，使用 instance marker 防止重复包裝／再次除二；拒絕 0、1、非整數、非有限及超過本產品 20 秒窗的 mel-frame count。若已包裝的方法被其他程式替換，也拒絕繼續。將來更換 library 版本必須重新檢查上游契約，不能沿用此修正。

Synthetic tests 驗證 2000→1000、1000→500、1999→999、101→50、3→1、2→1、invalid frames、重複初始化及輸出物件完全不變；installed-source assertions 在不 import runtime 的情況下確認上游傳值／裁切契約。真實 CPU 推論已使用同一個共享 adapter；人工時間邊界準確度仍待標註後測量。

3.8.1 的 language autodetection 尚未實作，不指定會預設英文。中文、日文等非空格語言的 word chunks 不是通用的字／音節正確邊界保證。[語言初始化](https://github.com/huggingface/transformers.js/blob/3.8.1/src/models.js#L3414-L3437)

這是音訊辨識輔助定位，再由 matcher 映回不可變的貼入歌詞，不是完整的已知歌詞 forced-alignment 模型。ASR 會漏字、錯字、重複和幻覺；全語言／混語／唱歌準確率均須實測。

## 完整性、網路與快取

Worker 只對固定 7 個模型 URL 發送 GET，不帶 audio、lyrics、使用者帳號 cookies 或 referrer。Hugging Face 可能將 GET 重新導向其權重 CDN；最終內容必須符合固定長度與 SHA-256。

每個下載檔案在進入 persistent cache 前驗證；每個新 Worker 從 cache 讀取時重新驗證。損壞資料直接報錯，不悄悄接受或下載替換。只有經驗證的 byte arrays 才暴露給 Transformers.js custom cache。library 的任意模型／本機路徑 cache miss 會被 Worker fetch fence 阻擋；推論期間只允許明確的同站 runtime URL。

專用 cache name：

`waveforge-lyrics-whisper-tiny-5332fcc35e32a33b86612b9a57a89be7906102b1-fp32-q8-v1`

`clearCache()` 必須由明確的使用者清除動作觸發：終止此 client 的 Worker，再刪除這個完整 cache name。不列舉或刪除其他 cache，不刪音檔、歌詞或 app 資料。不清除一般 HTTP runtime cache，也不能強制卸載其他分頁已載入的模型。private mode／quota 限制下可採記憶體 verified cache，關閉 Worker 即釋放，UI 應處理 `cache-unavailable`。

`dispose()` 和取消／逾時終止 Worker；不刪已完整驗證的模型快取。傳入 Worker 的 waveform 是 copy，原播放器的 samples buffer 不會被 detach。

實際進度只包含 file `loaded/total` 及總計；loading／transcribing 為不定進度，禁止計時器補假百分比。

## 驗證與 opt-in 測試

預設：`npm test` 及本檔對應的 `tests/audio/whisper-client.test.js` 只跑 mock lifecycle、synthetic 3-byte integrity 和 source-contract tests，不下載模型、不執行 inference。真實測試 suite 預設 skipped。

目前 focused verification：68 個 mock／contract tests 通過，1 個人工標註 browser opt-in test 未執行；production build 通過並輸出同站 runtime 資產。另有獨立 Node CPU graph／推論證據，兩者不混算，且均不代表人工邊界準確率通過。

CPU 模型在兩秒完全數位靜音上幻覺出「you」，目前 client／Worker 對精確全零 PCM 直接回空結果，不載入模型；這不是通用 VAD。固定噪音產生零長度詞而被嚴格拒絕，不修補成假時間。完整失敗輸出也保存在上述證據目錄。

`node scripts/verify-lyrics-model.mjs --help` 說明獨立 CPU 與 browser smoke CLI。browser 模式可驗 built 頁面的實際 Worker/WASM、固定來源 live GET／CORS、快取、取消重試與真 UI 接合；已在 [run 37384510849](https://github.com/yung13yubabie/waveforge/actions/runs/37384510849)、head `67e117742d19ab26fa430d3872c89f536772a7ab` 通過；未使用或捏造人工 gold。原始 [browser JSON](real-model/browser-smoke-evidence.json) 按原位元組保留，來源與 SHA-256 見 [provenance](real-model/browser-smoke-provenance.json)。

以下是另一個人工 gold 準確率測試；固定來源已批准，但仍需補齊合法素材的人工 transcript／anchors 才能啟用。測試需先由操作者啟動 localhost Vite server，不自行部署或接觸 production：

```
WAVEFORGE_REAL_MODEL_TEST=1 \
WAVEFORGE_MODEL_APPROVED_REVISION=5332fcc35e32a33b86612b9a57a89be7906102b1 \
WAVEFORGE_MODEL_FIXTURE=/absolute/path/to/authorized-fixture.json \
WAVEFORGE_TEST_URL=http://127.0.0.1:5173/ \
npx vitest run tests/audio/whisper-client.test.js
```

Fixture JSON 必須含：`rightsConfirmed:true`、`pcmFile`（相對 manifest 的 float32 little-endian PCM）、`sampleRate:16000`、明確 `language`、`maxBoundaryErrorSeconds`（>0 且 <=1）、至少兩個人工標註的 `expectedAnchors:[{text,timestamp:[start,end]}]`。Audio 必須 <=20 秒。測試只接受 localhost URL，並阻擋對外非 GET／带 body 請求。

驗收分層如下；第 1 項及單一英文素材的瀏覽器功能／網路／生命週期已通過，廣泛人工品質校準仍未完成：

1. 七檔完整性通過；實際 decoder outputNames 有四層 `cross_attentions.0` 至 `.3`
2. 真實短語音 word timestamps、明確語言、短音檔 padding、取消／timeout、零字結果均驗證
3. 自有或明確授權的國語、英文和所宣稱混語歌唱；涵蓋清唱、混音、長母音、rap、重複副歌、前奏／間奏
4. 手工標註邊界，報 median／p95 誤差、漏對率、錯配率和第二轮是否改善，保留失敗樣本
5. 錯貼歌詞、未演唱行及 silence 不應被補成假成功；原文逐字保留，offset 與 overlap 去重可重現
6. 瀏覽器 network capture 確認音訊／歌詞不在任何外部 request payload；首次載入／已快取／損壞快取／清除後重載均核查

合成脈衝只能驗 resampling／裁切時鐘，mock provider 只能驗生命週期；兩者均不能取代歌唱素材模型驗收。

發布另以最終提交全部功能 CI 和實際部署主機驗證為關卡。上列人工邊界／多語品質工作保持未驗證，不把 localhost 功能 smoke 當作正式主機已更新或 100% 歌唱對準。
