import { useSyncExternalStore } from 'react'
import type { ResolvedAppearanceTheme } from './theme'

const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

function resolvedDocumentTheme(): ResolvedAppearanceTheme {
  return document.documentElement.dataset.theme === 'dark'
    ? 'dark'
    : 'light'
}

function notifyThemeListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribeToDocumentTheme(listener: () => void): () => void {
  listeners.add(listener)
  if (
    listeners.size === 1 &&
    typeof MutationObserver === 'function'
  ) {
    observer = new MutationObserver(notifyThemeListeners)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      observer?.disconnect()
      observer = undefined
    }
  }
}

export function useDocumentTheme(): ResolvedAppearanceTheme {
  return useSyncExternalStore(
    subscribeToDocumentTheme,
    resolvedDocumentTheme,
    resolvedDocumentTheme
  )
}
