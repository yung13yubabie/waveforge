"""
WaveForge Demucs Stem Separator
部署到 HuggingFace Spaces — 使用 htdemucs 4 軌模型分離音訊

部署步驟：
1. 在 HuggingFace 建立新 Space (SDK: Gradio, Hardware: CPU Basic 免費)
2. 上傳此目錄的所有檔案
3. 等待 Space 建置完成（首次約 5 分鐘）
4. 將 Space URL 填入 WaveForge 的 VITE_HF_ENDPOINT 環境變數
"""

import gradio as gr
import tempfile
import os
import torch
from demucs.api import Separator, save_audio

# 預載模型（Space 啟動時只載入一次）
print("[WaveForge] 載入 Demucs htdemucs 模型...")
separator = Separator("htdemucs")
print("[WaveForge] 模型載入完成")


def separate_stems(audio_path: str):
    """
    接收音訊檔路徑，回傳 4 個分軌的路徑（vocals / drums / bass / other）
    Gradio 會自動把回傳的 filepath 轉換為 Audio widget。
    """
    if audio_path is None:
        return None, None, None, None

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            origin, separated = separator.separate_audio_file(audio_path)
            stem_order = ["vocals", "drums", "bass", "other"]
            paths = []
            for stem in stem_order:
                if stem not in separated:
                    paths.append(None)
                    continue
                out_path = os.path.join(tmpdir, f"{stem}.wav")
                save_audio(separated[stem], out_path, samplerate=44100)
                # 複製到一個不會被 tmpdir 刪除的位置
                import shutil
                dest = out_path.replace(tmpdir, tempfile.mkdtemp())
                shutil.copy(out_path, dest)
                paths.append(dest)
            return tuple(paths)
        except Exception as e:
            raise gr.Error(f"分軌失敗：{str(e)}")


with gr.Blocks(title="WaveForge Stem Separator") as demo:
    gr.Markdown("## WaveForge Demucs 分軌引擎\n上傳音檔，AI 自動分離人聲 / 鼓組 / 貝斯 / 其他")

    with gr.Row():
        with gr.Column(scale=1):
            audio_input = gr.Audio(
                type="filepath",
                label="上傳音訊（MP3 / WAV / FLAC，建議 ≤ 5 分鐘）",
            )
            btn = gr.Button("開始分軌", variant="primary")
        with gr.Column(scale=2):
            with gr.Row():
                out_vocals = gr.Audio(label="人聲 (Vocals)", type="filepath")
                out_drums  = gr.Audio(label="鼓組 (Drums)",  type="filepath")
            with gr.Row():
                out_bass   = gr.Audio(label="貝斯 (Bass)",   type="filepath")
                out_other  = gr.Audio(label="其他 (Other)",  type="filepath")

    btn.click(
        fn=separate_stems,
        inputs=[audio_input],
        outputs=[out_vocals, out_drums, out_bass, out_other],
        api_name="separate",
    )

if __name__ == "__main__":
    demo.launch()
