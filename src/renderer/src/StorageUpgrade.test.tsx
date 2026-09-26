import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { StorageUpgrade } from './StorageUpgrade'
import type { DesktopApi } from '../../shared/contracts'
import { UiLocaleProvider } from './i18n/UiLocaleProvider'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each(['zh-CN', 'en-US'] as const)('describes schema-only upgrades without claiming history conversion or reclamation (%s)', async (locale) => {
  vi.stubGlobal('goodbuddy', { storageUpgrade: {
    getProgress: vi.fn(async () => ({
      stage: 'upgrading', processed: 0, total: 0, bytesBefore: 100_000
    })),
    act: vi.fn(async () => undefined)
  } } as unknown as DesktopApi)
  render(<UiLocaleProvider initialPreference={locale}><StorageUpgrade /></UiLocaleProvider>)
  expect(await screen.findByRole('status')).toHaveTextContent(locale === 'zh-CN'
    ? '正在更新数据库结构' : 'Applying database structure updates')
  expect(screen.getByRole('heading')).toHaveTextContent(locale === 'zh-CN'
    ? '正在升级本地数据结构' : 'Upgrading local data structures')
  expect(screen.queryByText(/清理子任务进度的重复副本|removes repeated copies of subagent progress/)).not.toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
})

it.each(['zh-CN', 'en-US'] as const)('only describes space reclamation when it is actually running (%s)', async (locale) => {
  vi.stubGlobal('goodbuddy', { storageUpgrade: {
    getProgress: vi.fn(async () => ({
      stage: 'compacting', processed: 0, total: 0, bytesBefore: 100_000
    })),
    act: vi.fn(async () => undefined)
  } } as unknown as DesktopApi)
  render(<UiLocaleProvider initialPreference={locale}><StorageUpgrade /></UiLocaleProvider>)
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(locale === 'zh-CN'
    ? '正在回收磁盘空间' : 'Reclaiming disk space'))
  expect(screen.getByRole('heading')).toHaveTextContent(locale === 'zh-CN'
    ? '正在回收数据库空间' : 'Reclaiming database space')
})

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
