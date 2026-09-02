import { EventEmitter } from 'node:events'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLocalToolEnvironment,
  inspectLocalToolExecutable,
  resolveNpmCliPaths,
  type LocalToolProbeProcess,
  type LocalToolProbeSpawn
} from './local-tool-environment'

const temporaryDirectories: string[] = []

async function temporaryDirectory(name: string): Promise<string> {
  const path = join(
    tmpdir(),
    `goodbuddy-${name}-${process.pid}-${Math.random().toString(16).slice(2)}`
  )
  await mkdir(path, { recursive: true })
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    const { rm } = await import('node:fs/promises')
    await rm(directory, { recursive: true, force: true })
  }
})

type FakeProbe = LocalToolProbeProcess & EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

function probeSpawn(
  outputFor: (command: string, args: string[]) => {
    code?: number
    stderr?: string
    stdout?: string
  }
): LocalToolProbeSpawn {
  return (command, args) => {
    const child = new EventEmitter() as unknown as FakeProbe
    child.exitCode = null
    child.killed = false
    child.pid = 1234
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => {
      child.killed = true
      return true
    })
    queueMicrotask(() => {
      const result = outputFor(command, args)
      if (result.stdout) {
        child.stdout.emit('data', Buffer.from(result.stdout))
      }
      if (result.stderr) {
        child.stderr.emit('data', Buffer.from(result.stderr))
      }
      child.exitCode = result.code ?? 0
      child.emit('close', child.exitCode)
    })
    return child
  }
}

async function fixtureFiles(root: string): Promise<{
  electron: string
  managedNpm: string
  managedNpx: string
  managedPython: string
}> {
  const electron = join(root, 'Electron Runtime')
  const managedNpm = join(root, 'packaged npm-cli.js')
  const managedNpx = join(root, 'packaged npx-cli.js')
  const managedPython = join(root, 'Managed Python')
  await Promise.all(
    [electron, managedNpm, managedNpx, managedPython].map((path) =>
      writeFile(path, 'fixture')
    )
  )
  await Promise.all(
    [electron, managedPython].map((path) => chmod(path, 0o700))
  )
  return { electron, managedNpm, managedNpx, managedPython }
}

describe('local tool environment', () => {
  it('creates managed shims and an immutable PATH snapshot', async () => {
    const root = await temporaryDirectory("local-tools'posix")
    const paths = await fixtureFiles(root)
    const source = {
      PATH: '/original/bin',
      CUSTOM: 'kept',
      ELECTRON_RUN_AS_NODE: 'inherited'
    }
    const spawnProcess = vi.fn(
      probeSpawn((command, args) => {
        if (args[0] === '-e') {
          return {
            stdout: '{"version":"22.14.0","architecture":"x64"}\n'
          }
        }
        if (args[0] === '-I') {
          return {
            stdout: '{"version":"3.13.2","architecture":"x86_64"}\n'
          }
        }
        if (args[0] === paths.managedNpm || args[0] === paths.managedNpx) {
          return { stdout: '11.19.0\n' }
        }
        if (args.join(' ') === '-m pip --version') {
          return { stdout: 'pip 25.0 from anywhere (python 3.13)\n' }
        }
        return {
          stderr:
            command === paths.managedPython
              ? 'Python 3.13.2\n'
              : 'v22.14.0\n'
        }
      })
    )
    const bin = join(root, 'private bin')

    const result = await createLocalToolEnvironment(
      {
        binDirectory: bin,
        nodeSelection: { source: 'managed' },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: source
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess
      }
    )

    expect(result.environment.PATH).toBe(`${bin}:${source.PATH}`)
    expect(result.environment.Path).toBeUndefined()
    expect(result.environment.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(result.environment.OPENAI_API_KEY).toBeUndefined()
    expect(Object.isFrozen(result.environment)).toBe(true)
    expect(source.ELECTRON_RUN_AS_NODE).toBe('inherited')
    for (const name of ['node', 'npm', 'npx'] as const) {
      expect(result.diagnostics.tools[name]).toMatchObject({
        available: true,
        source: 'managed'
      })
    }
    for (const name of ['python', 'python3', 'pip'] as const) {
      expect(result.diagnostics.tools[name]).toMatchObject({
        available: true,
        source: 'managed'
      })
    }

    const nodeShim = await readFile(join(bin, 'node'), 'utf8')
    const npmShim = await readFile(join(bin, 'npm'), 'utf8')
    const pipShim = await readFile(join(bin, 'pip'), 'utf8')
    expect(nodeShim).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '${paths.electron.replaceAll("'", "'\\''")}' "$@"`
    )
    expect(npmShim).toContain(
      `npm_execpath='${paths.managedNpm.replaceAll("'", "'\\''")}'`
    )
    expect(pipShim).toContain(" '-m' 'pip' \"$@\"")
    if (process.platform !== 'win32') {
      expect((await stat(join(bin, 'node'))).mode & 0o700).toBe(0o700)
    }
    expect(
      spawnProcess.mock.calls.find(([command]) => command === paths.electron)?.[2]
        .env.ELECTRON_RUN_AS_NODE
    ).toBe('1')
  })

  it('keeps invalid custom selections unavailable without managed or PATH fallback', async () => {
    const root = await temporaryDirectory('local-tools-no-fallback')
    const paths = await fixtureFiles(root)
    const spawnProcess = vi.fn(probeSpawn(() => ({ stdout: 'unexpected' })))
    const missingNode = join(root, 'missing-node')
    const missingPython = join(root, 'missing-python')

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: {
          source: 'custom',
          executablePath: missingNode
        },
        pythonSelection: {
          source: 'custom',
          executablePath: missingPython
        },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: { PATH: dirnameForPath(paths.electron) }
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess
      }
    )

    expect(spawnProcess).not.toHaveBeenCalled()
    for (const diagnostic of Object.values(result.diagnostics.tools)) {
      expect(diagnostic).toMatchObject({
        available: false,
        source: 'custom'
      })
    }
    expect(result.diagnostics.tools.node.executablePath).toBe(missingNode)
    expect(result.diagnostics.tools.python.executablePath).toBe(missingPython)
  })

  it('does not replace custom runtimes that fail their probes', async () => {
    const root = await temporaryDirectory('local-tools-probe-failure')
    const paths = await fixtureFiles(root)
    const customNode = join(root, 'custom-node')
    const customPython = join(root, 'custom-python')
    await Promise.all(
      [customNode, customPython].map((path) => writeFile(path, 'fixture'))
    )
    const spawnProcess = vi.fn(
      probeSpawn(() => ({ code: 1, stderr: 'probe failed' }))
    )

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: {
          source: 'custom',
          executablePath: customNode
        },
        pythonSelection: {
          source: 'custom',
          executablePath: customPython
        },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess
      }
    )

    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(spawnProcess.mock.calls.map(([command]) => command).sort()).toEqual(
      [customNode, customPython].sort()
    )
    expect(result.diagnostics.tools.node).toMatchObject({
      available: false,
      source: 'custom',
      executablePath: customNode
    })
    expect(result.diagnostics.tools.python).toMatchObject({
      available: false,
      source: 'custom',
      executablePath: customPython
    })
  })

  it('does not mix packaged npm or npx into a custom Node selection', async () => {
    const root = await temporaryDirectory('local-tools-no-mixing')
    const paths = await fixtureFiles(root)
    const customDirectory = join(root, 'custom-node')
    await mkdir(customDirectory)
    const customNode = join(customDirectory, 'node')
    await writeFile(customNode, 'fixture')
    const spawnProcess = vi.fn(
      probeSpawn((command) => ({
        stdout:
          command === customNode
            ? '{"version":"20.18.1","architecture":"x64"}\n'
            : 'unexpected\n'
      }))
    )

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: {
          source: 'custom',
          executablePath: customNode
        },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: { PATH: root }
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess
      }
    )

    expect(result.diagnostics.tools.node).toMatchObject({
      available: true,
      source: 'custom',
      executablePath: customNode
    })
    expect(result.diagnostics.tools.npm).toMatchObject({
      available: false,
      source: 'custom'
    })
    expect(result.diagnostics.tools.npx).toMatchObject({
      available: false,
      source: 'custom'
    })
    expect(spawnProcess).toHaveBeenCalledTimes(1)
    expect(spawnProcess).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining([paths.managedNpm]),
      expect.anything()
    )
  })

  it('uses only verified adjacent package managers with custom Node', async () => {
    const root = await temporaryDirectory('local-tools-custom-adjacent')
    const paths = await fixtureFiles(root)
    const customDirectory = join(root, 'custom-node')
    await mkdir(customDirectory)
    const customNode = join(customDirectory, 'node')
    const adjacentNpm = join(customDirectory, 'npm-cli.js')
    const adjacentNpx = join(customDirectory, 'npx-cli.js')
    await Promise.all(
      [customNode, adjacentNpm, adjacentNpx].map((path) =>
        writeFile(path, 'fixture')
      )
    )
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: {
          source: 'custom',
          executablePath: customNode
        },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess: probeSpawn((_command, args) => ({
          stdout:
            args[0] === adjacentNpm || args[0] === adjacentNpx
              ? '10.8.0\n'
              : '{"version":"20.18.1","architecture":"x64"}\n'
        }))
      }
    )

    expect(result.diagnostics.tools.npm).toMatchObject({
      available: true,
      source: 'custom',
      executablePath: adjacentNpm
    })
    expect(result.diagnostics.tools.npx).toMatchObject({
      available: true,
      source: 'custom',
      executablePath: adjacentNpx
    })
    expect(await readFile(join(root, 'bin', 'npm'), 'utf8')).toContain(
      `'${adjacentNpm}'`
    )
  })

  it('leaves an uninstalled managed Python unavailable without PATH probing', async () => {
    const root = await temporaryDirectory('local-tools-python-uninstalled')
    const paths = await fixtureFiles(root)
    const spawnProcess = vi.fn(
      probeSpawn((command, args) => ({
        stdout:
          command === paths.electron && args[0] === '-e'
            ? '{"version":"22.14.0","architecture":"x64"}\n'
            : '11.19.0\n'
      }))
    )
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'managed' },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: { PATH: dirnameForPath(paths.managedPython) }
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess
      }
    )

    for (const name of ['python', 'python3', 'pip'] as const) {
      expect(result.diagnostics.tools[name]).toMatchObject({
        available: false,
        source: 'managed'
      })
    }
    expect(spawnProcess.mock.calls.every(([command]) => command !== paths.managedPython)).toBe(true)
  })

  it('writes Windows wrappers with wrapper-local Electron variables', async () => {
    const root = await temporaryDirectory('local-tools-%-win')
    const paths = await fixtureFiles(root)
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'managed' },
        pythonSelection: {
          source: 'custom',
          executablePath: paths.managedPython
        },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: { Path: 'C:\\Windows\\System32' }
      },
      {
        platform: 'win32',
        electronExecutablePath: paths.electron,
        spawnProcess: probeSpawn((command, args) => ({
          stdout:
            command === paths.managedPython
              ? args.includes('pip')
                ? 'pip 25.0\n'
                : '{"version":"3.13.2","architecture":"amd64"}\n'
              : args[0] === '-e'
                ? '{"version":"22.14.0","architecture":"x64"}\n'
                : '11.19.0\n'
        }))
      }
    )

    const nodeShim = await readFile(join(root, 'bin', 'node.cmd'), 'utf8')
    const npmShim = await readFile(join(root, 'bin', 'npm.cmd'), 'utf8')
    expect(nodeShim).toContain('set "ELECTRON_RUN_AS_NODE=1"')
    expect(npmShim).toContain(
      `set "npm_node_execpath=${paths.electron.replaceAll('%', '%%')}"`
    )
    expect(result.environment.PATH).toBe(
      `${join(root, 'bin')};C:\\Windows\\System32`
    )
  })

  it('cancels probes through process-tree cleanup', async () => {
    const root = await temporaryDirectory('local-tools-cancel')
    const paths = await fixtureFiles(root)
    const terminate = vi.fn(async (child: LocalToolProbeProcess) => {
      child.exitCode = 1
    })
    const hangingSpawn = vi.fn<LocalToolProbeSpawn>(() => {
      const child = new EventEmitter() as unknown as FakeProbe
      child.exitCode = null
      child.killed = false
      child.pid = 4321
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      return child
    })
    const controller = new AbortController()
    const operation = createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'managed' },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        signal: controller.signal,
        probeTimeoutMs: 60_000
      },
      {
        platform: 'linux',
        electronExecutablePath: paths.electron,
        spawnProcess: hangingSpawn,
        terminateProcessTree: terminate
      }
    )
    await vi.waitFor(() => expect(hangingSpawn).toHaveBeenCalledTimes(2))
    controller.abort(new Error('cancelled by test'))

    await expect(operation).rejects.toThrow('cancelled by test')
    expect(terminate).toHaveBeenCalledTimes(2)
  })

  it('inspects executed runtime metadata and rejects Python 2', async () => {
    const root = await temporaryDirectory('local-tools-inspection')
    const executable = join(root, 'runtime')
    await writeFile(executable, 'fixture')

    await expect(
      inspectLocalToolExecutable(
        'node',
        executable,
        { baseEnvironment: { PATH: root, NODE_OPTIONS: '--inspect' } },
        {
          platform: 'linux',
          spawnProcess: probeSpawn((_command, args) => ({
            stdout: args.includes('-e')
              ? '{"version":"22.14.0","architecture":"arm64"}\n'
              : ''
          }))
        }
      )
    ).resolves.toEqual({
      kind: 'node',
      executablePath: await import('node:fs/promises').then(({ realpath }) =>
        realpath(executable)
      ),
      version: '22.14.0',
      architecture: 'arm64'
    })

    await expect(
      inspectLocalToolExecutable(
        'python',
        executable,
        { baseEnvironment: { PATH: root } },
        {
          platform: 'linux',
          spawnProcess: probeSpawn(() => ({
            stdout: '{"version":"2.7.18","architecture":"x86_64"}\n'
          }))
        }
      )
    ).resolves.toBeUndefined()
  })

  it('resolves development and packaged npm CLI locations', () => {
    expect(
      resolveNpmCliPaths({
        appPath: '/app',
        resourcesPath: '/resources',
        packaged: false
      })
    ).toEqual({
      npmCliPath: join('/app', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      npxCliPath: join('/app', 'node_modules', 'npm', 'bin', 'npx-cli.js')
    })
    expect(
      resolveNpmCliPaths({
        appPath: '/app',
        resourcesPath: '/resources',
        packaged: true
      })
    ).toEqual({
      npmCliPath: join('/resources', 'runtimes', 'npm', 'bin', 'npm-cli.js'),
      npxCliPath: join('/resources', 'runtimes', 'npm', 'bin', 'npx-cli.js')
    })
  })
})

function dirnameForPath(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
}
