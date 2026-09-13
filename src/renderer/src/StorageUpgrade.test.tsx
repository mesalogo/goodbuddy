import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StorageUpgrade } from './StorageUpgrade'
import type { DesktopApi } from '../../shared/contracts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows real progress and lets the user quit without deleting records', async () => {
  const act = vi.fn(async () => undefined)
  vi.stubGlobal('goodbuddy', { storageUpgrade: {
    getProgress: vi.fn(async () => ({
      stage: 'converting', processed: 32, total: 100, bytesBefore: 90_000_000_000
    })),
    act
  } } as unknown as DesktopApi)
  render(<StorageUpgrade />)
  await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('value', '32'))
  expect(screen.getByText(/保留聊天、执行详情和结果/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '退出，稍后继续' }))
  await waitFor(() => expect(act).toHaveBeenCalledWith('quit'))
})

it('keeps a failed upgrade actionable through retry', async () => {
  const act = vi.fn(async () => undefined)
  vi.stubGlobal('goodbuddy', { storageUpgrade: {
    getProgress: vi.fn(async () => ({
      stage: 'failed', processed: 32, total: 100, bytesBefore: 90_000_000_000,
      error: '磁盘空间不足'
    })),
    act
  } } as unknown as DesktopApi)
  render(<StorageUpgrade />)
  expect(await screen.findByRole('alert')).toHaveTextContent('磁盘空间不足')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(act).toHaveBeenCalledWith('retry'))
})
