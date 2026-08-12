import '@testing-library/jest-dom/vitest'
import { beforeEach, vi } from 'vitest'
import i18n from './i18n'

if (typeof Element !== 'undefined') {
  Element.prototype.scrollTo = vi.fn()
}

beforeEach(async () => {
  if (typeof localStorage === 'undefined' || typeof document === 'undefined') {
    return
  }
  localStorage.removeItem('goodbuddy.ui-locale')
  await i18n.changeLanguage('zh-CN')
  document.documentElement.lang = 'zh-CN'
})
