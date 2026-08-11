import { afterEach, describe, expect, it } from 'vitest'
import i18n, {
  changeUiLocale,
  i18nResources
} from './index'

function leafKeys(
  value: object,
  prefix = ''
): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof child === 'string'
      ? [path]
      : leafKeys(child as object, path)
  })
}

afterEach(async () => {
  await changeUiLocale('zh-CN')
})

describe('renderer i18n resources', () => {
  it('keeps Chinese and English namespace keys in sync', () => {
    for (const namespace of Object.keys(
      i18nResources['zh-CN']
    ) as Array<keyof (typeof i18nResources)['zh-CN']>) {
      expect(
        leafKeys(i18nResources['en-US'][namespace]).sort()
      ).toEqual(
        leafKeys(i18nResources['zh-CN'][namespace]).sort()
      )
    }
  })

  it('switches language and document metadata without reloading', async () => {
    await changeUiLocale('en-US')
    expect(document.documentElement.lang).toBe('en-US')
    expect(i18n.t('navigation.chat')).toBe('Chat')

    await changeUiLocale('zh-CN')
    expect(i18n.t('navigation.chat')).toBe('对话')
  })
})
