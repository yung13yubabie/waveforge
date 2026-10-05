# Actual browser screenshots

These images are captured from the built application using only generated sine-wave WAV fixtures, not user songs or a design mockup.

- Source head: `67e117742d19ab26fa430d3872c89f536772a7ab`
- [CI run](https://github.com/yung13yubabie/waveforge/actions/runs/37384510849)
- Chromium 148.0.7778.96; desktop 1440×1000 and mobile-width viewport 390×844
- The mobile screenshots preserve exact CSS viewport dimensions and top/inspector positions. The earlier full-page capture was unsuitable evidence because the nested body scroller had not reset; that capture is not retained here as a successful visual check.
- Geometry assertions cover container/control horizontal bounds, minimum control targets and fixed transport bounds. Mobile-width Chromium does not establish behavior on real Safari/iOS/Android devices.

Runtime behavior and audio assertions are in `tests/e2e/daw-editor.spec.js`, `daw-render.spec.js` and `daw-transfer.spec.js`. The final follow-up also reloads the app before restoring the ZIP, playing the restored mix and comparing WAV bytes. Screenshots are evidence of the cited source version, not a claim that planned professional-DAW features exist.
