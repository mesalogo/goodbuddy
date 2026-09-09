import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalWorkspaceAccess } from '../workspace'
import {
  LocalDirectModelProcessService,
  buildDirectModelProcessEnvironment,
  type DirectModelProcessChild,
  type DirectModelProcessSpawn
} from './direct-model-process-service'

class FakeChild extends EventEmitter implements DirectModelProcessChild {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  pid = 4321
  killed = false
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly kill = vi.fn(() => {
    this.killed = true
    return true
  })

  close(code: number | null, signal?: NodeJS.Signals): void {
    this.exitCode = code
    this.signalCode = signal ?? null
    this.emit('close', code, signal ?? null)
  }
}

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    await import('node:fs/promises').then(({ rm }) =>
      rm(directory, { recursive: true, force: true })
    )
  }
})

async function workspace(): Promise<{
  root: string
  access: LocalWorkspaceAccess
}> {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-process-'))
  temporaryDirectories.push(root)
  return { root, access: new LocalWorkspaceAccess(root) }
}

function fakeService(
  child: FakeChild,
  options: {
    platform?: NodeJS.Platform
    environment?: NodeJS.ProcessEnv
    now?: () => number
    terminateProcessTree?: (
      child: DirectModelProcessChild,
      options?: Record<string, unknown>
    ) => Promise<void>
    executableExists?: (path: string) => Promise<boolean>
  } = {}
) {
  const spawnProcess = vi.fn<DirectModelProcessSpawn>(() => child)
  const service = new LocalDirectModelProcessService({
    platform: options.platform ?? 'linux',
    environment: options.environment ?? { PATH: '/usr/bin' },
    executableExists:
      options.executableExists ??
      (async (path) => path === '/bin/bash'),
    spawnProcess,
    terminateProcessTree:
      options.terminateProcessTree as never,
    now: options.now
  })
  return { service, spawnProcess }
}

describe('LocalDirectModelProcessService', () => {
  it('strictly validates command, cwd, timeout, and unknown fields', async () => {
    const { access } = await workspace()
    const child = new FakeChild()
    const { service, spawnProcess } = fakeService(child)
    const context = {
      conversationId: 'validation',
      workspace: access,
      signal: new AbortController().signal
    }

    await expect(
      service.execute({ command: '   ' }, context)
    ).rejects.toThrow()
    await expect(
      service.execute(
        { command: 'echo ok', timeoutMs: 999 },
        context
      )
    ).rejects.toThrow()
    await expect(
      service.execute(
        {
          command: 'echo ok',
          unexpected: true
        } as never,
        context
      )
    ).rejects.toThrow()
    await expect(
      service.execute(
        { command: 'echo ok', cwd: 'invalid\0directory' },
        context
      )
    ).rejects.toThrow('无效字符')
    expect(spawnProcess).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('selects PowerShell in order and uses the direct noninteractive launch contract', async () => {
    const { access } = await workspace()
    const child = new FakeChild()
    const available = new Set(['C:\\tools\\powershell.exe'])
    const { service, spawnProcess } = fakeService(child, {
      platform: 'win32',
      environment: {
        Path: 'C:\\tools',
        PATHEXT: '.EXE'
      },
      executableExists: async (path) => available.has(path)
    })

    expect(await service.getCapability()).toEqual({
      available: true,
      shell: {
        kind: 'powershell',
        label: 'Windows PowerShell'
      }
    })
    const execution = service.execute(
      { command: 'Write-Output ready' },
      {
        conversationId: 'powershell',
        workspace: access,
        signal: new AbortController().signal
      }
    )
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.close(0)

    await expect(execution).resolves.toMatchObject({
      shell: {
        kind: 'powershell',
        label: 'Windows PowerShell'
      },
      cwd: '.',
      exitCode: 0
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\tools\\powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Write-Output ready'
      ],
      expect.objectContaining({
        detached: false,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    )
    await service.dispose()
  })

  it('falls back from Bash to sh and reports unavailable shells', async () => {
    const sh = new LocalDirectModelProcessService({
      platform: 'linux',
      executableExists: async (path) => path === '/bin/sh'
    })
    const unavailable = new LocalDirectModelProcessService({
      platform: 'linux',
      executableExists: async () => false
    })

    await expect(sh.getCapability()).resolves.toEqual({
      available: true,
      shell: { kind: 'sh', label: 'sh' }
    })
    await expect(unavailable.getCapability()).resolves.toEqual({
      available: false,
      reason: expect.stringContaining('/bin/bash')
    })
    await sh.dispose()
    await unavailable.dispose()
  })

  it.each(['relative', 'absolute', 'outside', 'parent', 'symlink'])(
    'resolves an existing %s working directory without workspace containment',
    async (kind) => {
      const { root, access } = await workspace()
      const outside = await mkdtemp(join(tmpdir(), 'goodbuddy-outside-'))
      temporaryDirectories.push(outside)
      const nested = join(root, 'nested')
      await mkdir(nested)
      const link = join(root, 'outside-link')
      if (kind === 'symlink') {
        await symlink(
          outside,
          link,
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      const cwd =
        kind === 'relative'
          ? 'nested'
          : kind === 'absolute'
            ? nested
            : kind === 'outside'
              ? outside
              : kind === 'parent'
                ? relative(root, outside)
                : 'outside-link'
      const expectedPath = await realpath(
        kind === 'relative' || kind === 'absolute' ? nested : outside
      )
      const child = new FakeChild()
      const { service, spawnProcess } = fakeService(child)

      const execution = service.execute(
        { command: 'pwd', cwd },
        {
          conversationId: 'cwd',
          workspace: access,
          signal: new AbortController().signal
        }
      )
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
      expect(spawnProcess.mock.calls[0]?.[2].cwd).toBe(expectedPath)
      child.close(0)
      await expect(execution).resolves.toMatchObject({
        cwd:
          kind === 'relative' || kind === 'absolute'
            ? 'nested'
            : expectedPath
      })
      await service.dispose()
    }
  )

  it('rejects missing working directories and files before starting a process', async () => {
    const { root, access } = await workspace()
    const file = join(root, 'file.txt')
    await writeFile(file, 'not a directory')
    const { service, spawnProcess } = fakeService(new FakeChild())
    const context = {
      conversationId: 'invalid-cwd',
      workspace: access,
      signal: new AbortController().signal
    }
    await expect(
      service.execute(
        { command: 'pwd', cwd: join(root, 'missing') },
        context
      )
    ).rejects.toThrow()
    await expect(
      service.execute(
        { command: 'pwd', cwd: file },
        context
      )
    ).rejects.toThrow('不是目录')
    expect(spawnProcess).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('returns nonzero exits with bounded previews and retains full output for paging', async () => {
    const { access } = await workspace()
    const child = new FakeChild()
    let now = 1_000
    const { service, spawnProcess } = fakeService(child, {
      now: () => now
    })
    const execution = service.execute(
      { command: 'large output' },
      {
        conversationId: 'output',
        workspace: access,
        signal: new AbortController().signal
      }
    )
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    child.stdout.emit(
      'data',
      Buffer.concat([
        Buffer.alloc(48 * 1024, 'A'),
        Buffer.alloc(10, 'M'),
        Buffer.alloc(48 * 1024, 'Z')
      ])
    )
    child.stderr.emit('data', 'ordinary error output')
    now = 1_125
    child.close(7)

    const result = await execution
    expect(result.exitCode).toBe(7)
    expect(result.durationMs).toBe(125)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stdout).toBe(
      'A'.repeat(48 * 1024) + 'M'.repeat(10) + 'Z'.repeat(48 * 1024 - 10)
    )
    expect(result.stderr).toBe('ordinary error output')
    expect(result.stderrTruncated).toBe(false)
    expect(result.stderrReference).toBeUndefined()
    const reference = result.stdoutReference!
    expect(reference.totalBytes).toBe(96 * 1024 + 10)
    await expect(service.readOutput('output', reference.handle, reference.nextCursor)).resolves.toMatchObject({
      content: 'Z'.repeat(10), eof: true, nextCursor: reference.totalBytes
    })
    await expect(service.readOutput('other', reference.handle)).rejects.toThrow()
    await service.releaseConversation('output')
    await expect(service.readOutput('output', reference.handle)).rejects.toThrow()
    await service.dispose()
  })

  it('filters application and provider credentials while preserving ordinary variables and prepending tool PATH', () => {
    expect(
      buildDirectModelProcessEnvironment(
        {
          PATH: '/usr/bin',
          HOME: '/home/person',
          CUSTOM_TOKEN: 'ordinary-user-value',
          GOODBUDDY_MODEL_API_KEY: 'product-secret',
          FACTORY_API_KEY: 'factory-secret',
          ANTHROPIC_API_KEY: 'provider-secret',
          DEEPSEEK_API_KEY: 'provider-secret'
        },
        '/managed/bin',
        'linux'
      )
    ).toEqual({
      PATH: '/managed/bin:/usr/bin',
      HOME: '/home/person',
      CUSTOM_TOKEN: 'ordinary-user-value'
    })
  })

  it('returns timeout and cancellation results only after owned-tree cleanup', async () => {
    vi.useFakeTimers()
    const { access } = await workspace()
    const timeoutChild = new FakeChild()
    const timeoutCleanup = vi.fn(async () => {
      timeoutChild.exitCode = null
      timeoutChild.signalCode = 'SIGKILL'
      timeoutChild.emit('close', null, 'SIGKILL')
    })
    const timeoutHarness = fakeService(timeoutChild, {
      terminateProcessTree: timeoutCleanup
    })
    const timed = timeoutHarness.service.execute(
      { command: 'wait', timeoutMs: 1_000 },
      {
        conversationId: 'timeout',
        workspace: access,
        signal: new AbortController().signal
      }
    )
    await vi.waitFor(() =>
      expect(timeoutHarness.spawnProcess).toHaveBeenCalledOnce()
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(timed).resolves.toMatchObject({
      terminationReason: 'timeout',
      exitCode: null,
      signal: 'SIGKILL'
    })
    expect(timeoutCleanup).toHaveBeenCalledWith(
      timeoutChild,
      expect.objectContaining({
        platform: 'linux',
        processGroup: true,
        signal: 'SIGKILL'
      })
    )

    const cancelledChild = new FakeChild()
    const cancelCleanup = vi.fn(async () => {
      cancelledChild.signalCode = 'SIGKILL'
      cancelledChild.emit('close', null, 'SIGKILL')
    })
    const cancelledHarness = fakeService(cancelledChild, {
      terminateProcessTree: cancelCleanup
    })
    const controller = new AbortController()
    const cancelled = cancelledHarness.service.execute(
      { command: 'wait' },
      {
        conversationId: 'cancelled',
        workspace: access,
        signal: controller.signal
      }
    )
    await vi.waitFor(() =>
      expect(cancelledHarness.spawnProcess).toHaveBeenCalledOnce()
    )
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({
      terminationReason: 'cancelled',
      signal: 'SIGKILL'
    })
    expect(cancelCleanup).toHaveBeenCalledOnce()
    await timeoutHarness.service.dispose()
    await cancelledHarness.service.dispose()
  })

  it('releaseConversation and dispose cancel only their tracked active calls', async () => {
    const { access } = await workspace()
    const firstChild = new FakeChild()
    const secondChild = new FakeChild()
    const children = [firstChild, secondChild]
    const spawnProcess = vi.fn<DirectModelProcessSpawn>(
      () => children.shift()!
    )
    const terminated: DirectModelProcessChild[] = []
    const service = new LocalDirectModelProcessService({
      platform: 'linux',
      executableExists: async (path) => path === '/bin/bash',
      spawnProcess,
      terminateProcessTree: async (child) => {
        terminated.push(child)
        const fakeChild = child as FakeChild
        fakeChild.signalCode = 'SIGKILL'
        fakeChild.emit('close', null, 'SIGKILL')
      }
    })
    const run = (conversationId: string) =>
      service.execute(
        { command: 'wait' },
        {
          conversationId,
          workspace: access,
          signal: new AbortController().signal
        }
      )
    const first = run('first')
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
    const second = run('second')
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))
    firstChild.stdout.emit('data', 'x'.repeat(120000))
    secondChild.stderr.emit('data', 'y'.repeat(120000))

    await service.releaseConversation('first')
    expect(terminated).toHaveLength(1)
    await expect(first).resolves.toMatchObject({
      terminationReason: 'cancelled'
    })
    await expect(service.readOutput('first', (await first).stdoutReference!.handle)).rejects.toThrow()
    const replacementChild = new FakeChild()
    children.push(replacementChild)
    const replacement = run('first')
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(3))
    replacementChild.exitCode = 0
    replacementChild.emit('close', 0, null)
    await expect(replacement).resolves.toMatchObject({
      exitCode: 0
    })

    await service.dispose()
    expect(terminated).toHaveLength(2)
    expect(terminated.includes(firstChild)).toBe(true)
    expect(terminated.includes(secondChild)).toBe(true)
    await expect(second).resolves.toMatchObject({
      terminationReason: 'cancelled'
    })
    await expect(service.readOutput('second', (await second).stderrReference!.handle)).rejects.toThrow()
    await service.dispose()
  })

  it('runs a real command in the workspace with ignored stdin and piped output', async () => {
    const { root, access } = await workspace()
    await writeFile(join(root, 'marker.txt'), 'ready', 'utf8')
    const service = new LocalDirectModelProcessService()
    const capability = await service.getCapability()
    if (!capability.available) {
      await service.dispose()
      return
    }
    const command =
      process.platform === 'win32'
        ? "Get-Content -Raw 'marker.txt'; [Console]::Error.Write('warn'); exit 3"
        : "cat marker.txt; printf warn >&2; exit 3"

    const result = await service.execute(
      { command },
      {
        conversationId: 'real-command',
        workspace: access,
        signal: new AbortController().signal
      }
    )

    expect(result.exitCode).toBe(3)
    expect(result.cwd).toBe('.')
    expect(result.stdout).toContain('ready')
    expect(result.stderr).toContain('warn')
    await service.dispose()
  })

  it('pages complete stdout and stderr from a real shell', async () => {
    const { access } = await workspace()
    const service = new LocalDirectModelProcessService()
    try {
      expect((await service.getCapability()).available).toBe(true)
      const command = process.platform === 'win32'
        ? "[Console]::Out.Write(('x' * 120000) + 'stdout-end'); [Console]::Error.Write(('y' * 120000) + 'stderr-end')"
        : "printf '%120000sstdout-end' '' | tr ' ' x; printf '%120000sstderr-end' '' | tr ' ' y >&2"
      const result = await service.execute({ command }, {
        conversationId: 'real-pages', workspace: access,
        signal: new AbortController().signal
      })
      for (const [preview, reference, expected] of [
        [result.stdout, result.stdoutReference, 'x'.repeat(120000) + 'stdout-end'],
        [result.stderr, result.stderrReference, 'y'.repeat(120000) + 'stderr-end']
      ] as const) {
        expect(reference).toBeDefined()
        let output = preview
        let cursor = reference!.nextCursor
        while (cursor < reference!.totalBytes) {
          const page = await service.readOutput('real-pages', reference!.handle, cursor, 4096)
          output += page.content
          cursor = page.nextCursor
        }
        expect(output).toBe(expected)
      }
      await service.dispose()
      await expect(service.readOutput('real-pages', result.stdoutReference!.handle)).rejects.toThrow()
    } finally {
      await service.dispose()
    }
  })
})
