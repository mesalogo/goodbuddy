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

const messageDateTimeFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

export function isSameLocalDay(a: number, b: number): boolean {
  const left = new Date(a)
  const right = new Date(b)
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/**
 * Message header time: only the time for today, otherwise the full local
 * date and time (zh-CN: 2026/08/21 21:51).
 */
export function formatMessageTime(
  timestamp: number,
  locale: TimeFormatLocale,
  referenceTimestamp = Date.now()
): string {
  if (isSameLocalDay(timestamp, referenceTimestamp)) {
    return formatTime(timestamp, locale)
  }
  const formatter =
    messageDateTimeFormatters[locale] ??
    (messageDateTimeFormatters[locale] = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }))
  return formatter.format(timestamp)
}

const shortDateFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

const fullDateFormatters: Partial<
  Record<TimeFormatLocale, Intl.DateTimeFormat>
> = {}

/**
 * Compact day label: month/day in the current year (zh-CN: 08/21), the full
 * local date otherwise (zh-CN: 2026/08/21).
 */
export function formatDayLabel(
  timestamp: number,
  locale: TimeFormatLocale,
  referenceTimestamp = Date.now()
): string {
  const sameYear =
    new Date(timestamp).getFullYear() ===
    new Date(referenceTimestamp).getFullYear()
  const formatters = sameYear ? shortDateFormatters : fullDateFormatters
  const formatter =
    formatters[locale] ??
    (formatters[locale] = new Intl.DateTimeFormat(locale, {
      ...(sameYear ? {} : { year: 'numeric' as const }),
      month: '2-digit',
      day: '2-digit'
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
