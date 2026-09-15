import { useTranslation } from 'react-i18next'
import type { AgentRuntimeStatus } from '../../shared/contracts'

export function ImageCapabilityNotice({ runtime, workMode, hasCallableImageModels, onOpenModelSettings }: {
  runtime?: AgentRuntimeStatus
  workMode: 'ask' | 'execute'
  hasCallableImageModels: boolean
  onOpenModelSettings: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('app')
  if (!runtime?.available || runtime.capability === 'image-generation') return null
  const noTools = !runtime.supportsToolExecution
  if (!noTools && (!hasCallableImageModels || workMode !== 'ask')) return null
  return (
    <div className="composer__option-summary" role="status">
      <span>{t(noTools ? 'chat.images.noToolsNotice' : 'chat.images.askNotice')}</span>
      {noTools && (
        <>
          {' '}
          <span>{t('chat.images.directWorkflowNotice')}</span>
          <div className="message-image-actions">
            <button type="button" onClick={onOpenModelSettings}>{t('chat.images.openModelSettings')}</button>
          </div>
        </>
      )}
    </div>
  )
}
