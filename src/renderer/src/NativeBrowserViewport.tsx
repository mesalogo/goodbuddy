import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserLiveState, BrowserTabId } from '../../shared/contracts'
import { browserOverlaySelector, isBrowserViewportOccluded } from './browser-viewport-occlusion'

export function NativeBrowserViewport({ browserState, conversationId, tabId, visible }: {
  browserState?: BrowserLiveState
  conversationId?: string
  tabId?: BrowserTabId
  visible: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const hostRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = hostRef.current
    const api = window.goodbuddy?.browser
    if (!host || !conversationId || !tabId || !visible || !api?.setViewport) return
    const leaseToken = crypto.randomUUID()
    let animationFrame: number | undefined
    let lastRequest = ''
    let resizeObserver: ResizeObserver | undefined
    const observedOverlays = new Set<Element>()
    const panel = host.closest<HTMLElement>('[role="tabpanel"]')
    const syncViewport = (): void => {
      if (animationFrame !== undefined) return
      animationFrame = requestAnimationFrame(() => {
        animationFrame = undefined
        const rect = host.getBoundingClientRect()
        const isVisible = panel?.hidden !== true && rect.width >= 1 && rect.height >= 1 && !isBrowserViewportOccluded(host, rect)
        const bounds = isVisible ? { x: Math.max(0, Math.round(rect.left)), y: Math.max(0, Math.round(rect.top)), width: Math.round(rect.width), height: Math.round(rect.height) } : undefined
        const request = JSON.stringify({ conversationId, tabId, bounds })
        if (request === lastRequest) return
        lastRequest = request
        void api.setViewport(isVisible ? { conversationId, tabId, leaseToken, bounds: bounds! } : { leaseToken }).catch(() => undefined)
      })
    }
    const updateObservation = (): void => {
      if (panel?.hidden !== false) {
        resizeObserver?.disconnect()
        resizeObserver = undefined
        observedOverlays.clear()
        syncViewport()
        return
      }
      if (!resizeObserver && typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(syncViewport)
        resizeObserver.observe(host)
      }
      if (resizeObserver) {
        const overlays = new Set(document.querySelectorAll(browserOverlaySelector))
        for (const overlay of observedOverlays) {
          if (!overlays.has(overlay)) { resizeObserver.unobserve(overlay); observedOverlays.delete(overlay) }
        }
        for (const overlay of overlays) {
          if (!observedOverlays.has(overlay)) { resizeObserver.observe(overlay); observedOverlays.add(overlay) }
        }
      }
      syncViewport()
    }
    const mutationObserver = new MutationObserver(updateObservation)
    mutationObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-modal', 'role', 'class', 'style', 'open'] })
    window.addEventListener('resize', syncViewport)
    window.addEventListener('scroll', syncViewport, true)
    document.addEventListener('transitionend', syncViewport, true)
    document.addEventListener('animationend', syncViewport, true)
    updateObservation()
    return () => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame)
      resizeObserver?.disconnect()
      mutationObserver.disconnect()
      window.removeEventListener('resize', syncViewport)
      window.removeEventListener('scroll', syncViewport, true)
      document.removeEventListener('transitionend', syncViewport, true)
      document.removeEventListener('animationend', syncViewport, true)
      void api.setViewport({ leaseToken }).catch(() => undefined)
    }
  }, [conversationId, tabId, visible])
  return <div aria-label={t('sidebar.browser.viewport')} aria-busy={browserState?.status === 'creating' || browserState?.status === 'loading'} className="assistant-sidebar__browser-viewport" ref={hostRef}>
    {browserState?.sessionActive !== true ? <div className="assistant-sidebar__browser-placeholder">
      {browserState?.status === 'creating' ? t('sidebar.browser.statuses.creating') : browserState?.status === 'failed' ? browserState.error ?? t('sidebar.browser.statuses.failed') : t('sidebar.browser.empty')}
    </div> : null}
  </div>
}
