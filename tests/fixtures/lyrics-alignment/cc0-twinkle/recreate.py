#!/usr/bin/env python3
"""Recreate the local WAV fixture from the separately downloaded CC0 original.

This script has no network access and does not load or run an ASR model.
Usage: python3 recreate.py /outside/repo/original.ogg [output.wav]
"""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import wave

SOURCE_BYTES = 2_884_672
SOURCE_SHA1 = "49d92ef6ab74740dc4b4bf2852066f794215b001"
SOURCE_SHA256 = "0a9b05a0929699e30cf5f6f124c6e05251ed1505e2a5eb954746e7cd6a6c2f40"


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    source = Path(sys.argv[1]).resolve(strict=True)
    output = (
        Path(sys.argv[2]).resolve()
        if len(sys.argv) == 3
        else Path(__file__).resolve().with_name("first-20s-mono-16k.wav")
    )
    if source == output:
        raise SystemExit("Input and output must be different files")
    data = source.read_bytes()
    if (
        len(data) != SOURCE_BYTES
        or hashlib.sha1(data).hexdigest() != SOURCE_SHA1
        or hashlib.sha256(data).hexdigest() != SOURCE_SHA256
    ):
        raise SystemExit("Original recording failed size/hash verification")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("An already installed ffmpeg is required")
    subprocess.run(
        [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(source), "-t", "20", "-map", "0:a:0", "-ac", "1",
            "-ar", "16000", "-c:a", "pcm_s16le", "-map_metadata", "-1",
            "-fflags", "+bitexact", "-flags:a", "+bitexact", str(output),
        ],
        check=True,
    )
    with wave.open(str(output), "rb") as wav:
        actual = (wav.getnchannels(), wav.getframerate(), wav.getsampwidth(), wav.getnframes())
    if actual != (1, 16_000, 2, 320_000):
        raise SystemExit(f"Unexpected output WAV parameters: {actual}")
    rendered = output.read_bytes()
    print(json.dumps({
        "path": str(output),
        "sizeBytes": len(rendered),
        "sha256": hashlib.sha256(rendered).hexdigest(),
        "sampleRate": 16_000,
        "channels": 1,
        "frames": 320_000,
        "durationSeconds": 20,
    }, indent=2))


if __name__ == "__main__":
    main()
