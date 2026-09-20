/**
 * Smoke test — Demo/Live 邊界誠實性驗證
 *
 * 前提：以「無 .env」狀態執行（SUPABASE_READY=false, HF_READY=false）。
 * 驗證：後端未設定時，UI 必須誠實標示示範/訪客狀態，不得假裝功能可用。
 *
 * 執行：npx playwright install chromium && npm run test:e2e
 */
import { test, expect } from '@playwright/test'

test.describe('WaveForge smoke (no backend configured)', () => {
  test('app boots and shows the master mode', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.logo')).toContainText('Wave')
    await expect(page.locator('#mode-master')).toBeVisible()
  })

  test('mode tabs switch panels (hidden panels are really hidden)', async ({ page }) => {
    await page.goto('/')
    await page.click('.mode-tab[data-mode="antitheft"]')
    await expect(page.locator('#mode-antitheft')).toBeVisible()
    await expect(page.locator('#mode-master')).toBeHidden()
    await page.click('.mode-tab[data-mode="master"]')
    await expect(page.locator('#mode-master')).toBeVisible()
    await expect(page.locator('#mode-antitheft')).toBeHidden()
  })

  test('stems mode honestly disables unavailable separation', async ({ page }) => {
    await page.goto('/')
    await page.click('.mode-tab[data-mode="stems"]')
    const notice = page.locator('#stems-hf-notice')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('分軌服務尚未設定')
    await expect(page.locator('#stems-ai-btn')).toBeDisabled()
  })

  test('antitheft mode shows guest banner when Supabase is unset', async ({ page }) => {
    await page.goto('/')
    await page.click('.mode-tab[data-mode="antitheft"]')
    const banner = page.locator('.guest-mode-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('訪客模式')
    await expect(banner).toContainText('Demo')
  })

  test('auth modal shows backend notice and disables login when Supabase is unset', async ({ page }) => {
    await page.goto('/')
    await page.click('#auth-login-pill')
    const modal = page.locator('#auth-modal')
    await expect(modal).toHaveClass(/open/)
    await expect(page.locator('#auth-backend-notice')).toBeVisible()
    // 不能假登入：submit 與 Google 按鈕必須 disabled
    await expect(page.locator('#auth-submit')).toBeDisabled()
    await expect(page.locator('#auth-google')).toBeDisabled()
  })

  test('bounce is blocked without real stems', async ({ page }) => {
    await page.goto('/')
    await page.click('.mode-tab[data-mode="stems"]')
    // Bounce 按鈕初始必須 disabled（沒有任何 stem buffer）
    await expect(page.locator('#bounce-btn')).toBeDisabled()
  })
})
