const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()

export function formatMediumDateTime(
  timestamp: number,
  locale: string
): string {
  let formatter = dateTimeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
    dateTimeFormatters.set(locale, formatter)
  }
  return formatter.format(timestamp)
}
