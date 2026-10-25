import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatConversationListTime,
  formatDayLabel,
  formatMessageTime,
  formatTime
} from './time-format'

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

  it('shows the time for a conversation updated today', () => {
    const timestamp = new Date(2026, 7, 17, 9, 5).getTime()
    const referenceTimestamp = new Date(2026, 7, 17, 23, 30).getTime()

    expect(
      formatConversationListTime(timestamp, 'zh-CN', referenceTimestamp)
    ).toBe(
      new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit'
      }).format(timestamp)
    )
  })

  it('shows the date after the local calendar day changes', () => {
    const timestamp = new Date(2026, 7, 16, 23, 30).getTime()
    const referenceTimestamp = new Date(2026, 7, 17, 0, 15).getTime()

    expect(
      formatConversationListTime(timestamp, 'zh-CN', referenceTimestamp)
    ).toBe(
      new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric'
      }).format(timestamp)
    )
  })

  it('shows only the time for a message sent today', () => {
    const timestamp = new Date(2026, 7, 21, 21, 51).getTime()
    const referenceTimestamp = new Date(2026, 7, 21, 23, 59).getTime()

    expect(formatMessageTime(timestamp, 'zh-CN', referenceTimestamp)).toBe(
      formatTime(timestamp, 'zh-CN')
    )
  })

  it('shows the full local date and time for an earlier message', () => {
    const timestamp = new Date(2026, 7, 21, 21, 51).getTime()
    const referenceTimestamp = new Date(2026, 7, 22, 0, 5).getTime()

    expect(formatMessageTime(timestamp, 'zh-CN', referenceTimestamp)).toBe(
      '2026/08/21 21:51'
    )
    expect(formatMessageTime(timestamp, 'en-US', referenceTimestamp)).toBe(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(timestamp)
    )
  })

  it('labels days compactly and adds the year only for other years', () => {
    const reference = new Date(2026, 9, 25, 12).getTime()
    expect(
      formatDayLabel(new Date(2026, 7, 21, 9).getTime(), 'zh-CN', reference)
    ).toBe('08/21')
    expect(
      formatDayLabel(new Date(2025, 7, 21, 9).getTime(), 'zh-CN', reference)
    ).toBe('2025/08/21')
  })

  it('includes the year for a conversation from another year', () => {
    const timestamp = new Date(2025, 11, 31, 23, 30).getTime()
    const referenceTimestamp = new Date(2026, 0, 1, 0, 15).getTime()

    expect(
      formatConversationListTime(timestamp, 'en-US', referenceTimestamp)
    ).toBe(
      new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }).format(timestamp)
    )
  })
})
