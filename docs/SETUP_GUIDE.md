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
   - **Buckets**：勾選 **ACRCloud Music**（內建全球商業曲庫，比對用）
   - **3rd Party Integration**：建議勾選 **Spotify** 與 **ISRC**（回傳結果會帶 Spotify track id 與 ISRC 碼，供後續增強）
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
