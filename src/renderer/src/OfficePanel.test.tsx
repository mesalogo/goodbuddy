import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { OfficeInteraction } from '../../shared/office-contracts'

beforeEach(() => { vi.resetModules() })

it('shows document-scoped confirmation, routes choices to the original tab, and preserves it across hiding', async () => {
  let notify!: (event: OfficeInteraction) => void
  const resolveClose = vi.fn().mockResolvedValue(undefined)
  window.goodbuddy = { office: {
    onInteraction: (listener: typeof notify) => { notify = listener; return vi.fn() },
    resolveClose, viewport: vi.fn().mockResolvedValue(undefined)
  } } as unknown as typeof window.goodbuddy
  const { OfficePanel } = await import('./OfficePanel')
  const view = render(<div><div hidden={false}><OfficePanel instanceId="first" /></div><OfficePanel instanceId="second" /></div>)
  act(() => notify({ instanceId: 'first', name: 'report.pptx', kind: 'confirm', closing: true, detail: '在线版本已保存，尚未同步到源文件。' }))
  expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'false')
  expect(screen.getByRole('dialog').closest('[data-office-instance]')).toHaveAttribute('data-office-instance', 'first')
  expect(screen.getByRole('button', { name: '继续编辑' })).toHaveFocus()
  view.rerender(<div><div hidden><OfficePanel instanceId="first" /></div><OfficePanel instanceId="second" /></div>)
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(<div><div hidden={false}><OfficePanel instanceId="first" /></div><OfficePanel instanceId="second" /></div>)
  fireEvent.click(screen.getByRole('button', { name: '另存为并关闭' }))
  await waitFor(() => expect(resolveClose).toHaveBeenCalledWith({ instanceId: 'first', choice: 'saveAs' }))
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(resolveClose).toHaveBeenCalledWith({ instanceId: 'first', choice: 'cancel' }))
  act(() => notify({ instanceId: 'first', name: 'report.pptx', kind: 'clear', closing: false }))
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('keeps save errors local and offers retry or save-as without requesting close', async () => {
  let notify!: (event: OfficeInteraction) => void
  const save = vi.fn().mockResolvedValue(null)
  window.goodbuddy = { office: {
    onInteraction: (listener: typeof notify) => { notify = listener; return vi.fn() },
    save, viewport: vi.fn().mockResolvedValue(undefined)
  } } as unknown as typeof window.goodbuddy
  const { OfficePanel } = await import('./OfficePanel')
  render(<OfficePanel instanceId="first" />)
  act(() => notify({ instanceId: 'first', name: 'report.xlsx', kind: 'error', closing: false, detail: '源文件已被其他程序修改' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('源文件已被其他程序修改')
  fireEvent.click(screen.getByRole('button', { name: '另存为' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith({ instanceId: 'first', saveAs: true }))
  await waitFor(() => expect(screen.getByRole('button', { name: '继续编辑' })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
