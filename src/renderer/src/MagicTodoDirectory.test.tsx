import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MagicTodoDirectory } from './MagicTodoDirectory'

afterEach(cleanup)

it('independently collapses groups with unique, stable controlled regions', () => {
  render(<>
    <MagicTodoDirectory noteId="first" title="First note" count={1}>
      <button>First task</button>
    </MagicTodoDirectory>
    <MagicTodoDirectory noteId="second" title="Second note" count={1}>
      <button>Second task</button>
    </MagicTodoDirectory>
  </>)
  const first = screen.getByRole('button', { name: 'First note (1)' })
  const second = screen.getByRole('button', { name: 'Second note (1)' })
  const itemsId = first.getAttribute('aria-controls')!
  const items = document.getElementById(itemsId)
  expect(itemsId).not.toBe(second.getAttribute('aria-controls'))
  expect(items).toContainElement(screen.getByRole('button', { name: 'First task' }))
  expect(first).toHaveAttribute('aria-expanded', 'true')

  first.focus()
  fireEvent.click(first)
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(first).toHaveFocus()
  expect(items).not.toBeVisible()
  expect(screen.queryByRole('button', { name: 'First task' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Second task' })).toBeVisible()
  expect(second).toHaveAttribute('aria-expanded', 'true')

  fireEvent.click(first)
  expect(first).toHaveAttribute('aria-expanded', 'true')
  expect(first).toHaveAttribute('aria-controls', itemsId)
  expect(screen.getByRole('button', { name: 'First task' })).toBeVisible()
})
