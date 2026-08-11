import '@testing-library/jest-dom/vitest'
import { beforeEach, vi } from 'vitest'
import i18n from './i18n'

Element.prototype.scrollTo = vi.fn()

beforeEach(async () => {
  localStorage.removeItem('goodbuddy.ui-locale')
  await i18n.changeLanguage('zh-CN')
  document.documentElement.lang = 'zh-CN'
})
