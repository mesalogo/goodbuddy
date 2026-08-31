import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TerminalEvent,
  TerminalSnapshot
} from '../../shared/terminal-contracts'
import {
  TerminalPanel,
  resolveTerminalFontFamily,
  type TerminalAdapter,
  type TerminalEmulator,
  type TerminalFactory
} from './TerminalPanel'

vi.mock('@xterm/xterm', () => ({ Terminal: class MockTerminal {} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class MockFitAddon {} }))
vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class MockSearchAddon {}
}))

const sessionId = '00000000-0000-4000-8000-000000000201'

function snapshot(
  overrides: Partial<TerminalSnapshot> = {}
): TerminalSnapshot {
  return {
    sessionId,
    target: { type: 'local' },
    targetLabel: '本机',
    title: '终端 · 本机 1',
    state: 'running',
    shell: 'PowerShell 7',
    workingDirectory: 'D:\\workspace',
    size: { cols: 80, rows: 24 },
    lastSequence: 0,
    exit: null,
    error: null,
    ...overrides
  }
}

type EmulatorHarness = {
  factory: TerminalFactory
  terminal: TerminalEmulator
  emitInput: (data: string) => void
  write: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  fit: ReturnType<typeof vi.fn>
}

function emulatorHarness(): EmulatorHarness {
  let inputListener: ((data: string) => void) | undefined
  const write = vi.fn((_: string, callback?: () => void) => callback?.())
  const dispose = vi.fn()
  const fit = vi.fn()
  const terminal: TerminalEmulator = {
    cols: 80,
    rows: 24,
    open: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      inputListener = listener
      return { dispose: vi.fn() }
    }),
    write,
    clear: vi.fn(),
    selectAll: vi.fn(),
    getSelection: vi.fn(() => 'selected output'),
    focus: vi.fn(),
    dispose
  }
  return {
    terminal,
    write,
    dispose,
    fit,
    emitInput: (data) => inputListener?.(data),
    factory: () => ({
      terminal,
      fitAddon: { fit },
      searchAddon: { findNext: vi.fn(() => true) }
    })
  }
}

type AdapterHarness = {
  adapter: TerminalAdapter
  emit: (event: TerminalEvent) => void
}

function adapterHarness(
  createResult: TerminalSnapshot = snapshot()
): AdapterHarness {
  let eventListener: ((event: TerminalEvent) => void) | undefined
  const adapter: TerminalAdapter = {
    create: vi.fn(async () => createResult),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    close: vi.fn(async () =>
      snapshot({ state: 'exited', exit: { exitCode: 0, signal: null } })
    ),
    getSnapshot: vi.fn(async () => createResult),
    ack: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => {
      eventListener = listener
      return vi.fn()
    })
  }
  return {
    adapter,
    emit: (event) => eventListener?.(event)
  }
}

type ResizeObserverHarness = {
  trigger: (width?: number, height?: number) => void
  disconnect: ReturnType<typeof vi.fn>
}

let resizeObserver: ResizeObserverHarness

beforeEach(() => {
  const disconnect = vi.fn()
  class MockResizeObserver {
    private readonly callback: ResizeObserverCallback

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      resizeObserver = {
        disconnect,
        trigger: (width = 800, height = 480) =>
          this.callback(
            [
              {
                contentRect: {
                  width,
                  height
                } as DOMRectReadOnly
              } as ResizeObserverEntry
            ],
            this as unknown as ResizeObserver
          )
      }
    }

    observe(): void {}
    unobserve(): void {}
    disconnect = disconnect
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver)
})

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--font-family-mono')
  vi.unstubAllGlobals()
})

describe('TerminalPanel', () => {
  it('creates only after the first valid fitted size and forwards input', async () => {
    const backend = adapterHarness()
    const emulator = emulatorHarness()
    render(
      <TerminalPanel
        adapter={backend.adapter}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )

    resizeObserver.trigger(0, 0)
    expect(backend.adapter.create).not.toHaveBeenCalled()
    resizeObserver.trigger()

    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledWith({
        target: { type: 'local' },
        cols: 80,
        rows: 24
      })
    )
    expect(screen.getByText('PowerShell 7')).toBeInTheDocument()

    emulator.emitInput('Get-Location\r')
    await waitFor(() =>
      expect(backend.adapter.write).toHaveBeenCalledWith({
        sessionId,
        data: 'Get-Location\r'
      })
    )
  })

  it('deduplicates resize, consumes ordered events, and ACKs output', async () => {
    const backend = adapterHarness()
    const emulator = emulatorHarness()
    render(
      <TerminalPanel
        adapter={backend.adapter}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    resizeObserver.trigger()
    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledOnce()
    )

    resizeObserver.trigger(700, 400)
    resizeObserver.trigger(600, 300)
    expect(backend.adapter.resize).not.toHaveBeenCalled()

    backend.emit({
      sessionId,
      sequence: 1,
      type: 'output',
      data: 'hello'
    })
    backend.emit({
      sessionId,
      sequence: 1,
      type: 'output',
      data: 'duplicate'
    })
    await waitFor(() =>
      expect(emulator.write).toHaveBeenCalledWith(
        'hello',
        expect.any(Function)
      )
    )
    expect(emulator.write).not.toHaveBeenCalledWith(
      'duplicate',
      expect.anything()
    )
    Object.defineProperty(emulator.terminal, 'cols', { value: 100 })
    Object.defineProperty(emulator.terminal, 'rows', { value: 30 })
    resizeObserver.trigger()
    resizeObserver.trigger()
    await waitFor(() =>
      expect(backend.adapter.resize).toHaveBeenCalledOnce()
    )
    expect(backend.adapter.resize).toHaveBeenCalledWith({
      sessionId,
      cols: 100,
      rows: 30
    })

    backend.emit({
      sessionId,
      sequence: 2,
      type: 'state',
      state: 'interrupted'
    })
    await waitFor(() =>
      expect(backend.adapter.ack).toHaveBeenLastCalledWith({
        sessionId,
        sequence: 2
      })
    )
    expect(screen.getAllByText('连接已中断')).not.toHaveLength(0)
  })

  it('unsubscribes and destroys the emulator without closing the session', async () => {
    const backend = adapterHarness()
    const emulator = emulatorHarness()
    const unsubscribe = vi.fn()
    vi.mocked(backend.adapter.subscribe).mockImplementation((listener) => {
      void listener
      return unsubscribe
    })
    const view = render(
      <TerminalPanel
        adapter={backend.adapter}
        sessionId={sessionId}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    await waitFor(() =>
      expect(backend.adapter.getSnapshot).toHaveBeenCalledWith({
        sessionId
      })
    )

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(emulator.dispose).toHaveBeenCalledOnce()
    expect(resizeObserver.disconnect).toHaveBeenCalledOnce()
    expect(backend.adapter.close).not.toHaveBeenCalled()
  })

  it('leaves session closing to the workbar tab action', async () => {
    const backend = adapterHarness()
    const emulator = emulatorHarness()
    render(
      <TerminalPanel
        adapter={backend.adapter}
        sessionId={sessionId}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    await screen.findByText('PowerShell 7')

    expect(
      screen.queryByRole('button', { name: '关闭终端会话' })
    ).not.toBeInTheDocument()
    expect(backend.adapter.close).not.toHaveBeenCalled()
  })

  it('renders and ACKs startup events included in the create snapshot sequence', async () => {
    const backend = adapterHarness(snapshot({ lastSequence: 2 }))
    const emulator = emulatorHarness()
    render(
      <TerminalPanel
        adapter={backend.adapter}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    resizeObserver.trigger()
    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledOnce()
    )

    backend.emit({
      sessionId,
      sequence: 1,
      type: 'output',
      data: 'startup prompt'
    })
    backend.emit({
      sessionId,
      sequence: 2,
      type: 'state',
      state: 'running'
    })

    await waitFor(() =>
      expect(emulator.write).toHaveBeenCalledWith(
        'startup prompt',
        expect.any(Function)
      )
    )
    expect(backend.adapter.ack).toHaveBeenLastCalledWith({
      sessionId,
      sequence: 2
    })
  })

  it('keeps one emulator when callback identities change', async () => {
    const backend = adapterHarness()
    const emulator = emulatorHarness()
    const factory = vi.fn(emulator.factory)
    const firstCallback = vi.fn()
    const view = render(
      <TerminalPanel
        adapter={backend.adapter}
        onSessionChange={firstCallback}
        target={{ type: 'local' }}
        terminalFactory={factory}
      />
    )
    resizeObserver.trigger()
    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledOnce()
    )

    const latestCallback = vi.fn()
    view.rerender(
      <TerminalPanel
        adapter={backend.adapter}
        onSessionChange={latestCallback}
        target={{ type: 'local' }}
        terminalFactory={factory}
      />
    )
    backend.emit({
      sessionId,
      sequence: 1,
      type: 'state',
      state: 'interrupted'
    })

    await waitFor(() =>
      expect(latestCallback).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'interrupted' })
      )
    )
    expect(factory).toHaveBeenCalledOnce()
    expect(emulator.dispose).not.toHaveBeenCalled()
  })

  it('closes a session whose create result arrives after unmount', async () => {
    let resolveCreate:
      | ((value: TerminalSnapshot) => void)
      | undefined
    const backend = adapterHarness()
    vi.mocked(backend.adapter.create).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve
        })
    )
    const emulator = emulatorHarness()
    const view = render(
      <TerminalPanel
        adapter={backend.adapter}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    resizeObserver.trigger()
    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledOnce()
    )

    view.unmount()
    resolveCreate?.(snapshot())
    await waitFor(() =>
      expect(backend.adapter.close).toHaveBeenCalledWith({ sessionId })
    )
  })

  it('uses the resolved cross-platform monospace font stack', () => {
    document.documentElement.style.setProperty(
      '--font-family-mono',
      '"Test Mono", monospace'
    )
    expect(resolveTerminalFontFamily()).toBe(
      '"Test Mono", monospace'
    )
  })

  it('keeps creation failures visible and allows retrying', async () => {
    const backend = adapterHarness()
    vi.mocked(backend.adapter.create)
      .mockRejectedValueOnce(new Error('Shell 启动失败'))
      .mockResolvedValueOnce(snapshot())
    const emulator = emulatorHarness()
    render(
      <TerminalPanel
        adapter={backend.adapter}
        target={{ type: 'local' }}
        terminalFactory={emulator.factory}
      />
    )
    resizeObserver.trigger()

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Shell 启动失败'
    )
    expect(screen.getAllByText('连接失败')).not.toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() =>
      expect(backend.adapter.create).toHaveBeenCalledTimes(2)
    )
    expect(await screen.findAllByText('已连接')).not.toHaveLength(0)
  })
})
