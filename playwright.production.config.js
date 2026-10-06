import { defineConfig } from '@playwright/test'

export default defineConfig({
  reporter: process.env.CI ? 'line' : undefined,
  testDir: './tests/e2e',
  testMatch: ['final-preview.spec.js', 'smoke.spec.js', 'controls-stems.spec.js', 'session-cleanup.spec.js', 'studio-layout.spec.js', 'audio-trust-foundation.spec.js', 'lyrics.spec.js', 'lyrics-auto-alignment.spec.js', 'daw-editor.spec.js', 'daw-transfer.spec.js', 'daw-automation.spec.js', 'daw-replacement.spec.js', 'daw-transpose.spec.js', 'daw-transpose-overload.spec.js', 'signalsmith-lifecycle.spec.js', 'pitch-assistant.spec.js', 'foundation-recovery.spec.js', 'resource-lifecycle.spec.js'],
  outputDir: './test-results-production',
  timeout: 30000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', headless: true },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: false,
  },
})
