import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WecomSnapshot } from '../../shared/wecom-contracts'

/**
 * Subscribes to the WeCom tool service snapshot. Pushes and command replies can
 * arrive in any order, so only a snapshot with a newer revision replaces the
 * current one.
 */
export function useWecomSnapshot(): {
  snapshot?: WecomSnapshot
  error?: string
  setSnapshot: (snapshot: WecomSnapshot) => void
} {
  const { t } = useTranslation('integrations')
  const [snapshot, setSnapshotState] = useState<WecomSnapshot>()
  const [error, setError] = useState<string>()
  const available = Boolean(window.goodbuddy?.wecom)
  const setSnapshot = useCallback((next: WecomSnapshot): void => {
    setSnapshotState(current => current && current.revision > next.revision ? current : next)
  }, [])
  useEffect(() => {
    const api = window.goodbuddy?.wecom
    if (!api) return
    let active = true
    void api.getSnapshot().then((next) => { if (active) setSnapshot(next) }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t('wecom.loadError'))
    })
    const remove = api.onChanged((next) => { if (active) setSnapshot(next) })
    return () => { active = false; remove() }
  }, [setSnapshot, t])
  return { snapshot, error: available ? error : t('wecom.unavailable'), setSnapshot }
}
