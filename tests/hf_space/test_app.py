"""Exercise file ownership and exact output bytes without downloading the model."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch
import types


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.gradio = MagicMock()
        self.gradio.Error = RuntimeError
        self.separate = types.ModuleType("demucs.separate")
        self.separate.main = MagicMock(side_effect=self.create_stems)
        demucs = types.ModuleType("demucs")
        demucs.separate = self.separate
        spec = importlib.util.spec_from_file_location("space_app", Path(__file__).parents[2] / "hf-space/app.py")
        self.app = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"gradio": self.gradio, "demucs": demucs, "demucs.separate": self.separate}):
            spec.loader.exec_module(self.app)
        self.source = Path(__file__).parents[1] / "fixtures/test-tone.wav"
        self.work_dir = None

    def create_stems(self, args):
        out = Path(args[args.index("--out") + 1])
        self.work_dir = out.parent
        out.mkdir()
        for stem in self.app.STEMS:
            (out / f"{stem}.wav").write_bytes(self.source.read_bytes())

    def test_preserves_exact_wav_bytes_and_removes_work_directory(self):
        result = self.app.separate_stems(str(self.source))
        self.assertEqual(result, (self.source.read_bytes(),) * 4)
        self.assertFalse(self.work_dir.exists())
        self.gradio.Blocks.assert_called_once_with(
            title="WaveForge Demucs Stem Separator", delete_cache=(300, 3600), analytics_enabled=False)

    def test_failure_removes_partial_outputs_and_hides_server_paths(self):
        def fail(args):
            self.create_stems(args)
            raise ValueError("/private/user-recording.wav")
        self.separate.main.side_effect = fail
        with self.assertRaisesRegex(RuntimeError, "^分軌失敗，請稍後重試或重新選取音檔。$"):
            self.app.separate_stems(str(self.source))
        self.assertFalse(self.work_dir.exists())

    def test_incomplete_output_is_rejected_and_cleaned(self):
        def incomplete(args):
            self.create_stems(args)
            (self.work_dir / "out/bass.wav").unlink()
        self.separate.main.side_effect = incomplete
        with self.assertRaisesRegex(RuntimeError, "分軌輸出不完整：bass"):
            self.app.separate_stems(str(self.source))
        self.assertFalse(self.work_dir.exists())

    def test_empty_or_missing_input_does_not_start_model(self):
        for value in [None, str(self.source.parent / "missing.wav")]:
            with self.assertRaises(RuntimeError):
                self.app.separate_stems(value)
        self.separate.main.assert_not_called()


if __name__ == "__main__":
    unittest.main()
