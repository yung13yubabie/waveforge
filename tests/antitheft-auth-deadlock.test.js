import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Regression guard for the supabase-js auth-lock deadlock.
// Making the onAuthStateChange callback `async` and awaiting Supabase data
// calls (loadUserSettings / loadWorksFromDB) inside it holds auth-js's lock
// during a reentrant call → every later call (key save, scan) hangs until
// timeout. The callback MUST stay synchronous and defer DB work with setTimeout.
describe('auth state listener does not deadlock', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/js/antitheft.js'), 'utf8')

  it('onAuthStateChange callback is not async', () => {
    expect(src).not.toMatch(/onAuthStateChange\(\s*async/)
  })

  it('defers DB loads out of the auth callback via setTimeout', () => {
    // The block that reacts to auth changes should schedule loads, not await them.
    const idx = src.indexOf('onAuthStateChange(')
    expect(idx).toBeGreaterThan(-1)
    const block = src.slice(idx, idx + 500)
    expect(block).toMatch(/setTimeout\(/)
    expect(block).not.toMatch(/await loadUserSettings/)
    expect(block).not.toMatch(/await loadWorksFromDB/)
  })
})
