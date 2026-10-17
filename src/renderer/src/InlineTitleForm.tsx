import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Inline title entry for "新建" in the workbar panels. Electron does not
 * support window.prompt, so the title is typed here.
 */
export function InlineTitleForm({
  label,
  initial,
  busy,
  onSubmit,
  onCancel
}: {
  label: string
  initial: string
  busy: boolean
  onSubmit: (title: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation('integrations')
  const [title, setTitle] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.select() }, [])
  return (
    <form
      className="wecom-panel__search"
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel() } }}
      onSubmit={(event) => {
        event.preventDefault()
        if (title.trim()) onSubmit(title.trim())
      }}
    >
      <input aria-label={label} maxLength={120} onChange={(event) => setTitle(event.target.value)} ref={input} value={title} />
      <button className="primary-button" disabled={busy || !title.trim()} type="submit">{t('channels.panelCreate.confirm')}</button>
      <button className="secondary-button" onClick={onCancel} type="button">{t('channels.panelCreate.cancel')}</button>
    </form>
  )
}
