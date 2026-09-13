import { afterEach, describe, expect, it, vi } from 'vitest'
import { isBrowserViewportOccluded } from './browser-viewport-occlusion'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function setup(attributes: Record<string, string>, overlaps = true) {
  const host = document.createElement('div')
  const parent = document.createElement('div')
  const overlay = document.createElement('section')
  for (const [name, value] of Object.entries(attributes)) {
    overlay.setAttribute(name, value)
  }
  parent.append(overlay)
  document.body.append(host, parent)
  const viewport = new DOMRect(600, 100, 400, 500)
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(overlaps ? 700 : 10, 200, 200, 100)
  )
  return { host, parent, overlay, viewport }
}

describe('native browser overlay detection', () => {
  it('blocks an application modal even when its surface does not overlap the page', () => {
    const { host, viewport } = setup({ 'aria-modal': 'true' }, false)
    expect(isBrowserViewportOccluded(host, viewport)).toBe(true)
  })
  it.each(['dialog', 'alertdialog', 'menu'])('detects overlapping %s without requiring modal focus setup', role => {
    const { host, viewport } = setup({ role })
    expect(isBrowserViewportOccluded(host, viewport)).toBe(true)
  })
  it.each(['hidden', 'display', 'visibility', 'ancestor-display'])('ignores a modal hidden by %s', kind => {
    const { host, parent, overlay, viewport } = setup({ 'aria-modal': 'true' })
    if (kind === 'hidden') parent.hidden = true
    if (kind === 'display') overlay.style.display = 'none'
    if (kind === 'visibility') overlay.style.visibility = 'hidden'
    if (kind === 'ancestor-display') parent.style.display = 'none'
    expect(isBrowserViewportOccluded(host, viewport)).toBe(false)
  })
  it('does not treat inline statuses and error messages as overlays', () => {
    const { host, viewport } = setup({ role: 'alert' })
    expect(isBrowserViewportOccluded(host, viewport)).toBe(false)
  })
  it('does not let a surrounding non-modal container hide its own browser', () => {
    const { host, overlay, viewport } = setup({ role: 'dialog' })
    overlay.append(host)
    expect(isBrowserViewportOccluded(host, viewport)).toBe(false)
  })
})
