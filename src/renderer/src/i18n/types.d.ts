import 'i18next'
import app from './locales/zh-CN/app'
import settings from './locales/zh-CN/settings'
import settingsSections from './locales/zh-CN/settingsSections'
import knowledge from './locales/zh-CN/knowledge'
import heartbeat from './locales/zh-CN/heartbeat'
import activity from './locales/zh-CN/activity'
import magicNotes from './locales/zh-CN/magicNotes'
import integrations from './locales/zh-CN/integrations'
import workspace from './locales/zh-CN/workspace'
import warnings from './locales/zh-CN/warnings'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'app'
    resources: {
      app: typeof app
      settings: typeof settings
      settingsSections: typeof settingsSections
      knowledge: typeof knowledge
      heartbeat: typeof heartbeat
      activity: typeof activity
      magicNotes: typeof magicNotes
      integrations: typeof integrations
      workspace: typeof workspace
      warnings: typeof warnings
    }
    returnNull: false
  }
}
