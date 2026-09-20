import { test, expect } from '@playwright/test'

for (const width of [1440, 390]) {
  test(`studio controls and privacy remain usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    await page.locator('#mod-hplp .module-head').click()
    await page.locator('[data-param="hp-freq"] input[type="number"]').fill('80')
    await page.locator('[data-param="hp-freq"] input[type="number"]').press('Enter')
    await expect(page.locator('[data-param="hp-freq"] input[type="range"]')).toHaveValue('80')
    await page.evaluate(() => { document.body.scrollTop = 0; document.documentElement.scrollTop = 0 })
    await page.screenshot({ path: testInfo.outputPath(`master-${width}.png`) })
    await page.locator('#session-privacy summary').click()
    await expect(page.locator('#clear-session-btn')).toBeInViewport()
    await page.locator('#clear-session-btn').click()
    await expect(page.locator('#session-file-status')).toContainText('已清除')
    await page.locator('#session-privacy summary').click()
    for (const mode of ['stems', 'antitheft']) {
      await page.locator(`[data-mode="${mode}"]`).click()
      if (mode === 'antitheft') {
        await page.locator('.works-library').scrollIntoViewIfNeeded()
        await expect(page.locator('.works-library')).toBeInViewport()
      }
      await page.evaluate(() => { document.body.scrollTop = 0; document.documentElement.scrollTop = 0 })
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`), fullPage: true })
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}
