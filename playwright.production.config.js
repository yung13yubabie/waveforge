import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['final-preview.spec.js', 'smoke.spec.js', 'controls-stems.spec.js'],
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
