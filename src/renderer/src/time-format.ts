export type TimeFormatLocale = 'en-US' | 'zh-CN'

const timeFormatters: Partial<
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
