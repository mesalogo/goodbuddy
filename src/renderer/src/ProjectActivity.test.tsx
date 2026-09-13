import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectActivity, ProjectActivityCounts } from './ProjectActivity'
import type { ConversationActivity } from './conversation-activity'

const i18n = createInstance()
void i18n.init({
  lng: 'en',
  initImmediate: false,
  resources: { en: { workspace: { projectActivity: {
    title: 'All project activity', close: 'Close activity',
    attentionCount: '{{count}} need attention', runningCount: '{{count}} running',
    groups: { attention: 'Needs attention', running: 'Running' },
    status: { running: 'Running', approval: 'Waiting for approval', question: 'Waiting for your answer', attention: 'Needs attention' }
  } } } }
})

const activities: ConversationActivity[] = [
  { conversationId: 'running', projectId: 'local', projectName: 'Local', title: 'Build', status: 'running' },
  { conversationId: 'question', projectId: 'remote', projectName: 'Remote', title: 'Choose target', status: 'question' },
  { conversationId: 'approval', projectId: 'remote', projectName: 'Remote', title: 'Approve command', status: 'approval' },
  { conversationId: 'unloaded', projectName: 'Channel', title: 'Background task', status: 'attention' }
]

function view(rows = activities, onOpenConversation = vi.fn()): React.JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <div className="app-shell">
        <button type="button">Destination</button>
        <ProjectActivity activities={rows} onOpenConversation={onOpenConversation} />
      </div>
    </I18nextProvider>
  )
}

afterEach(cleanup)

describe('ProjectActivity', () => {
  it('hides idle activity and zero counts', () => {
    render(view([]))
    expect(screen.queryByRole('button', { name: /All project activity/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const { container } = render(
      <I18nextProvider i18n={i18n}><ProjectActivityCounts attention={0} running={0} /></I18nextProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows global counts and attention-first groups with precise labels', () => {
    render(view())
    fireEvent.click(screen.getByRole('button', { name: /All project activity 3 need attention 1 running/ }))
    const dialog = screen.getByRole('dialog', { name: 'All project activity' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent))
      .toEqual(['Needs attention', 'Running'])
    expect(within(dialog).getByRole('button', { name: 'Remote Choose target Waiting for your answer' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Remote Approve command Waiting for approval' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Channel Background task Needs attention' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Local Build Running' })).toBeInTheDocument()
  })

  it('isolates the background, traps Tab both ways, and restores focus on Escape', () => {
    const { container } = render(view())
    const trigger = screen.getByRole('button', { name: /All project activity/ })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog')
    const close = within(dialog).getByRole('button', { name: 'Close activity' })
    const last = within(dialog).getByRole('button', { name: 'Local Build Running' })
    expect(close).toHaveFocus()
    expect(container.querySelector<HTMLElement>('.app-shell')?.inert).toBe(true)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(container.querySelector<HTMLElement>('.app-shell')?.inert).toBe(false)
  })

  it('navigates directly to an unloaded conversation without stealing destination focus', () => {
    const onOpen = vi.fn(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(document.querySelector<HTMLElement>('.app-shell')?.inert).toBe(false)
      screen.getByRole('button', { name: 'Destination' }).focus()
    })
    render(view(activities, onOpen))
    fireEvent.click(screen.getByRole('button', { name: /All project activity/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Channel Background task Needs attention' }))
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('unloaded')
    expect(screen.getByRole('button', { name: 'Destination' })).toHaveFocus()
  })

  it('updates live rows without refocusing and stays closed after becoming idle', () => {
    const { rerender } = render(view())
    fireEvent.click(screen.getByRole('button', { name: /All project activity/ }))
    const row = screen.getByRole('button', { name: 'Remote Choose target Waiting for your answer' })
    row.focus()
    rerender(view(activities.filter((activity) => activity.status !== 'running')))
    expect(row).toHaveFocus()
    expect(screen.queryByRole('region', { name: 'Running' })).not.toBeInTheDocument()
    rerender(view([]))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.querySelector<HTMLElement>('.app-shell')?.inert).toBe(false)
    rerender(view())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('restores trigger focus when dismissed with the close button', () => {
    render(view())
    const trigger = screen.getByRole('button', { name: /All project activity/ })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'Close activity' }))
    expect(trigger).toHaveFocus()
  })

  it('still handles Escape when a background update removes the focused row', () => {
    const { rerender } = render(view())
    const trigger = screen.getByRole('button', { name: /All project activity/ })
    fireEvent.click(trigger)
    screen.getByRole('button', { name: 'Local Build Running' }).focus()
    rerender(view(activities.filter((activity) => activity.status !== 'running')))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
