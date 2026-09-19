import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { InlineHelp } from './InlineHelp'
import { PageHeader } from './WorkspacePrimitives'
import { SettingsSectionHeader } from './SettingsPrimitives'

afterEach(() => { cleanup(); vi.useRealTimers() })

it('preserves externally referenced descriptions while closed and never duplicates their IDs', () => {
  render(<>
    <input aria-label="Context size" aria-describedby="context-description" defaultValue="128" />
    <InlineHelp label="Context help" id="context-description">Keep this model context size.</InlineHelp>
  </>)
  const input = screen.getByRole('textbox')
  const trigger = screen.getByRole('button', { name: 'Context help' })
  const check = (): void => {
    expect(input).toHaveAccessibleDescription('Keep this model context size.')
    expect(trigger).toHaveAccessibleDescription('Keep this model context size.')
    expect(document.querySelectorAll('#context-description')).toHaveLength(1)
    expect(input).toHaveValue('128')
  }
  check()
  expect(document.getElementById('context-description')).not.toBeVisible()
  fireEvent.click(trigger)
  check()
  expect(screen.getByRole('tooltip')).toBeVisible()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  check()
  expect(document.getElementById('context-description')).not.toBeVisible()
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('supports hover transfer, focus, pinned clicks, outside dismissal and isolated Escape', () => {
  vi.useFakeTimers()
  const parentEscape = vi.fn()
  render(<section role="dialog" aria-modal="true" onKeyDown={parentEscape}>
    <button>Outside</button>
    <InlineHelp label="Context" id="context-help">Long help text</InlineHelp>
  </section>)
  const trigger = screen.getByRole('button', { name: 'Context' })
  const outside = screen.getByText('Outside')
  outside.focus()
  fireEvent.mouseEnter(trigger)
  expect(outside).toHaveFocus()
  expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('tooltip'))
  expect(trigger).toHaveAttribute('aria-describedby', 'context-help')
  fireEvent.mouseLeave(trigger)
  fireEvent.mouseEnter(screen.getByRole('tooltip'))
  act(() => vi.advanceTimersByTime(150))
  expect(screen.getByRole('tooltip')).toBeInTheDocument()
  fireEvent.mouseLeave(screen.getByRole('tooltip'))
  act(() => vi.advanceTimersByTime(150))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  act(() => trigger.focus())
  expect(screen.getByRole('tooltip')).toBeInTheDocument()
  fireEvent.click(trigger)
  fireEvent.mouseLeave(trigger)
  act(() => vi.advanceTimersByTime(150))
  expect(screen.getByRole('tooltip')).toBeInTheDocument()
  fireEvent.click(trigger)
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  fireEvent.click(trigger)
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  expect(parentEscape).not.toHaveBeenCalled()
  expect(trigger).toHaveFocus()
  fireEvent.click(trigger)
  fireEvent.pointerDown(outside)
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  fireEvent.click(trigger)
  act(() => outside.focus())
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('adds optional help beside both header titles without replacing descriptions', () => {
  render(<>
    <PageHeader headingId="page" title="Page" help="Page help" description="Page description" />
    <SettingsSectionHeader headingId="section" title="Section" help="Section help" description="Section description" />
  </>)
  for (const title of ['Page', 'Section']) {
    const trigger = screen.getByRole('button', { name: title })
    expect(trigger.parentElement).toHaveClass('inline-help-label')
    expect(trigger.closest('h1, h2')).toHaveTextContent(title)
    fireEvent.click(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${title} help`)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.getByText(`${title} description`)).toBeInTheDocument()
  }
})
