import i18n from './i18n'
import {
  Bot,
  FileText,
  Gauge,
  Info,
  Palette,
  Radio,
  Server,
  SlidersHorizontal,
  Terminal,
  Users,
  Wrench
} from 'lucide-react'

export const settingsCategoryList = [
  {
    id: 'appearance',
    group: 'general',
    translationKey: 'appearance',
    icon: Palette
  },
  {
    id: 'platform-features',
    group: 'general',
    translationKey: 'platformFeatures',
    icon: SlidersHorizontal
  },
  {
    id: 'model',
    group: 'execution',
    translationKey: 'model',
    icon: Bot
  },
  {
    id: 'context-control',
    group: 'execution',
    translationKey: 'contextControl',
    icon: Gauge
  },
  {
    id: 'runtime',
    group: 'execution',
    translationKey: 'runtime',
    icon: Terminal
  },
  {
    id: 'ssh-hosts',
    group: 'execution',
    translationKey: 'sshHosts',
    icon: Server
  },
  {
    id: 'document-parsing',
    group: 'extensions',
    translationKey: 'documentParsing',
    icon: FileText
  },
  {
    id: 'channels',
    group: 'extensions',
    translationKey: 'channels',
    icon: Radio
  },
  {
    id: 'roles',
    group: 'extensions',
    translationKey: 'roles',
    icon: Users
  },
  {
    id: 'capabilities',
    group: 'extensions',
    translationKey: 'capabilities',
    icon: Wrench
  },
  {
    id: 'about',
    group: 'system',
    translationKey: 'about',
    icon: Info
  }
] as const

export type SettingsCategoryDefinition =
  (typeof settingsCategoryList)[number]
export type SettingsCategoryId = SettingsCategoryDefinition['id']

export function getSettingsCategoryList(
  remoteProjectsEnabled: boolean
): readonly SettingsCategoryDefinition[] {
  return remoteProjectsEnabled
    ? settingsCategoryList
    : settingsCategoryList.filter(({ id }) => id !== 'ssh-hosts')
}

type LocalizedSettingsCategoryDefinition = SettingsCategoryDefinition & {
  readonly label: string
  readonly navigationDescription: string
  readonly description: string
}

export const settingsCategories = Object.fromEntries(
  settingsCategoryList.map((category) => [
    category.id,
    {
      ...category,
      get label() {
        return i18n.t(
          `categories.${category.translationKey}.label`,
          { ns: 'settings' }
        )
      },
      get navigationDescription() {
        return i18n.t(
          `categories.${category.translationKey}.navigationDescription`,
          { ns: 'settings' }
        )
      },
      get description() {
        return i18n.t(
          `categories.${category.translationKey}.description`,
          { ns: 'settings' }
        )
      }
    }
  ])
) as Record<SettingsCategoryId, LocalizedSettingsCategoryDefinition>
