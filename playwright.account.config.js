import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/account-e2e',
  outputDir: './test-results/account',
  timeout: 30000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', headless: true },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: { VITE_SUPABASE_URL: 'https://account-test.supabase.co', VITE_SUPABASE_ANON_KEY: 'test-public-key' },
  },
})
