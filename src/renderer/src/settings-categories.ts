import i18n from './i18n'

export const settingsCategoryList = [
  {
    id: 'appearance',
    translationKey: 'appearance'
  },
  {
    id: 'platform-features',
    translationKey: 'platformFeatures'
  },
  {
    id: 'model',
    translationKey: 'model'
  },
  {
    id: 'document-parsing',
    translationKey: 'documentParsing'
  },
  {
    id: 'runtime',
    translationKey: 'runtime'
  },
  {
    id: 'security',
    translationKey: 'security'
  },
  {
    id: 'automation',
    translationKey: 'automation'
  },
  {
    id: 'channels',
    translationKey: 'channels'
  },
  {
    id: 'roles',
    translationKey: 'roles'
  },
  {
    id: 'skills',
    translationKey: 'skills'
  },
  {
    id: 'mcp',
    translationKey: 'mcp'
  },
  {
    id: 'about',
    translationKey: 'about'
  }
] as const

export type SettingsCategoryDefinition =
  (typeof settingsCategoryList)[number]
export type SettingsCategoryId = SettingsCategoryDefinition['id']

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
