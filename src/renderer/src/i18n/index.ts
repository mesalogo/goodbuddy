import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { activity as englishActivity } from './locales/en-US/activity'
import { app as englishApp } from './locales/en-US/app'
import { heartbeat as englishHeartbeat } from './locales/en-US/heartbeat'
import { integrations as englishIntegrations } from './locales/en-US/integrations'
import { knowledge as englishKnowledge } from './locales/en-US/knowledge'
import { magicNotes as englishMagicNotes } from './locales/en-US/magicNotes'
import { settings as englishSettings } from './locales/en-US/settings'
import { settingsSections as englishSettingsSections } from './locales/en-US/settingsSections'
import { workspace as englishWorkspace } from './locales/en-US/workspace'
import { warnings as englishWarnings } from './locales/en-US/warnings'
import { activity as chineseActivity } from './locales/zh-CN/activity'
import { app as chineseApp } from './locales/zh-CN/app'
import { heartbeat as chineseHeartbeat } from './locales/zh-CN/heartbeat'
import { integrations as chineseIntegrations } from './locales/zh-CN/integrations'
import { knowledge as chineseKnowledge } from './locales/zh-CN/knowledge'
import { magicNotes as chineseMagicNotes } from './locales/zh-CN/magicNotes'
import { settings as chineseSettings } from './locales/zh-CN/settings'
import { settingsSections as chineseSettingsSections } from './locales/zh-CN/settingsSections'
import { workspace as chineseWorkspace } from './locales/zh-CN/workspace'
import { warnings as chineseWarnings } from './locales/zh-CN/warnings'

export const supportedUiLocales = ['zh-CN', 'en-US'] as const
export type UiLocale = (typeof supportedUiLocales)[number]

export const i18nResources = {
  'zh-CN': {
    activity: chineseActivity,
    app: chineseApp,
    heartbeat: chineseHeartbeat,
    integrations: chineseIntegrations,
    knowledge: chineseKnowledge,
    magicNotes: chineseMagicNotes,
    settings: chineseSettings,
    settingsSections: chineseSettingsSections,
    workspace: chineseWorkspace,
    warnings: chineseWarnings
  },
  'en-US': {
    activity: englishActivity,
    app: englishApp,
    heartbeat: englishHeartbeat,
    integrations: englishIntegrations,
    knowledge: englishKnowledge,
    magicNotes: englishMagicNotes,
    settings: englishSettings,
    settingsSections: englishSettingsSections,
    workspace: englishWorkspace,
    warnings: englishWarnings
  }
} as const

void i18n
  .use(initReactI18next)
  .init({
    resources: i18nResources,
    lng: 'zh-CN',
    fallbackLng: 'zh-CN',
    defaultNS: 'app',
    supportedLngs: supportedUiLocales,
    load: 'currentOnly',
    initImmediate: false,
    showSupportNotice: false,
    interpolation: {
      escapeValue: false
    },
    returnNull: false
  })

memoizeLanguageCodeFormatting(i18n)

/**
 * i18next canonicalizes the current language with `Intl.getCanonicalLocales`
 * on every `t()` call. The result depends only on the code and the static init
 * options, so cache it; large lists call `t()` hundreds of times per render.
 */
export function memoizeLanguageCodeFormatting(instance: typeof i18n): void {
  const languageUtils = instance.services?.languageUtils as
    | { formatLanguageCode?: (code: string) => string }
    | undefined
  const format = languageUtils?.formatLanguageCode
  if (!languageUtils || typeof format !== 'function') {
    return
  }
  const cache = new Map<string, string>()
  languageUtils.formatLanguageCode = (code: string): string => {
    if (typeof code !== 'string') {
      return format.call(languageUtils, code)
    }
    let formatted = cache.get(code)
    if (formatted === undefined) {
      formatted = format.call(languageUtils, code)
      if (cache.size < 64) {
        cache.set(code, formatted)
      }
    }
    return formatted
  }
}

export async function changeUiLocale(locale: UiLocale): Promise<void> {
  await i18n.changeLanguage(locale)
  document.documentElement.lang = locale
}

export default i18n
