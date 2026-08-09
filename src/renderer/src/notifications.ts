export type AppNotificationTone = 'success' | 'info' | 'error'

export type AppNotificationInput = {
  tone: AppNotificationTone
  message: string
  dedupeKey?: string
}
