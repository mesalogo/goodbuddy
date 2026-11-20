import { useEffect, useEffectEvent } from 'react'
import type { AppNotificationInput } from './notifications'

export type Notify = (input: AppNotificationInput) => void

export function useErrorNotification(notify: Notify | undefined, message: string | undefined): void {
  const report = useEffectEvent((text: string) => notify?.({ tone: 'error', message: text }))
  useEffect(() => {
    if (message) report(message)
  }, [message])
}
