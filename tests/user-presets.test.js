import { describe, it, expect, beforeEach } from 'vitest'
import { listUserPresets, saveUserPreset, getUserPreset, removeUserPreset } from '../src/js/user-presets.js'

describe('user presets (localStorage)', () => {
  beforeEach(() => localStorage.clear())

  it('starts empty', () => {
    expect(listUserPresets()).toEqual([])
    expect(getUserPreset('x')).toBeNull()
  })

  it('saves and recalls a snapshot', () => {
    const snap = { version: 1, params: { masterVol: 0.5 } }
    expect(saveUserPreset('My Master', snap)).toBe(true)
    expect(getUserPreset('My Master')).toEqual(snap)
    expect(listUserPresets()).toEqual(['My Master'])
  })

  it('lists names sorted (locale, case-insensitive)', () => {
    saveUserPreset('Zed', {}); saveUserPreset('Apple', {}); saveUserPreset('mid', {})
    expect(listUserPresets()).toEqual(['Apple', 'mid', 'Zed'])
  })

  it('overwrites a preset with the same name', () => {
    saveUserPreset('p', { v: 1 }); saveUserPreset('p', { v: 2 })
    expect(getUserPreset('p')).toEqual({ v: 2 })
    expect(listUserPresets().length).toBe(1)
  })

  it('trims the name and rejects blank names', () => {
    expect(saveUserPreset('  spaced  ', { v: 1 })).toBe(true)
    expect(getUserPreset('spaced')).toEqual({ v: 1 })
    expect(saveUserPreset('   ', {})).toBe(false)
    expect(saveUserPreset('', {})).toBe(false)
  })

  it('removes a preset', () => {
    saveUserPreset('a', {}); saveUserPreset('b', {})
    expect(removeUserPreset('a')).toBe(true)
    expect(listUserPresets()).toEqual(['b'])
    expect(removeUserPreset('missing')).toBe(false)
  })

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem('wf_user_presets', '{not json')
    expect(() => listUserPresets()).not.toThrow()
    expect(listUserPresets()).toEqual([])
    // a save recovers it
    expect(saveUserPreset('fresh', { v: 1 })).toBe(true)
    expect(getUserPreset('fresh')).toEqual({ v: 1 })
  })

  it('persists across separate module calls (same localStorage)', () => {
    saveUserPreset('keep', { v: 9 })
    expect(getUserPreset('keep')).toEqual({ v: 9 })
  })
})
