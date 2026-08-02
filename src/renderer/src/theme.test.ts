import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyAppearanceTheme,
  loadAppearanceTheme,
  resolveAppearanceTheme,
  saveAppearanceTheme
} from './theme'

describe('appearance theme', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    document.documentElement.style.colorScheme = ''
  })

  it('defaults to system and persists valid user choices', () => {
    expect(loadAppearanceTheme()).toBe('system')
    saveAppearanceTheme('dark')
    expect(loadAppearanceTheme()).toBe('dark')
    localStorage.setItem('goodbuddy.appearance-theme', 'invalid')
    expect(loadAppearanceTheme()).toBe('system')
  })

  it('resolves system preference and applies it to the document', () => {
    expect(resolveAppearanceTheme('system', true)).toBe('dark')
    expect(resolveAppearanceTheme('system', false)).toBe('light')
    expect(resolveAppearanceTheme('light', true)).toBe('light')

    applyAppearanceTheme('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
