import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatTime } from './time-format'

describe('formatTime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses one formatter per supported locale', () => {
    const NativeDateTimeFormat = Intl.DateTimeFormat
    const formatter = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(
        function DateTimeFormat(locales, options) {
          return new NativeDateTimeFormat(locales, options)
        }
      )

    const firstEnglish = formatTime(1_775_000_000_000, 'en-US')
    const secondEnglish = formatTime(1_775_000_060_000, 'en-US')
    const firstChinese = formatTime(1_775_000_000_000, 'zh-CN')
    const secondChinese = formatTime(1_775_000_060_000, 'zh-CN')

    expect(firstEnglish).not.toBe('')
    expect(secondEnglish).not.toBe('')
    expect(firstChinese).not.toBe('')
    expect(secondChinese).not.toBe('')
    expect(formatter).toHaveBeenCalledTimes(2)
  })
})
