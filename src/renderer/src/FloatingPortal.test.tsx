import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { FloatingPortal } from './FloatingPortal'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

afterEach(cleanup)

function Modal({ label, onClose }: { label: string; onClose: () => void }): React.JSX.Element {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => activateModalFocus(() => close.current), [])
  return createPortal(<section role="dialog" aria-modal="true" aria-label={label}
    onKeyDown={event => trapTabFocus(event, event.currentTarget)}>
    <button ref={close} onClick={onClose}>Close {label}</button>
  </section>, document.body)
}

it('moves one live notification host into successive modals without remounting its content', async () => {
  let mounts = 0
  function Notice(): React.JSX.Element {
    useEffect(() => { mounts++ }, [])
    return <div role="status">Saved<button>Dismiss</button></div>
  }
  function Fixture(): React.JSX.Element {
    const [modal, setModal] = useState(false)
    return <div className="app-shell"><button onClick={() => setModal(true)}>Open</button>
      <FloatingPortal><Notice /></FloatingPortal>
      {modal && <Modal label="Settings" onClose={() => setModal(false)} />}
    </div>
  }
  render(<Fixture />)
  const host = screen.getByRole('status').parentElement!
  expect(host.parentElement).toBe(document.body)
  fireEvent.click(screen.getByText('Open'))
  await waitFor(() => expect(host.parentElement).toBe(screen.getByRole('dialog')))
  expect(host).not.toHaveAttribute('inert')
  expect(document.querySelector<HTMLElement>('.app-shell')!.inert).toBe(true)
  expect(mounts).toBe(1)
  screen.getByText('Dismiss').focus()
  fireEvent.keyDown(screen.getByText('Dismiss'), { key: 'Tab' })
  expect(screen.getByText('Close Settings')).toHaveFocus()
  fireEvent.click(screen.getByText('Close Settings'))
  await waitFor(() => expect(host.parentElement).toBe(document.body))
  expect(mounts).toBe(1)
  expect(document.querySelector<HTMLElement>('.app-shell')!.inert).toBe(false)
})

it('keeps an anchored floating menu inside its owning modal', async () => {
  function Fixture(): React.JSX.Element {
    const anchor = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    return <section role="dialog" aria-modal="true" aria-label="Settings">
      <button ref={anchor} onClick={() => setOpen(true)}>Test</button>
      {open && <FloatingPortal anchorRef={anchor}><div role="menu">Scenarios</div></FloatingPortal>}
    </section>
  }
  render(<Fixture />)
  fireEvent.click(screen.getByText('Test'))
  await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(screen.getByRole('menu')))
  expect(screen.getByRole('menu').parentElement).toHaveProperty('popover', 'manual')
})
