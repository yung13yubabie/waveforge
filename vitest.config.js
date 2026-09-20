import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.js'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Without `all`, v8 only counts files a test happens to import — an
      // untested module is invisible rather than reported as 0%.
      all: true,
      include: ['src/js/**/*.js'],
      // Excluded files are covered by tests/e2e/ instead: they are DOM wiring
      // and canvas painting, where a jsdom unit test would only assert mocks.
      exclude: [
        'src/js/main.js',
        'src/js/antitheft.js',
        // Logic lives in audio/hf-demucs.js and audio/stem-mix.js; what's left
        // here is button state, cards, and WaveSurfer mounting.
        'src/js/stems-mastering.js',
        'src/js/ui/eq-canvas.js',
        'src/js/ui/goniometer.js',
        'src/js/ui/loudness-graph.js',
        'src/js/ui/spectrogram.js',
        'src/js/ui/spectrum.js',
        'src/js/ui/stems.js',
      ],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 }
    },
    setupFiles: ['./tests/setup.js']
  }
})
