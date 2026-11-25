import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from './i18n'
import type { AgentRuntimeSelection } from '../../shared/runtime-selection-contracts'

export function AttachmentCapabilityNotice({ conversationId, selection, revision }: {
  conversationId: string; selection?: AgentRuntimeSelection; revision: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [reason, setReason] = useState<string>()
  const [confirmed, setConfirmed] = useState(false)
  const key = JSON.stringify(selection)
  useEffect(() => {
    let active = true
    void window.goodbuddy.context.imageCapability(conversationId, JSON.parse(key ?? 'null') ?? undefined).then((result) => {
      if (active) { setConfirmed(true); setReason(result.supported ? undefined : result.reason) }
    }, () => { if (active) { setConfirmed(false); setReason(i18n.t('settings:documentParsing.capabilityNotice.unconfirmed')) } })
    return () => { active = false }
  }, [conversationId, key, revision])
  return !confirmed || reason ? <p className="settings-warning" role="status">{reason ?? t('documentParsing.capabilityNotice.checking')}</p> : <></>
}
