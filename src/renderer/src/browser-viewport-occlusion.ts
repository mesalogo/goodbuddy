export const browserOverlaySelector = [
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '.app-notification'
].join(', ')

export function isBrowserViewportOccluded(
  host: HTMLElement,
  viewport: DOMRect
): boolean {
  // WebContentsView is above the renderer, regardless of CSS z-index.
  // Release its viewport, not its session, while renderer overlays need it.
  return Array.from(
    host.ownerDocument.querySelectorAll<HTMLElement>(browserOverlaySelector)
  ).some((overlay) => {
    if (overlay.contains(host) || overlay.closest('[hidden]')) return false
    const rect = overlay.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(overlay)
    if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      return false
    }
    for (let element: HTMLElement | null = overlay; element; element = element.parentElement) {
      if (getComputedStyle(element).display === 'none') return false
    }
    return overlay.getAttribute('aria-modal') === 'true' || (
      rect.left < viewport.right &&
      rect.right > viewport.left &&
      rect.top < viewport.bottom &&
      rect.bottom > viewport.top
    )
  })
}
