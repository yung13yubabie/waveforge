import { test, expect } from '@playwright/test'

const action = (page, name) => page.locator(`[data-daw="${name}"]`)

async function holdWaveformRead(page) {
  await page.addInitScript(() => {
    const original = Blob.prototype.arrayBuffer
    window.__wfHoldWaveform = false
    window.__wfWaveformHeld = false
    Blob.prototype.arrayBuffer = function () {
      const reading = original.call(this)
      // Main's WaveSurfer visual copy is an untyped Blob; real source File
      // reads and actual native engine decoding remain unchanged.
      if (window.__wfHoldWaveform && !(this instanceof File) && this.type === '' && this.size > 44) {
        window.__wfHoldWaveform = false
        window.__wfWaveformHeld = true
        return new Promise((resolve, reject) => {
          window.__wfReleaseWaveform = () => reading.then(resolve, reject)
        })
      }
      return reading
    }
  })
}

async function setupEditor(page, previousMaster = false) {
  await holdWaveformRead(page)
  await page.goto('/')
  if (previousMaster) {
    await page.locator('#file-input').setInputFiles('tests/fixtures/test-tone-8s.wav')
    await expect(page.locator('#export-btn')).toBeEnabled()
  }
  await page.locator('#tab-editor').click()
  await page.locator('#daw-audio-files').setInputFiles('tests/fixtures/test-tone.wav')
  await expect(page.locator('#daw-summary')).toContainText('1 軌 · 1 片段')
  await page.locator('#daw-name').fill('transfer-cancel')
  await page.locator('#daw-name').dispatchEvent('change')
}

async function beginHeldTransfer(page) {
  await page.evaluate(() => { window.__wfHoldWaveform = true })
  await action(page, 'master').click()
  await expect.poll(() => page.evaluate(() => window.__wfWaveformHeld)).toBe(true)
  // These must remain genuine pointer clicks: a globally blocking overlay
  // would make Cancel/Clear unreachable even though programmatic calls work.
  await expect(page.locator('#processing-overlay')).not.toBeVisible()
  await expect(action(page, 'cancel')).toBeVisible()
  await expect(action(page, 'cancel')).toBeEnabled()
  await expect(action(page, 'clear')).toBeEnabled()
}

async function release(page) {
  await page.evaluate(() => window.__wfReleaseWaveform())
  await expect(page.locator('#processing-overlay')).not.toHaveClass(/visible/)
}

test('cancelled transfer after engine decode restores the previous master and does not navigate', async ({ page }) => {
  await setupEditor(page, true)
  await beginHeldTransfer(page)
  await action(page, 'cancel').click()
  await release(page)
  await expect(page.locator('#mode-editor')).toBeVisible()
  await expect(page.locator('#upload-text-wrap')).toContainText('test-tone-8s.wav')
  await expect(page.locator('#session-file-status')).toContainText('test-tone-8s.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await expect(page.locator('#daw-status')).not.toContainText('已將完整混音送往')
  await page.locator('[data-mode="master"]').click()
  await expect(page.locator('#time-total')).toHaveText('0:08')
})

test('clearing the editor while its first master transfer is pending leaves no ghost master source', async ({ page }) => {
  await setupEditor(page)
  await beginHeldTransfer(page)
  page.once('dialog', dialog => dialog.accept())
  await action(page, 'clear').click()
  await release(page)
  await expect(page.locator('#daw-summary')).toContainText('0 軌 · 0 片段')
  await expect(page.locator('#mode-editor')).toBeVisible()
  await page.locator('[data-mode="master"]').click()
  await expect(page.locator('#waveform-empty')).toBeVisible()
  await expect(page.locator('#export-btn')).toBeDisabled()
  await expect(page.locator('#time-total')).toHaveText('0:00')
})

test('editing cancels an old transfer; a fresh transfer succeeds and repeated loads do not double-toggle trim', async ({ page }) => {
  await setupEditor(page, true)
  await beginHeldTransfer(page)
  await page.locator('#daw-output-settings > summary').click()
  await page.locator('#daw-master-gain').fill('-3')
  await page.locator('#daw-master-gain').dispatchEvent('change')
  await release(page)
  await expect(page.locator('#mode-editor')).toBeVisible()
  await expect(page.locator('#upload-text-wrap')).toContainText('test-tone-8s.wav')
  await expect(page.locator('#daw-master-gain')).toHaveValue('-3')
  // Rollback itself is deliberately non-blocking; wait for its restored
  // master to be ready before requesting another transfer.
  await expect(page.locator('#export-btn')).toBeEnabled()
  await action(page, 'master').click()
  await expect(page.locator('#mode-master')).toBeVisible()
  await expect(page.locator('#upload-text-wrap')).toContainText('transfer-cancel.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
  await page.locator('#trim-toggle').click()
  await expect(page.locator('#trim-toggle')).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#trim-toggle').click()
  await expect(page.locator('#trim-toggle')).toHaveAttribute('aria-pressed', 'false')
})

// The opt-out belongs only to editor transfer. Ordinary mastering upload still
// owns its blocking progress overlay while the visual waveform is being built.
test('ordinary master upload retains its processing overlay', async ({ page }) => {
  await holdWaveformRead(page)
  await page.goto('/')
  await page.evaluate(() => { window.__wfHoldWaveform = true })
  await page.locator('#file-input').setInputFiles('tests/fixtures/test-tone-8s.wav')
  await expect.poll(() => page.evaluate(() => window.__wfWaveformHeld)).toBe(true)
  await expect(page.locator('#processing-overlay')).toBeVisible()
  await release(page)
  await expect(page.locator('#processing-overlay')).not.toBeVisible()
  await expect(page.locator('#export-btn')).toBeEnabled()
  await expect(page.locator('#time-total')).toHaveText('0:08')
})
