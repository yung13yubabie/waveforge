import { test, expect } from '@playwright/test'

const storageKey = 'sb-account-test-auth-token'
const expiredSession = {
  access_token: 'expired-test-access-token', refresh_token: 'test-refresh-token',
  expires_at: 1, token_type: 'bearer', user: { id: 'test-user', email: 'listener@example.test' },
}

test('unreachable account service preserves old session without a refresh storm', async ({ page }) => {
  await page.clock.install()
  const requests = []
  await page.addInitScript(({ storageKey, expiredSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(expiredSession))
  }, { storageKey, expiredSession })
  await page.route('https://account-test.supabase.co/**', route => {
    requests.push(new URL(route.request().url()).pathname)
    return route.abort('namenotresolved')
  })
  await page.goto('/')
  await page.locator('#auth-login-pill').click()
  await expect(page.locator('#auth-backend-notice')).toContainText('帳號服務暫時無法連線')
  await expect(page.locator('#auth-submit')).toBeDisabled()
  await expect(page.locator('#auth-retry')).toBeEnabled()
  await page.clock.fastForward(120000)
  expect(requests).toEqual(['/auth/v1/settings'])
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), storageKey)).toEqual(expiredSession)
  await page.locator('#auth-retry').click()
  await expect.poll(() => requests.length).toBe(2)
  expect(requests).toEqual(['/auth/v1/settings', '/auth/v1/settings'])
  await page.locator('#modal-close').click()
  await page.setInputFiles('#file-input', 'tests/fixtures/test-tone.wav')
  await expect(page.locator('#export-btn')).toBeEnabled()
})

test('manual reconnect restores the expired session and token refresh does not reload account data', async ({ page }) => {
  await page.clock.install()
  let offline = true
  const calls = { token: 0, settings: 0, works: 0 }
  await page.addInitScript(({ storageKey, expiredSession }) => {
    localStorage.setItem(storageKey, JSON.stringify(expiredSession))
  }, { storageKey, expiredSession })
  await page.route('https://account-test.supabase.co/**', async route => {
    if (offline) return route.abort('namenotresolved')
    const path = new URL(route.request().url()).pathname
    let json
    if (path === '/auth/v1/settings') json = { external: { email: true } }
    else if (path === '/auth/v1/token') {
      calls.token++
      json = { ...expiredSession, access_token: 'renewed-test-access-token', expires_at: undefined, expires_in: 3600 }
    } else if (path === '/rest/v1/user_settings') {
      calls.settings++
      json = { email_notify: true, spotify_client_id: 'test-spotify-id', spotify_client_secret: 'test-secret' }
    } else if (path === '/rest/v1/works') { calls.works++; json = [{ id: 'test-work', name: '帳號的測試作品', fingerprint_ok: false }] }
    else if (path === '/auth/v1/logout') return route.fulfill({ status: 204 })
    else throw new Error(`Unexpected account request: ${path}`)
    await route.fulfill({ json })
  })
  await page.goto('/')
  await page.locator('#auth-login-pill').click()
  await expect(page.locator('#auth-retry')).toBeVisible()
  offline = false
  await page.locator('#auth-retry').click()
  await expect(page.locator('#auth-avatar')).toBeVisible()
  await expect.poll(() => calls).toEqual({ token: 1, settings: 1, works: 1 })
  await page.clock.fastForward(3600000)
  await expect.poll(() => calls.token).toBe(2)
  expect(calls.settings).toBe(1)
  expect(calls.works).toBe(1)
  await page.locator('#modal-close').click()
  await page.locator('#auth-avatar').click()
  await expect(page.locator('#auth-menu-email')).toHaveText('listener@example.test')
  await page.locator('#auth-menu-logout').click()
  await expect(page.locator('#auth-avatar')).toBeHidden()
  await expect(page.locator('#works-list')).not.toContainText('帳號的測試作品')
  await expect(page.locator('#spotify-client-id')).toHaveValue('')
  await expect(page.locator('#spotify-client-secret')).toHaveValue('')
})

test('login rejection has visible feedback and allows correction', async ({ page }) => {
  await page.route('https://account-test.supabase.co/**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/auth/v1/settings') return route.fulfill({ json: { external: { email: true } } })
    if (path === '/auth/v1/token') return route.fulfill({ status: 400, json: { msg: '帳號或密碼不正確' } })
    throw new Error(`Unexpected account request: ${path}`)
  })
  await page.goto('/')
  await page.locator('#auth-login-pill').click()
  await expect(page.locator('#auth-submit')).toBeEnabled()
  await page.locator('#auth-email').fill('listener@example.test')
  await page.locator('#auth-password').fill('incorrect-test-password')
  await page.locator('#auth-submit').click()
  await expect(page.locator('#auth-message')).toHaveText('帳號或密碼不正確')
  await expect(page.locator('#auth-submit')).toBeEnabled()
  await expect(page.locator('#auth-avatar')).toBeHidden()
})

test('late account reads cannot restore private settings after logout', async ({ page }) => {
  let release
  const delayed = new Promise(resolve => { release = resolve })
  let pendingReads = 0
  let completedReads = 0
  await page.addInitScript(({ storageKey, session }) => {
    localStorage.setItem(storageKey, JSON.stringify(session))
  }, { storageKey, session: { ...expiredSession, expires_at: Math.floor(Date.now() / 1000) + 3600 } })
  await page.route('https://account-test.supabase.co/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/auth/v1/settings') return route.fulfill({ json: { external: { email: true } } })
    if (path === '/auth/v1/logout') return route.fulfill({ status: 204 })
    if (path.startsWith('/rest/v1/')) {
      pendingReads++
      await delayed
      await route.fulfill({ json: path.endsWith('/works')
        ? [{ id: 'late-work', name: '不應回來的舊作品' }]
        : { spotify_client_id: 'old-account-id', spotify_client_secret: 'old-secret' } })
      completedReads++
      return
    }
    throw new Error(`Unexpected account request: ${path}`)
  })
  await page.goto('/')
  await expect(page.locator('#auth-avatar')).toBeVisible()
  await expect.poll(() => pendingReads).toBe(2)
  await page.locator('#auth-avatar').click()
  await page.locator('#auth-menu-logout').click()
  await expect(page.locator('#auth-avatar')).toBeHidden()
  release()
  await expect.poll(() => completedReads).toBe(2)
  await page.locator('[data-mode="antitheft"]').click()
  await expect(page.locator('#auth-required-overlay')).toHaveClass(/visible/)
  await expect(page.locator('#works-list')).not.toContainText('不應回來的舊作品')
  await expect(page.locator('#spotify-client-id')).toHaveValue('')
  await expect(page.locator('#spotify-client-secret')).toHaveValue('')
})
