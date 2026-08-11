import type { UiLocale } from './index'

export type UiLocalePreference = 'system' | UiLocale

const storageKey = 'goodbuddy.ui-locale'

export function loadUiLocalePreference(): UiLocalePreference {
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'system' || value === 'en-US' || value === 'zh-CN'
      ? value
      : 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

export function saveUiLocalePreference(
  preference: UiLocalePreference
): void {
  try {
    localStorage.setItem(storageKey, preference)
  } catch {
    // Locale persistence is optional when browser storage is unavailable.
  }
}

export function resolveUiLocale(
  preference: UiLocalePreference,
  systemLanguages: readonly string[]
): UiLocale {
  if (preference !== 'system') {
    return preference
  }
  for (const language of systemLanguages) {
    const normalized = language.toLowerCase()
    if (normalized === 'zh' || normalized.startsWith('zh-')) {
      return 'zh-CN'
    }
    if (normalized === 'en' || normalized.startsWith('en-')) {
      return 'en-US'
    }
  }
  return 'en-US'
}

export function systemUiLanguages(): readonly string[] {
  if (
    typeof navigator.languages !== 'undefined' &&
    navigator.languages.length > 0
  ) {
    return navigator.languages
  }
  return navigator.language ? [navigator.language] : []
}
