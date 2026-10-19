import { useMemo, type RefObject } from 'react'
import { LayoutGrid } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { applicationDisplayOrder, type ApplicationSettings, type BuiltInApplicationId } from '../../shared/application-settings-contracts'
import { applicationDefinitions, isApplicationOpenable } from './ApplicationCenter'
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
    return applicationDisplayOrder.filter(id => isApplicationOpenable(settings, id))
  }, [settings])
  // Opening the menu also refreshes settings in the background. Only show the loading row when
  // nothing has loaded yet: an extra row during a refresh grows the upward-anchored menu for a
  // frame and then shrinks it back, which reads as the menu flashing taller.
  return <AnchoredMenu anchorRef={anchorRef} id="application-menu" label={t('applications.title')} onClose={onClose}>
    {pending && !settings && !error && <p role="status">{t('route.loading')}</p>}
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
      <LayoutGrid size={16} aria-hidden="true" /><span>{t('applications.manage')}</span>
    </button>
  </AnchoredMenu>
}
