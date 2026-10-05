# CC0 singing fixture: Twinkle Twinkle Little Star

This is a **data-intake fixture, not an alignment benchmark with ground truth**.
It contains the first 20 seconds of Derrick Coetzee / Dcoetzee's own a cappella
recording, converted locally to mono 16 kHz, signed 16-bit PCM WAV.

## Rights and provenance

- Recording: **Twinkle Twinkle Little Star - sung with full lyrics**
- Creator: Derrick Coetzee / Wikimedia Commons user Dcoetzee
- Recording/upload date: 2012-03-25
- Recording license: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- [Original uploader's permission and own-work declaration](https://commons.wikimedia.org/w/index.php?title=File:Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg&oldid=68819349)
- [Current file page](https://commons.wikimedia.org/wiki/File:Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg)
- [Original Ogg recording](https://upload.wikimedia.org/wikipedia/commons/4/4f/Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg)

CC0 permits copying, modification and redistribution, including commercial use.
This audio fixture retains that CC0 status independently of the repository's
code license. Attribution is not required by CC0, but provenance is retained here.
Do not imply that the performer endorses WaveForge.

The current file page's Source field was edited in 2026 to point to an unrelated
lyrics site. The immutable 2012 uploader revision above explicitly says "Own
work" and contains the CC0 dedication. The original file's size and SHA-1 were
checked against Wikimedia's imageinfo metadata before processing.

Jane Taylor's underlying words are public domain. Historical text references:
[The Star, Rhymes for the Nursery (1806)](https://en.wikisource.org/wiki/Rhymes_for_the_Nursery/The_Star)
and [The Child's Own Music Book (1918)](https://en.wikisource.org/wiki/The_Child%27s_Own_Music_Book/Twinkle,_Twinkle,_Little_Star).
These are lyric references only, not a verified transcript of this excerpt.

## Recreate locally

Keep the 2,884,672-byte original outside the repository. With an already
installed Python 3 and ffmpeg, run from this directory:

```sh
python3 recreate.py /path/outside/repository/Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg
```

An optional second argument selects another output WAV for reproducibility
checks. The script verifies original size, SHA-1 and SHA-256 before processing.
It performs no network request, download, model execution or audio upload.

Processing selects source time 0.000 through 20.000 seconds; it does not find
musical phrase boundaries. Only resampling, mono conversion, cropping and
container metadata removal are performed. No time stretching or normalization
is applied. The WAV is 320,000 mono frames at 16,000 Hz. The exact ffmpeg version
and output hashes are recorded in `provenance.json`; different ffmpeg builds may
produce different resampling bytes.

## Annotation and model-validation status

- Audio has **not been listened to or manually transcribed** during intake
- `transcriptVerified` is `false`; `transcript` is `null`
- `expectedAnchors` is empty; no timing gold has been invented
- This excerpt may end in the middle of a word or phrase
- The singer's source description explicitly notes performance errors
- No ASR model was downloaded or executed, and no audio was sent to an API
- Mandarin singing coverage is still missing

Do not present this file as a passed speech-recognition or lyric-alignment test.
It must remain ineligible for the opt-in real-model test until a person verifies
the performed words and manually annotates at least two timestamp anchors, and
model execution is separately approved. The current real-model harness expects
raw float32 little-endian PCM through `pcmFile`; this retained WAV is not that
input format. Do not point `pcmFile` at the WAV container. Prepare any required
raw-PCM input only as part of a separately authorized, annotated validation run.
