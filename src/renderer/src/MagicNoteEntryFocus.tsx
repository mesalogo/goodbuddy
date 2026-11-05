import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Ordinary confirmations stay inline; editing confirmations belong to the focused record. */
export function MagicNoteEntryConfirmation({ children }: { children: ReactNode }): React.JSX.Element {
  const editor = document.getElementById('magic-note-entry-focus')
  return editor ? createPortal(children, editor) : <>{children}</>
}

/** The editor occupies only the record column; surrounding navigation stays usable. */
export function MagicNoteEntryFocus({ children, onCancel, entryId, label }: {
  children: ReactNode
  onCancel: () => void
  entryId: string
  label: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const host = document.getElementById('magic-note-entry-focus-host')
  if (!host) return <></>
  return createPortal(
    <div
      className="magic-note-entry-focus"
      id="magic-note-entry-focus"
      data-entry-id={entryId}
      ref={ref}
      role="region"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(event) => {
        // Nested editor dialogs own their Escape and Tab handling.
        if (event.defaultPrevented || (event.target as HTMLElement).closest('[aria-modal="true"]')) return
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onCancel()
        }
      }}
    >
      {children}
    </div>, host
  )
}
