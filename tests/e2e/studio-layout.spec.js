import { test, expect } from '@playwright/test'

for (const width of [1440, 390]) {
  test(`studio controls and privacy remain usable at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/')
    const contrast = await page.evaluate(() => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(x => {
          const v = x / 255
          return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
        })
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
      }
      return ['#bounce-btn', '#auth-submit', '#export-btn'].map(selector => {
        const style = getComputedStyle(document.querySelector(selector))
        const a = luminance(style.color), b = luminance(style.backgroundColor)
        return { selector, ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) }
      })
    })
    for (const { selector, ratio } of contrast) expect(ratio, selector).toBeGreaterThanOrEqual(4.5)
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
