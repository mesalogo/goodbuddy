/**
 * Interface layout preference: `classic` keeps application entries inside the conversation sidebar;
 * `workbench` moves them to a fixed application rail and applies the rounded workbench visual layer.
 * Stored per device like the appearance theme. Workbench is the default: new installs and upgrades
 * without a saved choice open in it; a user who picked a layout in Settings keeps that choice.
 */
export type InterfaceLayout = 'classic' | 'workbench'

// Component tests were written against the classic sidebar and opt into the workbench explicitly.
export const defaultInterfaceLayout: InterfaceLayout = import.meta.env.MODE === 'test' ? 'classic' : 'workbench'

const storageKey = 'goodbuddy.interface-layout'

export function loadInterfaceLayout(): InterfaceLayout {
  try {
    const saved = localStorage.getItem(storageKey)
    return saved === 'classic' || saved === 'workbench' ? saved : defaultInterfaceLayout
  } catch {
    return defaultInterfaceLayout
  }
}

export function saveInterfaceLayout(layout: InterfaceLayout): void {
  try {
    localStorage.setItem(storageKey, layout)
  } catch {
    // Layout persistence is optional when browser storage is unavailable.
  }
}

/** Mirrors the layout on the document root so portalled overlays share the same visual layer. */
export function applyInterfaceLayout(layout: InterfaceLayout): void {
  document.documentElement.dataset.layout = layout
}
