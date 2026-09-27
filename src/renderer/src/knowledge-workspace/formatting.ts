export function resolvedLocale(language: string): string {
  return language || 'zh-CN'
}

type LocaleFormatters = {
  compactDateTime: Intl.DateTimeFormat
  dateTime: Intl.DateTimeFormat
  decimal: Intl.NumberFormat
  integer: Intl.NumberFormat
  percent: Intl.NumberFormat
}

const localeFormatters = new Map<string, LocaleFormatters>()

export function getLocaleFormatters(locale: string): LocaleFormatters {
  const existing = localeFormatters.get(locale)
  if (existing) {
    return existing
  }
  const formatters: LocaleFormatters = {
    compactDateTime: new Intl.DateTimeFormat(locale, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }),
    dateTime: new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }),
    decimal: new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1
    }),
    integer: new Intl.NumberFormat(locale),
    percent: new Intl.NumberFormat(locale, {
      style: 'percent',
      maximumFractionDigits: 0
    })
  }
  localeFormatters.set(locale, formatters)
  return formatters
}

export function formatNumber(value: number, locale: string): string {
  return getLocaleFormatters(locale).integer.format(value)
}

export function formatPercent(value: number, locale: string): string {
  return getLocaleFormatters(locale).percent.format(value)
}
