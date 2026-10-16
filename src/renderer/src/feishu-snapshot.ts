import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeishuSnapshot } from '../../shared/feishu-contracts'

/** Subscribes to the Feishu tool snapshot, keeping the highest revision. */
export function useFeishuSnapshot(): {
  snapshot?: FeishuSnapshot
  error?: string
  setSnapshot: (snapshot: FeishuSnapshot) => void
} {
  const { t } = useTranslation('integrations')
  const [snapshot, setSnapshotState] = useState<FeishuSnapshot>()
  const [error, setError] = useState<string>()
  const available = Boolean(window.goodbuddy?.feishu)
  const setSnapshot = useCallback((next: FeishuSnapshot): void => {
    setSnapshotState(current => current && current.revision > next.revision ? current : next)
  }, [])
  useEffect(() => {
    const api = window.goodbuddy?.feishu
    if (!api) return
    let active = true
    void api.getSnapshot().then((next) => { if (active) setSnapshot(next) }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t('feishu.loadError'))
    })
    const remove = api.onChanged((next) => { if (active) setSnapshot(next) })
    return () => { active = false; remove() }
  }, [setSnapshot, t])
  return { snapshot, error: available ? error : t('feishu.unavailable'), setSnapshot }
}
