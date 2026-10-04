import { useTranslation } from 'react-i18next'
import type { AgentRuntimeStatus } from '../../shared/contracts'

export function ImageCapabilityNotice({ runtime, onOpenModelSettings }: {
  runtime?: AgentRuntimeStatus
  onOpenModelSettings: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('app')
  if (!runtime?.available || runtime.capability === 'image-generation') return null
  if (runtime.supportsToolExecution) return null
  return (
    <div className="composer__option-summary" role="status">
      <span>{t('chat.images.noToolsNotice')}</span>
      {' '}
      <span>{t('chat.images.directWorkflowNotice')}</span>
      <div className="message-image-actions">
        <button type="button" onClick={onOpenModelSettings}>{t('chat.images.openModelSettings')}</button>
      </div>
    </div>
  )
}
