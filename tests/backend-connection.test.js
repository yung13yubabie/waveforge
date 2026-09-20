import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createBackendConnection } from '../src/js/backend-connection.js'

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({ auth: {} })) }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks() })

describe('account connection', () => {
  it('never creates an auth client when the configured endpoint rejects the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const connection = createBackendConnection('https://account.test', 'public-key', vi.fn())
    expect(await connection.connect()).toBeNull()
    expect(connection.state).toMatchObject({ status: 'unavailable', message: expect.stringContaining('HTTP 401') })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('aborts a stalled probe and permits a manual retry', async () => {
    vi.useFakeTimers()
    const request = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', request)
    const connection = createBackendConnection('https://account.test', 'public-key', vi.fn())
    const first = connection.connect()
    expect(connection.connect()).toBe(first)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await first).toBeNull()
    expect(connection.state.message).toContain('連線逾時')
    request.mockResolvedValueOnce(new Response('{}'))
    expect(await connection.connect()).toBeTruthy()
    expect(request).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares concurrent connects and reuses the established client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    const connection = createBackendConnection('https://account.test/', 'public-key', vi.fn())
    const clients = await Promise.all([connection.connect(), connection.connect()])
    expect(clients[0]).toBe(clients[1])
    expect(await connection.connect()).toBe(clients[0])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0][0]).toBe('https://account.test/auth/v1/settings')
  })
})
