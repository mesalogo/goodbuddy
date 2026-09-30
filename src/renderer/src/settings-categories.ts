import i18n from './i18n'

export const settingsCategoryList = [
  {
    id: 'appearance',
    group: 'general',
    translationKey: 'appearance'
  },
  {
    id: 'platform-features',
    group: 'general',
    translationKey: 'platformFeatures'
  },
  {
    id: 'model',
    group: 'execution',
    translationKey: 'model'
  },
  {
    id: 'context-control',
    group: 'execution',
    translationKey: 'contextControl'
  },
  {
    id: 'runtime',
    group: 'execution',
    translationKey: 'runtime'
  },
  {
    id: 'ssh-hosts',
    group: 'execution',
    translationKey: 'sshHosts'
  },
  {
    id: 'document-parsing',
    group: 'extensions',
    translationKey: 'documentParsing'
  },
  {
    id: 'channels',
    group: 'extensions',
    translationKey: 'channels'
  },
  {
    id: 'roles',
    group: 'extensions',
    translationKey: 'roles'
  },
  {
    id: 'capabilities',
    group: 'extensions',
    translationKey: 'capabilities'
  },
  {
    id: 'security',
    group: 'system',
    translationKey: 'security'
  },
  {
    id: 'about',
    group: 'system',
    translationKey: 'about'
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
