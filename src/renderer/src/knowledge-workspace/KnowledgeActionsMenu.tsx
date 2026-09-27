import { useId, useRef, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import { AnchoredMenu } from '../AnchoredMenu'

export type KnowledgeAction = {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

export function KnowledgeActionsMenu({ label, actions }: {
  label: string
  actions: KnowledgeAction[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  return <>
    <button ref={anchorRef} type="button" className="icon-button" aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen(!open)}><Ellipsis aria-hidden="true" size={16} /></button>
    {open && <AnchoredMenu anchorRef={anchorRef} id={id} label={label} onClose={() => setOpen(false)}>
      {actions.map((action) => <div key={action.label}>
        {action.separator && <div role="separator" />}
        <button type="button" role="menuitem" className={`knowledge-action${action.danger ? ' knowledge-action--danger' : ''}`}
          disabled={action.disabled} onClick={() => {
            setOpen(false)
            anchorRef.current?.focus()
            action.onClick()
          }}>{action.label}</button>
      </div>)}
    </AnchoredMenu>}
  </>
}
