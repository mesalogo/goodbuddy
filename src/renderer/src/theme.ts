export type AppearanceTheme = 'system' | 'light' | 'dark'
export type ResolvedAppearanceTheme = 'light' | 'dark'

const storageKey = 'goodbuddy.appearance-theme'

export function loadAppearanceTheme(): AppearanceTheme {
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function saveAppearanceTheme(theme: AppearanceTheme): void {
  try {
    localStorage.setItem(storageKey, theme)
  } catch {
    // Theme persistence is optional when browser storage is unavailable.
  }
}

export function resolveAppearanceTheme(
  theme: AppearanceTheme,
  systemPrefersDark: boolean
): ResolvedAppearanceTheme {
  return theme === 'system'
    ? systemPrefersDark
      ? 'dark'
      : 'light'
    : theme
}

export function applyAppearanceTheme(
  theme: ResolvedAppearanceTheme
): void {
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}
