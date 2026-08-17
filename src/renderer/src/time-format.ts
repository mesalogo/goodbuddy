export type TimeFormatLocale = 'en-US' | 'zh-CN'

const timeFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

const conversationDateFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

const conversationDateWithYearFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

export function formatTime(
  timestamp: number,
  locale: TimeFormatLocale
): string {
  const formatter =
    timeFormatters[locale] ??
    (timeFormatters[locale] = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit'
    }))
  return formatter.format(timestamp)
}

export function formatConversationListTime(
  timestamp: number,
  locale: TimeFormatLocale,
  referenceTimestamp = Date.now()
): string {
  const date = new Date(timestamp)
  const referenceDate = new Date(referenceTimestamp)
  const isSameYear = date.getFullYear() === referenceDate.getFullYear()
  const isToday =
    isSameYear &&
    date.getMonth() === referenceDate.getMonth() &&
    date.getDate() === referenceDate.getDate()

  if (isToday) {
    return formatTime(timestamp, locale)
  }

  if (isSameYear) {
    const formatter =
      conversationDateFormatters[locale] ??
      (conversationDateFormatters[locale] = new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric'
      }))
    return formatter.format(timestamp)
  }

  const formatter =
    conversationDateWithYearFormatters[locale] ??
    (conversationDateWithYearFormatters[locale] = new Intl.DateTimeFormat(
      locale,
      {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      }
    ))
  return formatter.format(timestamp)
}
