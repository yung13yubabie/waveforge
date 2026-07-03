# WaveForge 後端設定完整指南

四個外部服務的申請與接線步驟。全部完成後，防盜偵測 + AI 分軌 + 帳號系統 = 完整 Live 模式。

進度檢查表：
- [ ] Supabase migration 001 + 002 + 003 已執行
- [ ] Edge Function `acr-scan` 已部署
- [ ] ACRCloud 專案已建立，Key/Secret 已填入 WaveForge 設定
- [ ] Spotify App 已建立，Client ID/Secret 已填入（選填）
- [ ] HF Space 已部署，`VITE_HF_ENDPOINT` 已設定
- [ ] GitHub Secrets 已加入（線上版才會脫離訪客模式）

---

## 1. ACRCloud（音訊指紋比對 — 防盜偵測核心）

### 申請流程
1. 前往 [console.acrcloud.com/signup](https://console.acrcloud.com/signup) 註冊（有免費試用）
2. 登入 Console → 左側選單 **Audio & Video Recognition** → **Create Project**
3. 專案設定：
   - **Project Name**：任意（如 `waveforge-scan`）
   - **Audio Source**：選 **Line-in Audio**（我們上傳的是乾淨檔案，非麥克風收音）
   - **Audio Engine（單選 radio，只能選一個）**：選第三個 **Audio Fingerprinting & Cover Song (Humming) Identification** — 同時涵蓋原版指紋 + 翻唱/升降Key/改BPM。（不要只選第一個 Audio Fingerprinting，那樣抓不到變調版本）
   - **Buckets**：勾選 **ACRCloud Music**（內建全球商業曲庫，比對用）
   - **3rd Party Integration**：建議勾選 **Spotify** 與 **ISRC**（回傳結果會帶 Spotify track id 與 ISRC 碼，供後續增強）

### 偵測能力與規避手法（誠實的威脅模型）

沒有任何版權偵測系統能擋下 100% 的規避。實際能力分三層：

| 盜用者的手法 | 標準指紋 | 翻唱引擎 (Cover Song) | 說明 |
|------------|:-------:|:--------------------:|------|
| 改檔名 / 改 file type（MP3↔WAV↔FLAC）| ✅ | ✅ | 指紋看聲音內容，不看容器 |
| 改位元率 / 重新編碼 / 改音量·LUFS | ✅ | ✅ | 感知雜湊對這些天然免疫 |
| 輕微 EQ / 加淡入淡出 / 剪頭尾 | ✅ 多半可 | ✅ | 只要主體聲學特徵保留 |
| 升降 Key（變調）/ 改 BPM（變速）| ❌ | ✅ | 這就是要選 Cover Song 引擎的原因 |
| 大幅 EQ 破壞頻譜 / 疊白噪音 / 加重殘響 | ⚠️ 可能失效 | ⚠️ 可能失效 | 破壞得夠多會逃過偵測 |
| 段落重排 / 倒放 / 拼貼 | ❌ | ⚠️ 部分 | 已非「同一份錄音」 |
| AI 重製 / 神經風格轉換 / 對抗式擾動（"加強神經元"）| ❌ | ❌ | 生成出的是全新音訊，指紋比對無效 |

**結論：** 指紋+翻唱引擎能擋住 90% 的「懶人盜用」（轉檔、改速、改調、改音量）。但決心規避者用 AI 重製或大幅頻譜破壞仍可能逃過 — 這是所有指紋系統（含 Content ID）的共同極限，不是 WaveForge 的缺陷。

### 對抗「AI 重製 / 大幅破壞」有沒有辦法？（分層防禦）

沒有單一技術能 100% 防住，但可以「疊層」把成本推高到讓盜用不划算。指紋是**被動比對**（別人上架後你去搜），要主動防禦得再加下面幾層：

1. **主動式音訊浮水印（proactive watermarking）** — 在你發行的母帶裡嵌入**聽不見**的識別碼。跟指紋不同，浮水印是「藏在音訊裡的訊號」，能撐過轉檔、改音量、輕度 EQ、甚至部分重新錄音，比純指紋更耐改。
   - 開源工具：[`audiowmark`](https://github.com/swesterfeld/audiowmark)（spread-spectrum，命令列，抗 MP3 壓縮）
   - 商業：Spotify/唱片業用的 audible/inaudible watermark 服務
   - **限制**：若對方用 AI 從零重新生成音訊（把你的歌當風格參考重唱重編），浮水印跟指紋一起失效 —— 因為輸出已是全新錄音。
   - **WaveForge 可加做**：匯出時嵌入你的 ISRC/識別碼浮水印。這是一個獨立功能（需 DSP 實作 + 抗攻擊測試），需要的話另開任務做，不會硬塞進現有匯出。
2. **內容憑證（C2PA / Content Credentials）** — 在檔案綁定簽章過的來源與時間戳中繼資料（Adobe、相機廠、部分 DAW 支援）。證明「這份是我在 X 時間產出的原件」，是法律與平台申訴的有力證據。
3. **權利登記 + 時間戳** — 把母帶雜湊（MD5/SHA-256）+ 時間存證（區塊鏈存證、著作權登記、寄給自己的掛號信、Git commit 時間）。WaveForge 匯出專輯時已產生 MD5，可留存當證據。
4. **平台申訴管道** — YouTube Content ID、各串流的版權申訴。這些平台自己的偵測 + 你的登記證據，比單靠指紋有效。

**務實建議**：一般獨立音樂人 → 指紋（本工具）+ MD5/時間戳存證就夠擋 90%。若作品商業價值高、常被 AI 翻製 → 再加浮水印 + C2PA。想讓 WaveForge 加浮水印匯出，跟我說我另開任務實作。

### 檔案流向稽核（回答「檔案會不會流出」）

程式碼實測：整個前端只有 **3 個對外網路呼叫**，其餘全在瀏覽器內：

| 功能 | 送出什麼 | 送到哪裡 | 程式碼 |
|------|---------|---------|--------|
| **核心母帶處理 / 匯出 / 批量 / URL 元資料以外的一切** | （無）音檔全程只在瀏覽器記憶體 | 不外送 | — |
| 防盜掃描 | 該曲**前 30 秒**的 WAV 樣本 | **你自己**的 Supabase Edge Function → **你自己**的 ACRCloud 帳號 | `antitheft.js` |
| AI 分軌 | **整首**音檔 | **你自己**設定的 HF Space | `stems-mastering.js` |
| URL 版權查詢 | 只有你貼的**網址文字**（無音訊） | 該平台的公開 oEmbed API | `url-meta.js` |

**重點**：音訊只在你「主動使用防盜掃描或分軌」時才會離開瀏覽器，且只送到**你自己設定的後端**（你的 Supabase / 你的 HF Space），不經過 WaveForge 伺服器，也不送任何第三方分析。核心母帶工作流零外送。這點在防盜頁的「運作方式與隱私」摺疊區也有說明。
4. 建立後，專案頁面會顯示三個關鍵值：
   - `host`（如 `identify-eu-west-1.acrcloud.com`）
   - `access_key`
   - `access_secret`
5. 把 **Access Key** 與 **Access Secret** 貼入 WaveForge → 防盜偵測 → 右側設定面板 → 儲存（需先登入）

### 額度
免費方案每月約 1,000 次辨識。耗盡時可升級或更新 Key。

---

## 2. Spotify Web API（掃描結果增強 — 選填）

填入後，掃描結果會用 ACRCloud 回傳的 ISRC 碼去 Spotify 精準比對，補上專輯封面、發行日期與正確連結。

### 申請流程
1. 前往 [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)，用你的 Spotify 帳號登入（免費帳號即可）
2. 點 **Create app**：
   - **App name / description**：任意
   - **Redirect URI**：填 `https://localhost`（本整合用 Client Credentials flow，不會用到，但欄位必填）
   - **Which API/SDKs are you planning to use?**：勾 **Web API**
   - 同意條款 → **Save**
3. 進入 App → **Settings**：
   - 複製 **Client ID**
   - 點 **View client secret** → 複製 **Client Secret**
4. 貼入 WaveForge → 防盜偵測 → Spotify API 區塊 → 儲存（需先登入）

### 安全性
- Client Secret 只存在你的 Supabase `user_settings`（RLS 保護，只有你能讀）
- 實際呼叫發生在 Edge Function（伺服器端），Secret 不會出現在瀏覽器網路請求中
- 若懷疑外洩：Dashboard → App → Settings → **Rotate** 立即輪換

---

## 3. Supabase（帳號 + 資料庫 + Edge Function）

### 3.1 資料庫 migration（依序執行，不可顛倒）
Dashboard → SQL Editor，依序貼上執行：
1. `supabase/migrations/001_init.sql`（建表）
2. `supabase/migrations/002_harden_schema.sql`（RLS 強化）
3. `supabase/migrations/003_spotify_credentials.sql`（Spotify 欄位）

三個腳本都可安全重跑。

### 3.2 部署 Edge Function

**方式 A — Supabase CLI（推薦）：**
```bash
cd C:\Users\LIN\waveforge
npx supabase login                # 開瀏覽器授權
npx supabase link --project-ref <你的專案REF>   # REF 在 Dashboard URL：supabase.com/dashboard/project/<REF>
npx supabase functions deploy acr-scan
```

**方式 B — Dashboard 貼上：**
Dashboard → Edge Functions → **Deploy a new function** → 命名 `acr-scan` → 把 `supabase/functions/acr-scan/index.ts` 全文貼入 → Deploy。

**Email 通知（選填）：** Dashboard → Edge Functions → acr-scan → Secrets → 加 `RESEND_API_KEY`（[resend.com](https://resend.com) 申請）。

### 3.3 Google OAuth（你已開啟 ✓）— 確認 redirect 設定
Google 登入要成功跳轉回 WaveForge，必須確認：
1. Dashboard → **Authentication** → **URL Configuration**：
   - **Site URL**：`https://yung13yubabie.github.io/waveforge/`
   - **Redirect URLs** 加入：
     - `https://yung13yubabie.github.io/waveforge/`
     - `http://localhost:5173/`（本機開發用）
2. Google Cloud Console → OAuth 2.0 Client → **Authorized redirect URIs** 必須包含：
   - `https://<你的專案REF>.supabase.co/auth/v1/callback`

---

## 4. Hugging Face Spaces（AI 分軌 Demucs）

### 部署流程
1. 前往 [huggingface.co](https://huggingface.co) 註冊/登入
2. 右上角 → **New Space**：
   - **Space name**：如 `demucs-waveforge`
   - **SDK**：選 **Gradio**
   - **Hardware**：`CPU basic`（免費；一首 3 分鐘歌約跑 3-8 分鐘）。願付費可選 GPU（`T4 small`，快 10 倍以上）
   - **Visibility**：Public（免費 CPU 需 Public）
3. 建立後 → **Files** tab → **Add file** → 上傳 repo 裡 `hf-space/` 目錄的三個檔案：
   - `app.py`
   - `requirements.txt`
   - `README.md`
4. Space 會自動開始建置（首次約 5-10 分鐘，要下載 PyTorch + Demucs 模型）
5. 建置完成後（頁面顯示 Running），你的 endpoint 是：
   `https://<你的帳號>-demucs-waveforge.hf.space`
   （準確 URL 可在 Space 頁面 → ⋮ → **Embed this Space** 看到）

### 注意事項
- **免費 CPU Space 會休眠**：48 小時無人使用會 sleep，下次呼叫要等 1-3 分鐘冷啟動。WaveForge 已設 10 分鐘 timeout 涵蓋此情況
- 檔案上限 50MB（前端已擋）
- WaveForge 前端使用 Gradio 4 的 `/call/separate` API（`app.py` 已宣告 `api_name="separate"`），版本已對齊，不要改動 `requirements.txt` 的 `gradio==4.44.1`

---

## 5. GitHub Pages 線上版啟用（關鍵！）

`.env` 只影響你本機 `npm run dev`。**線上版（GitHub Pages）的環境變數是在 GitHub Actions build 時烘進去的**，必須設定 repo secrets：

1. GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**，加入三個：

| Secret 名稱 | 值 |
|------------|---|
| `VITE_SUPABASE_URL` | `https://<你的專案REF>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Dashboard → Settings → API → `anon` `public` key |
| `VITE_HF_ENDPOINT` | `https://<你的帳號>-demucs-waveforge.hf.space` |

2. 加完後隨便 push 一個 commit（或 Actions tab → Deploy workflow → **Re-run**）觸發重新部署
3. 部署完成後開啟線上版，防盜偵測頁不再顯示「訪客模式」橫幅 = 成功

> ⚠️ `anon` key 是設計上公開的（RLS 保護資料），可以放 Secrets。**絕對不要**放 `service_role` key。

---

## 完成後的驗證流程

1. 開線上版 → 防盜偵測 → 沒有訪客橫幅 ✓
2. 點「登入/註冊」→ 用 Google 登入 → 右上顯示頭像 ✓
3. 設定面板填 ACRCloud Key/Secret → 儲存 ✓
4. （選）填 Spotify Client ID/Secret → 儲存 ✓
5. 上傳一首你的作品 → 顯示「已建立作品記錄」✓
6. 點「掃描」→ 回傳真實 ACRCloud 比對結果（有 Spotify 憑證時帶封面）✓
7. 分軌母帶頁 → 沒有「示範模式」警告 → 上傳音檔 → AI 分軌 → 等待後四軌出現 ✓
