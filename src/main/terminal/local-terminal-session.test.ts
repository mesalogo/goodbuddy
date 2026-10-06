import type { IDisposable, IPty } from 'node-pty'
import { describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_LIMITS,
  type TerminalEvent
} from '../../shared/terminal-contracts'
import {
  LocalTerminalSession,
  buildLocalTerminalEnvironment,
  resolveLocalTerminalLaunch,
  resolveLocalTerminalShell
} from './local-terminal-session'

class FakePty implements IPty {
  readonly pid = 4321
  readonly cols = 80
  readonly rows = 24
  readonly process = 'fake-shell'
  handleFlowControl = false
  readonly write = vi.fn()
  readonly resize = vi.fn()
  readonly clear = vi.fn()
  readonly kill = vi.fn()
  readonly pause = vi.fn()
  readonly resume = vi.fn()
  private dataListeners = new Set<(data: string) => void>()
  private exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >()

  readonly onData = (
    listener: (data: string) => void
  ): IDisposable => {
    this.dataListeners.add(listener)
    return {
      dispose: () => this.dataListeners.delete(listener)
    }
  }

  readonly onExit = (
    listener: (event: {
      exitCode: number
      signal?: number
    }) => void
  ): IDisposable => {
    this.exitListeners.add(listener)
    return {
      dispose: () => this.exitListeners.delete(listener)
    }
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data)
    }
  }

  emitExit(exitCode: number, signal?: number): void {
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode, signal })
    }
  }
}

const baseOptions = {
  sessionId: '5d8f47a2-c681-4c26-95a2-2ed1a086fc78',
  target: { type: 'local' } as const,
  targetLabel: '本机',
  title: '终端 · 本机 1',
  size: { cols: 80, rows: 24 }
}

function sessionDependencies(
  pty: FakePty,
  overrides: Record<string, unknown> = {}
) {
  return {
    platform: 'linux' as const,
    environment: {
      SHELL: '/bin/bash',
      PATH: '/bin',
      SAFE_VALUE: 'visible'
    },
    executableExists: async (path: string) => path === '/bin/bash',
    directoryExists: async () => true,
    homeDirectory: () => '/home/tester',
    spawn: vi.fn(() => pty),
    terminate: vi.fn(async () => {
      pty.emitExit(0)
    }),
    ...overrides
  }
}

describe('local terminal launch resolution', () => {
  it('awaits native child ownership registration and preserves an exit during registration', async () => {
    const pty = new FakePty()
    let release!: () => void
    const recorded = new Promise<void>(resolve => { release = resolve })
    const onSpawn = vi.fn(async (pid: number) => { expect(pid).toBe(pty.pid); await recorded })
    const pending = LocalTerminalSession.create({ ...baseOptions,
      spawnSpec: { executable: '/runtime', args: [], cwd: '/project', env: {}, label: 'Native', onSpawn },
      dependencies: sessionDependencies(pty) })
    await vi.waitFor(() => expect(onSpawn).toHaveBeenCalledOnce())
    pty.emitExit(0)
    release()
    expect((await pending).snapshot().state).toBe('exited')
  })

  it('spawns a Main-owned native executable directly without typing a shell command', async () => {
    const pty = new FakePty()
    const dependencies = sessionDependencies(pty)
    const spawnSpec = { executable: '/managed/node', args: ['/managed/cn.js', '--config', '/config with spaces.json'], cwd: '/project', env: { PATH: '/managed' }, label: 'Continue' }
    const session = await LocalTerminalSession.create({ ...baseOptions, spawnSpec, dependencies })
    expect(dependencies.spawn).toHaveBeenCalledWith(spawnSpec.executable, spawnSpec.args, expect.objectContaining({ cwd: '/project', env: spawnSpec.env }))
    expect(pty.write).not.toHaveBeenCalled()
    expect(session.snapshot()).toMatchObject({ state: 'running', shell: 'Continue', workingDirectory: '/project' })
    await session.close()
  })

  it('fails a native launch with an invalid project directory instead of falling back home', async () => {
    const dependencies = sessionDependencies(new FakePty(), { directoryExists: async (path: string) => path === '/home/tester' })
    const session = await LocalTerminalSession.create({ ...baseOptions, dependencies,
      spawnSpec: { executable: '/managed/opencode', args: [], cwd: '/missing', env: {}, label: 'OpenCode' } })
    expect(session.snapshot().state).toBe('failed')
    expect(dependencies.spawn).not.toHaveBeenCalled()
  })
  it('prefers pwsh, then PowerShell, then COMSPEC on Windows', async () => {
    const available = new Set(['C:\\bin\\powershell.EXE'])
    const shell = await resolveLocalTerminalShell({
      platform: 'win32',
      environment: {
        Path: 'C:\\bin',
        PATHEXT: '.EXE',
        COMSPEC: 'C:\\Windows\\cmd.exe'
      },
      executableExists: async (path) => available.has(path)
    })

    expect(shell).toEqual({
      shell: 'C:\\bin\\powershell.EXE',
      shellLabel: 'powershell.EXE'
    })
  })

  it('uses a valid POSIX SHELL and falls back to home for invalid cwd', async () => {
    const launch = await resolveLocalTerminalLaunch('/missing', {
      platform: 'linux',
      environment: {
        SHELL: '/usr/bin/fish',
        PATH: '/usr/bin',
        LANG: 'zh_CN.UTF-8',
        GOODBUDDY_MODEL_API_KEY: 'secret',
        ANTHROPIC_API_KEY: 'secret'
      },
      executableExists: async (path) => path === '/usr/bin/fish',
      directoryExists: async (path) => path === '/home/tester',
      homeDirectory: () => '/home/tester'
    })

    expect(launch.cwd).toBe('/home/tester')
    expect(launch.shell).toBe('/usr/bin/fish')
    expect(launch.env).toMatchObject({
      SHELL: '/usr/bin/fish',
      LANG: 'zh_CN.UTF-8'
    })
    expect(launch.env).not.toHaveProperty('GOODBUDDY_MODEL_API_KEY')
    expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('filters product and model credentials without dropping normal variables', () => {
    expect(
      buildLocalTerminalEnvironment({
        PATH: '/bin',
        CUSTOM_TOKEN: 'user-owned',
        FACTORY_API_KEY: 'internal',
        OPENAI_API_KEY: 'model'
      })
    ).toEqual({
      PATH: '/bin',
      CUSTOM_TOKEN: 'user-owned'
    })
  })
})

describe('LocalTerminalSession', () => {
  it('spawns the PTY and preserves ordered state, output, exit events', async () => {
    const pty = new FakePty()
    const dependencies = sessionDependencies(pty)
    const session = await LocalTerminalSession.create({
      ...baseOptions,
      dependencies
    })
    const events: TerminalEvent[] = []
    session.onEvent((event) => events.push(event))

    pty.emitData('你好')
    pty.emitExit(7, 15)

    expect(dependencies.spawn).toHaveBeenCalledWith(
      '/bin/bash',
      [],
      expect.objectContaining({
        cols: 80,
        rows: 24,
        cwd: '/home/tester',
        name: 'xterm-256color'
      })
    )
    expect(events.map((event) => event.type)).toEqual([
      'state',
      'state',
      'output',
      'exit',
      'state'
    ])
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5
    ])
    expect(session.snapshot()).toMatchObject({
      state: 'exited',
      exit: { exitCode: 7, signal: '15' },
      lastSequence: 5
    })
  })

  it('forwards writes and deduplicates resize while running', async () => {
    const pty = new FakePty()
    const session = await LocalTerminalSession.create({
      ...baseOptions,
      dependencies: sessionDependencies(pty)
    })

    expect(session.write('echo ok\r')).toBe(true)
    expect(session.resize({ cols: 80, rows: 24 })).toBe(true)
    expect(session.resize({ cols: 120, rows: 40 })).toBe(true)

    expect(pty.write).toHaveBeenCalledWith('echo ok\r')
    expect(pty.resize).toHaveBeenCalledTimes(1)
    expect(pty.resize).toHaveBeenCalledWith(120, 40)
    expect(session.snapshot().size).toEqual({
      cols: 120,
      rows: 40
    })
  })

  it('splits output events at the UTF-8 boundary', async () => {
    const pty = new FakePty()
    const session = await LocalTerminalSession.create({
      ...baseOptions,
      dependencies: sessionDependencies(pty)
    })
    const output: string[] = []
    session.onEvent((event) => {
      if (event.type === 'output') {
        output.push(event.data)
      }
    })
    const data =
      'a'.repeat(TERMINAL_LIMITS.maximumEventBytes - 1) + '你'

    pty.emitData(data)

    expect(output.join('')).toBe(data)
    expect(
      output.every(
        (chunk) =>
          Buffer.byteLength(chunk) <=
          TERMINAL_LIMITS.maximumEventBytes
      )
    ).toBe(true)
  })

  it('pauses at the pending-event boundary and resumes after ACK', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty)
      })
      let lastSequence = 0
      session.onEvent((event) => {
        lastSequence = event.sequence
      })

      for (
        let index = 0;
        index < TERMINAL_LIMITS.maximumPendingEvents;
        index += 1
      ) {
        pty.emitData('x')
        // Each flush window yields one event.
        vi.advanceTimersByTime(20)
        if (pty.pause.mock.calls.length > 0) {
          break
        }
      }

      expect(pty.pause).toHaveBeenCalledTimes(1)
      expect(session.snapshot().state).toBe('running')
      session.acknowledge(lastSequence)
      expect(pty.resume).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces bursts into few ordered output events', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty)
      })
      const events: TerminalEvent[] = []
      session.onEvent((event) => events.push(event))
      const expected: string[] = []
      for (let index = 0; index < 1_000; index += 1) {
        const chunk = `line ${index} 你好\r\n`
        expected.push(chunk)
        pty.emitData(chunk)
        if (index % 100 === 0) {
          vi.advanceTimersByTime(8)
        }
      }
      vi.advanceTimersByTime(20)

      const output = events.filter((event) => event.type === 'output')
      expect(output.map((event) => event.data).join('')).toBe(expected.join(''))
      expect(output.length).toBeLessThan(25)
      const sequences = events.map((event) => event.sequence)
      expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
      expect(new Set(sequences).size).toBe(sequences.length)
      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes buffered output before exit events and stops its timer', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty)
      })
      const events: TerminalEvent[] = []
      session.onEvent((event) => events.push(event))
      pty.emitData('first ')
      pty.emitData('trailing output')
      pty.emitData(' tail')
      pty.emitExit(0)

      expect(
        events.slice(2).map((event) =>
          event.type === 'output' ? event.data : event.type
        )
      ).toEqual(['first ', 'trailing output tail', 'exit', 'state'])
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(100)
      expect(events).toHaveLength(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes buffered output before the closing state on kill', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty, {
          terminate: vi.fn(async () => undefined)
        })
      })
      const events: TerminalEvent[] = []
      session.onEvent((event) => events.push(event))
      pty.emitData('a')
      pty.emitData('b')
      await session.close()

      expect(
        events.slice(2).map((event) =>
          event.type === 'output'
            ? event.data
            : event.type === 'state'
              ? event.state
              : event.type
        )
      ).toEqual(['a', 'b', 'closing', 'exit', 'exited'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts buffered and in-flight bytes for backpressure and keeps them bounded', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty)
      })
      const outputs: Extract<TerminalEvent, { type: 'output' }>[] = []
      session.onEvent((event) => {
        if (event.type === 'output') {
          outputs.push(event)
        }
      })
      const block = 'q'.repeat(16 * 1024)
      let produced = 0
      // A renderer that never ACKs: output must pause well before the hard
      // 4 MiB bound and never exceed it.
      while (pty.pause.mock.calls.length === 0) {
        pty.emitData(block)
        produced += block.length
        expect(produced).toBeLessThan(TERMINAL_LIMITS.maximumBufferedOutputBytes)
      }
      expect(session.snapshot().state).toBe('running')
      const emittedBytes = outputs.reduce((sum, event) => sum + event.data.length, 0)
      expect(produced - emittedBytes).toBeLessThan(TERMINAL_LIMITS.maximumEventBytes)
      expect(
        outputs.every(
          (event) => Buffer.byteLength(event.data) <= TERMINAL_LIMITS.maximumEventBytes
        )
      ).toBe(true)

      // In-flight data after pause is absorbed by the headroom.
      for (let index = 0; index < 16; index += 1) {
        pty.emitData(block)
        produced += block.length
      }
      vi.advanceTimersByTime(20)
      expect(session.snapshot().state).toBe('running')

      // A partial ACK that leaves more than half the budget pending must not
      // resume; ACKing the rest must.
      session.acknowledge(outputs[0]!.sequence)
      expect(pty.resume).not.toHaveBeenCalled()
      session.acknowledge(outputs.at(-1)!.sequence)
      expect(pty.resume).toHaveBeenCalledTimes(1)
      expect(
        outputs.map((event) => event.data).join('').length
      ).toBe(produced)
      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with output-limit-exceeded when the renderer never ACKs and the PTY ignores pause', async () => {
    vi.useFakeTimers()
    try {
      const pty = new FakePty()
      const session = await LocalTerminalSession.create({
        ...baseOptions,
        dependencies: sessionDependencies(pty, {
          terminate: vi.fn(async () => undefined)
        })
      })
      const block = 'q'.repeat(64 * 1024)
      for (
        let produced = 0;
        produced <= 2 * TERMINAL_LIMITS.maximumBufferedOutputBytes &&
        session.snapshot().state === 'running';
        produced += block.length
      ) {
        pty.emitData(block)
      }
      expect(session.snapshot()).toMatchObject({
        state: 'failed',
        error: { code: 'output-limit-exceeded' }
      })
      expect(vi.getTimerCount()).toBe(0)
      await session.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports launch failures with stable failed state', async () => {
    const session = await LocalTerminalSession.create({
      ...baseOptions,
      dependencies: {
        platform: 'linux',
        environment: { SHELL: '/missing' },
        executableExists: async () => false,
        directoryExists: async () => true,
        homeDirectory: () => '/home/tester'
      }
    })
    const events: TerminalEvent[] = []
    session.onEvent((event) => events.push(event))

    expect(session.snapshot()).toMatchObject({
      state: 'failed',
      error: { code: 'launch-failed', retryable: true }
    })
    expect(events.map((event) => event.type)).toEqual([
      'state',
      'error',
      'state'
    ])
    expect(session.write('ignored')).toBe(false)
  })

  it('closes once, rejects late operations, and keeps a stable exit', async () => {
    const pty = new FakePty()
    const dependencies = sessionDependencies(pty)
    const session = await LocalTerminalSession.create({
      ...baseOptions,
      dependencies
    })

    const firstClose = session.close()
    const secondClose = session.close()
    expect(secondClose).toBe(firstClose)
    await firstClose

    expect(dependencies.terminate).toHaveBeenCalledTimes(1)
    expect(session.write('late')).toBe(false)
    expect(session.resize({ cols: 90, rows: 30 })).toBe(false)
    expect(session.snapshot()).toMatchObject({
      state: 'exited',
      exit: { exitCode: 0, signal: null }
    })
    await session.close()
    expect(dependencies.terminate).toHaveBeenCalledTimes(1)
  })
})
