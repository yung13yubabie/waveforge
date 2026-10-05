import { test, expect } from '@playwright/test'

test('final preview invalidates on output or DSP changes and excludes monitor gain', async ({ page }) => {
  await page.goto('/')
  await page.setInputFiles('#file-input', 'tests/fixtures/test-tone.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.locator('.final-preview-panel').evaluate(el => { el.open = true })
  await page.click('#final-preview-btn')
  await expect(page.locator('#final-preview-download')).toBeVisible()
  await page.locator('#master-vol').fill('0.3')
  await expect(page.locator('#final-preview-download')).toBeVisible()
  await page.locator('#export-samplerate').selectOption('96000')
  await expect(page.locator('#final-preview-status')).toContainText('過期')
  await expect(page.locator('#final-preview-download')).toBeHidden()
  expect(await page.locator('#final-preview-audio').getAttribute('src')).toBeNull()
})
test('failed dynamics has an operable bypass recovery for a previously enabled effect', async ({ page }) => {
  await page.addInitScript(() => {
    const original = AudioWorklet.prototype.addModule
    AudioWorklet.prototype.addModule = function (url, ...args) {
      if (String(url).includes('dynamics-worklet')) return Promise.reject(new Error('Injected processor load failure'))
      return original.call(this, url, ...args)
    }
  })
  await page.goto('/')
  const checkbox = page.locator('#deesser-enabled')
  await page.locator('#mod-deesser .module-toggle').click()
  await expect(checkbox).toBeChecked()
  await page.setInputFiles('#file-input', 'tests/fixtures/test-tone.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await expect(checkbox).toBeEnabled()
  await page.click('#export-btn')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await expect(page.locator('#status-text')).toContainText('失敗')
  await page.locator('#mod-deesser .module-toggle').click()
  await expect(checkbox).not.toBeChecked()
  const pending = page.waitForEvent('download')
  await page.click('#export-btn'); await pending
  await page.locator('#mod-deesser .module-toggle').click()
  await expect(checkbox).not.toBeChecked()
})
