# Product planning, not implemented features

These documents describe requested future capabilities, plain-language UX and
acceptance criteria. They do not mean those features are present in the current app.

- [Full upload-first DAW capability specification](FULL_DAW_CAPABILITY_SPEC_ZH_TW.md): 136 proposed capabilities and 862 detail groups, with UI/engine/state/export/test traceability
- [Proposed capability registry](waveforge-capabilities.proposed.json): machine-readable requirements only; implementation bindings are unset and proposed test IDs are not executed tests
- [Audio/vocal functional specification](AUDIO_FEATURE_SPEC_ZH_TW.md): pitch, rhythm, alternate takes, timbre conversion and lyric resinging
- [Lyrics alignment specification](LYRICS_ALIGNMENT_SPEC_ZH_TW.md): pasted line-by-line lyrics, multilingual alignment, second-pass review and LRC/SRT/ASS/TXT export; planning only
- [Design-reference specification](DESIGN_REFERENCE_SPEC_ZH_TW.md): visual/interaction references and proposed workflow
- [Current code audit and foundation repairs](../AUDIO_FOUNDATION_AUDIT_2026-10-05.md): what is implemented, repaired and still missing
- [Existing staged architecture](../DAW_ARCHITECTURE.md): preserve the mastering path while adding project/track/clip foundations

Every future function must connect UI → state/command → processing → history/save →
preview/export → tests. A control without an implemented, available capability must
be absent or visibly unavailable with a concrete explanation; it must not simulate success.

`npm run check:capabilities` checks unique IDs, resolvable/acyclic dependencies and complete proposal contracts. It does not run feature-implementation tests or turn proposed features into completed ones.

## 已整合的歌詞小範圍功能

原文輸入、手動逐句對時、歌詞工程保存與四種文字格式輸出已有本地實作；自動對時與第二輪補漏仍未接入。參閱 [這次怎麼用](../../START_HERE.md) 及 [整合驗證](../validation/LYRICS_INTEGRATION_VALIDATION_2026-10-05.md)。136項對照表仍是完整需求提案，四個歌詞項目標為「不完整」，不代表整項驗收完成。
