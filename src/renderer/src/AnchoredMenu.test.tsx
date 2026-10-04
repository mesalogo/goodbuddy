import { useRef, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AnchoredMenu } from './AnchoredMenu'

afterEach(cleanup)

it('focuses the selected radio item, navigates enabled items and restores the anchor on Escape', () => {
  function Menu() {
    const anchorRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    return <>
      <button ref={anchorRef} onClick={() => setOpen(true)}>View</button>
      {open && <AnchoredMenu anchorRef={anchorRef} id="views" label="View" onClose={() => setOpen(false)}>
        <button role="menuitemradio" aria-checked={false}>Oblique</button>
        <button role="menuitemradio" aria-checked={false} disabled>Side</button>
        <button role="menuitemradio" aria-checked={true}>Top</button>
        <button role="menuitem">Reset</button>
      </AnchoredMenu>}
    </>
  }
  render(<Menu />)
  fireEvent.click(screen.getByRole('button', { name: 'View' }))
  expect(screen.getByRole('menuitemradio', { name: 'Top' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(screen.getByRole('menuitemradio', { name: 'Oblique' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'End' })
  expect(screen.getByRole('menuitem', { name: 'Reset' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Home' })
  expect(screen.getByRole('menuitemradio', { name: 'Oblique' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'View' })).toHaveFocus()
})
