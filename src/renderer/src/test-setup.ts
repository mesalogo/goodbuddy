import '@testing-library/jest-dom/vitest'
import { beforeEach, vi } from 'vitest'
import i18n from './i18n'
import { clearSshHostRemoteEnvironmentCache } from './ssh-host-remote-environment-cache'

if (typeof Element !== 'undefined') {
  Element.prototype.scrollTo = vi.fn()
}

// jsdom does not implement top-layer rendering; Electron tests cover it.
if (typeof HTMLElement !== 'undefined') {
  HTMLElement.prototype.showPopover = vi.fn()
}

if (typeof ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
}

beforeEach(async () => {
  clearSshHostRemoteEnvironmentCache()
  if (typeof localStorage === 'undefined' || typeof document === 'undefined') {
    return
  }
  localStorage.removeItem('goodbuddy.ui-locale')
  await i18n.changeLanguage('zh-CN')
  document.documentElement.lang = 'zh-CN'
})
