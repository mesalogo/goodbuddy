import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadUiLocalePreference,
  resolveUiLocale,
  saveUiLocalePreference
} from './locale'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('UI locale preference', () => {
  it('preserves Chinese as the compatible default', () => {
    expect(loadUiLocalePreference()).toBe('zh-CN')
    localStorage.setItem('goodbuddy.ui-locale', 'unsupported')
    expect(loadUiLocalePreference()).toBe('zh-CN')
  })

  it('persists supported explicit and system preferences', () => {
    saveUiLocalePreference('en-US')
    expect(loadUiLocalePreference()).toBe('en-US')
    saveUiLocalePreference('system')
    expect(loadUiLocalePreference()).toBe('system')
  })

  it('resolves Chinese and English system languages deterministically', () => {
    expect(resolveUiLocale('system', ['zh-Hant-HK'])).toBe('zh-CN')
    expect(resolveUiLocale('system', ['en-GB'])).toBe('en-US')
    expect(resolveUiLocale('system', ['fr-FR'])).toBe('en-US')
    expect(resolveUiLocale('en-US', ['zh-CN'])).toBe('en-US')
  })

  it('continues when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(loadUiLocalePreference()).toBe('zh-CN')
    expect(() => saveUiLocalePreference('en-US')).not.toThrow()
  })
})
