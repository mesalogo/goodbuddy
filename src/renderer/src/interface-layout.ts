/**
 * Interface layout preference: `classic` keeps application entries inside the conversation sidebar;
 * `workbench` moves them to a fixed application rail and applies the rounded workbench visual layer.
 * Stored per device like the appearance theme; existing users keep `classic`.
 */
export type InterfaceLayout = 'classic' | 'workbench'

const storageKey = 'goodbuddy.interface-layout'

export function loadInterfaceLayout(): InterfaceLayout {
  try {
    return localStorage.getItem(storageKey) === 'workbench' ? 'workbench' : 'classic'
  } catch {
    return 'classic'
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
