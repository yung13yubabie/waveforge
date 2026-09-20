"""WaveForge's deployed Demucs CLI pipeline with bounded temporary storage."""
from pathlib import Path
import tempfile

import gradio as gr
import demucs.separate

STEMS = ("vocals", "drums", "bass", "other")


def separate_stems(audio_path):
    if audio_path is None:
        raise gr.Error("請先上傳音訊檔。")
    input_path = Path(audio_path)
    if not input_path.is_file():
        raise gr.Error("找不到上傳的音訊檔，請重新上傳。")

    # Keep the production CPU/htdemucs pipeline. Both failures and success remove
    # its working directory; Gradio owns caching and expiry of returned WAV bytes.
    try:
        with tempfile.TemporaryDirectory(prefix="waveforge-demucs-") as work_dir:
            out_dir = Path(work_dir) / "out"
            demucs.separate.main([
                "-n", "htdemucs", "-d", "cpu", "--out", str(out_dir), str(input_path),
            ])
            outputs = []
            for stem in STEMS:
                matches = list(out_dir.rglob(f"{stem}.wav"))
                if len(matches) != 1:
                    raise gr.Error(f"分軌輸出不完整：{stem}，請重新處理。")
                # Bytes preserve PCM exactly; numpy output would be peak-normalized by Gradio.
                outputs.append(matches[0].read_bytes())
            return tuple(outputs)
    except gr.Error:
        raise
    except Exception as exc:
        raise gr.Error("分軌失敗，請稍後重試或重新選取音檔。") from exc


with gr.Blocks(title="WaveForge Demucs Stem Separator", delete_cache=(300, 3600), analytics_enabled=False) as demo:
    gr.Markdown("## WaveForge 分軌引擎\n音檔會上傳至此 Space。工作目錄於處理結束後移除；輸入與輸出快取每五分鐘檢查，清除超過一小時的檔案。")
    audio = gr.Audio(label="上傳音訊", type="filepath", sources=["upload"])
    run_btn = gr.Button("開始分軌")
    outputs = [gr.Audio(label=stem, type="filepath") for stem in STEMS]
    run_btn.click(fn=separate_stems, inputs=audio, outputs=outputs, api_name="separate")

if __name__ == "__main__":
    demo.queue()
    demo.launch()
