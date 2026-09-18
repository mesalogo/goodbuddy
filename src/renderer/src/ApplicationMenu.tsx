import { useMemo, type RefObject } from 'react'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { defaultApplicationNavigation, type ApplicationSettings, type BuiltInApplicationId } from '../../shared/application-settings-contracts'
import { applicationDefinitions, isApplicationEnabled } from './ApplicationCenter'
import { AnchoredMenu } from './AnchoredMenu'

export function ApplicationMenu({ anchorRef, settings, pending, error, onClose, onOpen, onManage, onRetry }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  settings?: ApplicationSettings
  pending: boolean
  error?: string
  onClose: () => void
  onOpen: (id: BuiltInApplicationId) => void
  onManage: () => void
  onRetry: () => void
}): React.JSX.Element {
  const { t } = useTranslation('app')
  const applications = useMemo(() => {
    const order = (settings?.applicationNavigation ?? defaultApplicationNavigation).order
    return order
      .filter(id => isApplicationEnabled(settings, id))
  }, [settings])
  return <AnchoredMenu anchorRef={anchorRef} id="application-menu" label={t('applications.title')} onClose={onClose}>
    {pending && <p role="status">{t('route.loading')}</p>}
    {error && <>
      <p role="alert">{error}</p>
      <button type="button" role="menuitem" tabIndex={-1} disabled={pending} onClick={onRetry}>{t('applications.retry')}</button>
    </>}
    {applications.map(id => {
      const definition = applicationDefinitions[id]
      const Icon = definition.icon
      return <button key={id} type="button" role="menuitem" tabIndex={-1} onClick={() => { onClose(); onOpen(id) }}>
        <Icon size={16} aria-hidden="true" /><span>{t(definition.title)}</span>
      </button>
    })}
    <div role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => { onClose(); anchorRef.current?.focus(); onManage() }}>
      <Settings size={16} aria-hidden="true" /><span>{t('applications.manage')}</span>
    </button>
  </AnchoredMenu>
}
