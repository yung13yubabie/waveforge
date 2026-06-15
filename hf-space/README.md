---
title: WaveForge Demucs Stem Separator
emoji: 🎚️
colorFrom: red
colorTo: cyan
sdk: gradio
sdk_version: 4.44.1
app_file: app.py
pinned: false
license: mit
---

# WaveForge Demucs Stem Separator

WaveForge 的 AI 分軌後端，使用 [Demucs htdemucs](https://github.com/facebookresearch/demucs) 模型。

## 部署到 HuggingFace Spaces

1. 前往 https://huggingface.co/new-space
2. Space name: `demucs-waveforge`
3. SDK: `Gradio`
4. Hardware: `CPU Basic`（免費）
5. 上傳 `app.py`、`requirements.txt`、`README.md`
6. Space URL 格式：`https://<你的帳號名稱>-demucs-waveforge.hf.space`
7. 將此 URL 填入 `.env.local` 的 `VITE_HF_ENDPOINT`

## API 端點

Gradio 自動產生 REST API：

```
POST https://<space-url>/api/predict
Content-Type: application/json
{
  "data": [null],         // 由 /upload 先上傳取得 path 後替換
  "fn_index": 0
}
```

回傳 4 個音檔（vocals / drums / bass / other）。

## 注意事項

- CPU 免費方案處理 3 分鐘歌曲約需 2–5 分鐘
- 超過 10 分鐘的音檔建議先剪短再上傳
- 每個 Space 有 16 GB RAM 上限
