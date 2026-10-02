import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultKnowledgeOntologySettings } from '../../shared/knowledge-ontology'
import './i18n'
import { EntityEditor } from './knowledge-workspace/GraphEditors'
import { EditLibraryDialog } from './knowledge-workspace/LibraryDialogs'
import type { KnowledgeLibrary } from './knowledge-workspace/types'
import {
  WorkspaceUnsavedChangesContext,
  useWorkspaceUnsavedChanges
} from './workspace-unsaved-changes'

afterEach(cleanup)

function Probe({ dirty }: { dirty: boolean }): null {
  useWorkspaceUnsavedChanges(dirty)
  return null
}

describe('workspace unsaved changes', () => {
  it('is a no-op outside a kept-alive route', () => {
    expect(() => render(<Probe dirty />)).not.toThrow()
  })

  it('reports transitions and clears on unmount', () => {
    const report = vi.fn()
    const { rerender, unmount } = render(
      <WorkspaceUnsavedChangesContext.Provider value={report}>
        <Probe dirty={false} />
      </WorkspaceUnsavedChangesContext.Provider>
    )
    expect(report).toHaveBeenLastCalledWith(expect.any(String), false)
    rerender(
      <WorkspaceUnsavedChangesContext.Provider value={report}>
        <Probe dirty />
      </WorkspaceUnsavedChangesContext.Provider>
    )
    expect(report).toHaveBeenLastCalledWith(expect.any(String), true)
    unmount()
    expect(report).toHaveBeenLastCalledWith(expect.any(String), false)
  })

  it('reports an edited graph entity draft against its initial values', () => {
    const report = vi.fn()
    render(
      <WorkspaceUnsavedChangesContext.Provider value={report}>
        <EntityEditor
          node={{ id: 'n1', label: 'Alpha', type: 'concept' } as never}
          ontology={defaultKnowledgeOntologySettings}
          onCancel={vi.fn()}
          onSave={vi.fn()}
        />
      </WorkspaceUnsavedChangesContext.Provider>
    )
    expect(report).not.toHaveBeenCalledWith(expect.any(String), true)
    const name = screen.getByDisplayValue('Alpha')
    fireEvent.change(name, { target: { value: 'Beta' } })
    expect(report).toHaveBeenLastCalledWith(expect.any(String), true)
    fireEvent.change(name, { target: { value: 'Alpha' } })
    expect(report).toHaveBeenLastCalledWith(expect.any(String), false)
  })

  it('reports an edited library name', () => {
    const report = vi.fn()
    render(
      <WorkspaceUnsavedChangesContext.Provider value={report}>
        <EditLibraryDialog
          library={{ id: 'l1', name: 'Library', description: '' } as KnowledgeLibrary}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />
      </WorkspaceUnsavedChangesContext.Provider>
    )
    expect(report).not.toHaveBeenCalledWith(expect.any(String), true)
    fireEvent.change(screen.getByDisplayValue('Library'), {
      target: { value: 'Renamed' }
    })
    expect(report).toHaveBeenLastCalledWith(expect.any(String), true)
  })
})
