import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// config.js reads import.meta.env at module-evaluation time, so each case must
// stub the env and then re-import the module fresh.
async function loadConfig(env) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../src/js/config.js')
}

describe('config', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllEnvs())

  it('reads Supabase and HF values from the environment', async () => {
    const c = await loadConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
      VITE_HF_ENDPOINT: 'https://hf.example/api',
    })

    expect(c.SUPABASE_URL).toBe('https://example.supabase.co')
    expect(c.SUPABASE_ANON_KEY).toBe('anon-key')
    expect(c.HF_ENDPOINT).toBe('https://hf.example/api')
  })

  it('falls back to empty strings when the environment variables are truly absent', async () => {
    // Stubbing to '' (as the other case below does) sets a falsy value, but
    // ?? only falls back on null/undefined — an explicit '' never exercises
    // that branch. This omits stubEnv entirely so the vars are genuinely
    // undefined, the only way to actually hit the ?? fallback.
    vi.resetModules()
    const c = await import('../src/js/config.js')

    expect(c.SUPABASE_URL).toBe('')
    expect(c.SUPABASE_ANON_KEY).toBe('')
    expect(c.HF_ENDPOINT).toBe('')
  })

  it('treats an explicitly empty string the same as unset', async () => {
    const c = await loadConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HF_ENDPOINT: '',
    })

    expect(c.SUPABASE_URL).toBe('')
    expect(c.SUPABASE_ANON_KEY).toBe('')
    expect(c.HF_ENDPOINT).toBe('')
  })

  it('derives the ACR edge function URL from the Supabase URL', async () => {
    const c = await loadConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
      VITE_HF_ENDPOINT: '',
    })

    expect(c.ACR_EDGE_FN).toBe('https://example.supabase.co/functions/v1/acr-scan')
  })

  it('leaves the ACR edge function URL empty rather than building a bogus one', async () => {
    const c = await loadConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HF_ENDPOINT: '',
    })

    expect(c.ACR_EDGE_FN).toBe('')
  })

  it('reports SUPABASE_CONFIGURED only when both URL and key are present', async () => {
    const both = await loadConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
      VITE_HF_ENDPOINT: '',
    })
    expect(both.SUPABASE_CONFIGURED).toBe(true)

    const keyOnly = await loadConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: 'anon-key',
      VITE_HF_ENDPOINT: '',
    })
    expect(keyOnly.SUPABASE_CONFIGURED).toBe(false)

    const urlOnly = await loadConfig({
      VITE_SUPABASE_URL: 'https://example.supabase.co',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HF_ENDPOINT: '',
    })
    expect(urlOnly.SUPABASE_CONFIGURED).toBe(false)
  })

  it('reports HF_READY only when the endpoint is configured', async () => {
    const on = await loadConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HF_ENDPOINT: 'https://hf.example/api',
    })
    expect(on.HF_READY).toBe(true)

    const off = await loadConfig({
      VITE_SUPABASE_URL: '',
      VITE_SUPABASE_ANON_KEY: '',
      VITE_HF_ENDPOINT: '',
    })
    expect(off.HF_READY).toBe(false)
  })
})
