import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LocalInferencePage from './LocalInferencePage'
import type { LocalInferenceSnapshot } from '../../shared/local-inference-contracts'
import * as ocrBridge from './document-ocr-bridge'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const styles = readFileSync(join(process.cwd(), 'src/renderer/src/local-inference.css'), 'utf8')

const snapshot: LocalInferenceSnapshot = {
  services: [{ id: 'embedding', name: '向量生成', engine: 'Granite', ownership: 'managed-process', state: 'running', detail: '共享执行服务', actions: ['stop', 'restart'] }],
  tasks: [{ id: 'real-task', serviceId: 'embedding', source: '知识索引', state: 'running', startedAt: 1 }]
}
const api = { getSnapshot: vi.fn(), act: vi.fn(), cancel: vi.fn(), openSettings: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  api.getSnapshot.mockResolvedValue(snapshot)
  api.act.mockResolvedValue(undefined)
  api.cancel.mockResolvedValue(undefined)
  api.openSettings.mockResolvedValue(undefined)
  vi.stubGlobal('goodbuddy', { localInference: api })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('LocalInferencePage', () => {
  it('shows services directly with truthful resource availability and no task history or external endpoints', async () => {
    const name = 'A very long inference source and model service name '.repeat(8).trim()
    api.getSnapshot.mockResolvedValue({
      ...snapshot,
      tasks: [...snapshot.tasks, { ...snapshot.tasks[0], id: 'finished', source: '历史任务', state: 'completed', finishedAt: 2 }],
      services: [{ ...snapshot.services[0], name }],
      externalConnections: [{ id: 'external', name: '外部连接', model: 'remote' }],
    })
    render(<LocalInferencePage onClose={vi.fn()} />)
    const serviceHeading = await screen.findByRole('heading', { name })
    expect(serviceHeading).not.toHaveTextContent('运行中')
    expect(within(serviceHeading.parentElement!).getByText('运行中')).toBeInTheDocument()
    expect(screen.getByText('CPU / 内存：暂不可用')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText('知识索引')).not.toBeInTheDocument()
    expect(screen.queryByText('历史任务')).not.toBeInTheDocument()
    expect(screen.queryByText('外部连接')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '停止服务' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '重启服务' })).toBeEnabled()
  })

  it('keeps the service toolbar responsive', async () => {
    render(<LocalInferencePage onClose={vi.fn()} />)
    await screen.findByRole('heading', { name: '向量生成' })
    const toolbar = screen.getByText('每 5 秒刷新 · CPU 100% = 一个逻辑核心').parentElement!
    expect(toolbar).toHaveClass('local-inference-toolbar')
    expect(within(toolbar).getByRole('button', { name: '刷新状态' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '应用设置' })).not.toBeInTheDocument()
    fireEvent.click(within(toolbar).getByRole('button', { name: '模型与连接设置' }))
    expect(api.openSettings).toHaveBeenCalledOnce()
    expect(styles).toMatch(/\.local-inference-toolbar\s*\{[^}]*flex: 0 0 auto/)
    expect(screen.getByRole('region', { name: '本机推理服务' })).toBeInTheDocument()
  })

  it('does not present an active ASR request as a running service', async () => {
    api.getSnapshot.mockResolvedValue({
      services: [{ ...snapshot.services[0], id: 'asr', name: '语音识别', state: 'unknown', actions: [] }],
      tasks: [{ ...snapshot.tasks[0], serviceId: 'asr' }]
    })
    render(<LocalInferencePage onClose={vi.fn()} />)
    expect(await screen.findByText('按需运行（状态未知）')).toBeInTheDocument()
    expect(screen.queryByText('运行中')).not.toBeInTheDocument()
  })

  it('shows process scope, measured units and shared-worker unavailability per service', async () => {
    api.getSnapshot.mockResolvedValue({ ...snapshot, services: [
      { ...snapshot.services[0], resources: { scope: 'service-process', pid: 42, sampledAt: 1, cpuPercent: 150, workingSetBytes: 2097152 } },
      { ...snapshot.services[0], id: 'asr', name: '语音识别', resources: { scope: 'unavailable', reason: '识别线程与主进程共享资源，无法独立统计 CPU / 内存' } }
    ] })
    render(<LocalInferencePage onClose={vi.fn()} />)
    expect(await screen.findByText('服务进程 PID 42 · CPU 150.0% · 工作集 2.0 MiB')).toBeInTheDocument()
    expect(screen.getByText('CPU / 内存：识别线程与主进程共享资源，无法独立统计 CPU / 内存')).toBeInTheDocument()
    api.getSnapshot.mockResolvedValue({ ...snapshot, services: [{ ...snapshot.services[0], resources: { scope: 'service-process', pid: 43, sampledAt: 2, cpuUnavailableReason: '正在建立采样基线', workingSetBytes: 1048576 } }] })
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByText('服务进程 PID 43 · CPU 正在建立采样基线 · 工作集 1.0 MiB')).toBeInTheDocument()
    expect(screen.queryByText(/PID 42/)).not.toBeInTheDocument()
  })

  it('blocks service actions on stale data until refresh succeeds', async () => {
    render(<LocalInferencePage onClose={vi.fn()} />)
    await screen.findByRole('heading', { name: '向量生成' })
    api.getSnapshot.mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('上次成功读取')
    expect(screen.getByRole('button', { name: '停止服务' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '停止服务' })).toBeEnabled())
    expect(api.act).not.toHaveBeenCalled()
  })

  it('only shows affected active tasks when confirming service stop', async () => {
    render(<LocalInferencePage onClose={vi.fn()} />)
    await screen.findByRole('heading', { name: '向量生成' })
    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    const dialog = screen.getByRole('dialog', { name: '停止服务：向量生成' })
    expect(within(dialog).getByText(/知识索引/)).toBeInTheDocument()
    expect(api.act).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: '确认停止服务' }))
    await waitFor(() => expect(api.act).toHaveBeenCalledWith({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: ['real-task'] }))
  })

  it('recovers from initial load failure and does not stop anything on unmount', async () => {
    api.getSnapshot.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ services: [], tasks: [] })
    const page = render(<LocalInferencePage onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('暂无本机推理服务')).toBeInTheDocument()
    page.unmount()
    expect(api.act).not.toHaveBeenCalled()
    expect(api.cancel).not.toHaveBeenCalled()
  })

  it('refreshes after a rejected confirmation and requires confirmation of the new affected tasks', async () => {
    api.act.mockRejectedValueOnce(new Error('任务已变化'))
    render(<LocalInferencePage onClose={vi.fn()} />)
    await screen.findByRole('heading', { name: '向量生成' })
    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    api.getSnapshot.mockResolvedValue({ ...snapshot, tasks: [...snapshot.tasks, { ...snapshot.tasks[0], id: 'new-task', source: '新索引' }] })
    fireEvent.click(screen.getByRole('button', { name: '确认停止服务' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('任务已变化')
    expect(screen.queryByRole('dialog', { name: '停止服务：向量生成' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: '停止服务' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    expect(screen.getByText(/新索引/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认停止服务' }))
    await waitFor(() => expect(api.act).toHaveBeenLastCalledWith({ serviceId: 'embedding', action: 'stop', confirmedTaskIds: ['real-task', 'new-task'] }))
  })

  it('isolates nested Escape, traps focus, and restores the service action', async () => {
    const onClose = vi.fn()
    render(<LocalInferencePage onClose={onClose} />)
    expect(screen.getByRole('button', { name: '关闭本机推理监控' })).toHaveFocus()
    await screen.findByRole('heading', { name: '向量生成' })
    fireEvent.keyDown(screen.getByRole('button', { name: '关闭本机推理监控' }), { key: 'Tab', shiftKey: true })
    expect(screen.getByRole('button', { name: '重启服务' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('button', { name: '重启服务' }), { key: 'Tab' })
    expect(screen.getByRole('button', { name: '关闭本机推理监控' })).toHaveFocus()
    const stop = screen.getByRole('button', { name: '停止服务' })
    stop.focus()
    fireEvent.click(stop)
    const cancel = screen.getByRole('button', { name: '保留运行状态' })
    const confirm = screen.getByRole('button', { name: '确认停止服务' })
    expect(cancel).toHaveFocus()
    expect(confirm).toHaveClass('danger-button')
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(confirm).toHaveFocus()
    fireEvent.keyDown(confirm, { key: 'Tab' })
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(stop).toHaveFocus()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    fireEvent.keyDown(stop, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('blocks dismissal and duplicate execution while a service operation is pending', async () => {
    let resolve!: () => void
    api.act.mockReturnValue(new Promise<void>((done) => { resolve = done }))
    const onClose = vi.fn()
    render(<LocalInferencePage onClose={onClose} />)
    await screen.findByRole('heading', { name: '向量生成' })
    fireEvent.click(screen.getByRole('button', { name: '停止服务' }))
    const confirm = screen.getByRole('button', { name: '确认停止服务' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.keyDown(confirm, { key: 'Escape' })
    expect(screen.getByRole('button', { name: '保留运行状态' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭本机推理监控' })).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(api.act).toHaveBeenCalledOnce()
    resolve()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '停止服务：向量生成' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '关闭本机推理监控' })).not.toBeDisabled()
  })

  it('restores fallback focus when the entry was removed and clears background isolation', () => {
    const background = document.createElement('div')
    background.className = 'app-shell'
    const entry = document.createElement('button')
    const fallback = document.createElement('button')
    background.append(entry, fallback)
    document.body.append(background)
    entry.focus()
    const modal = render(<LocalInferencePage onClose={vi.fn()} restoreFocus={() => fallback} />)
    expect(background.inert).toBe(true)
    entry.remove()
    modal.unmount()
    expect(background.inert).toBe(false)
    expect(fallback).toHaveFocus()
    background.remove()
  })

  it('confirms OCR release with a specific danger action and leaves the management modal open', async () => {
    vi.spyOn(ocrBridge, 'getOcrInferenceState').mockReturnValue({ state: 'running', loaded: true, busy: false })
    const release = vi.spyOn(ocrBridge, 'releaseOcrInference').mockImplementation(() => undefined)
    api.getSnapshot.mockResolvedValue({ services: [{ id: 'ocr', name: '文字识别', engine: 'Paddle', ownership: 'renderer-worker', state: 'running', detail: '', actions: [] }], tasks: [] })
    const onClose = vi.fn()
    render(<LocalInferencePage onClose={onClose} />)
    await screen.findByRole('heading', { name: '文字识别' })
    fireEvent.click(screen.getByRole('button', { name: '释放模型' }))
    const confirmation = screen.getByRole('dialog', { name: '释放模型：文字识别' })
    expect(confirmation).toHaveClass('local-inference-confirm')
    expect(within(confirmation).getByText('当前没有已登记的活动任务。执行前将再次核对。')).toBeInTheDocument()
    const confirm = within(confirmation).getByRole('button', { name: '确认释放模型' })
    expect(confirm).toHaveClass('danger-button')
    expect(release).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    await waitFor(() => expect(confirmation).not.toBeInTheDocument())
    expect(release).toHaveBeenCalledOnce()
    expect(api.act).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '本机推理监控' })).toBeInTheDocument()
  })

  it('keeps keyboard focus in the modal when the application content is disabled', () => {
    render(<LocalInferencePage onClose={vi.fn()} enabled={false} />)
    const close = screen.getByRole('button', { name: '关闭本机推理监控' })
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(close).toHaveFocus()
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(close).toHaveFocus()
    expect(api.getSnapshot).not.toHaveBeenCalled()
  })
})
