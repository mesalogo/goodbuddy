import { ChevronRight, FolderTree } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'

type MagicTodoDirectoryProps = {
  noteId: string
  title: string
  count: number
  children: ReactNode
}

export function MagicTodoDirectory({
  noteId,
  title,
  count,
  children
}: MagicTodoDirectoryProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  const itemsId = useId()

  return (
    <section className="magic-todo-directory" data-note-id={noteId}>
      <button
        aria-controls={itemsId}
        aria-expanded={expanded}
        aria-label={`${title} (${count})`}
        className="magic-todo-directory__heading"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          size={14}
          style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
        />
        <FolderTree aria-hidden="true" size={14} />
        <strong>{title}</strong>
        <span>{count}</span>
      </button>
      <div
        className="magic-todo-directory__items"
        hidden={!expanded}
        id={itemsId}
        style={{ display: expanded ? undefined : 'none' }}
      >
        {children}
      </div>
    </section>
  )
}
