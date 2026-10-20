import { EventEmitter } from 'node:events'
import { chmod, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildLaunchPath,
  createLocalToolEnvironment,
  detectLocalTools,
  inspectLocalToolExecutable,
  resolveCommandOnPath,
  resolveLocalTool,
  resolveNpmCliPaths,
  withoutGoodBuddyWrappers,
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
  return realpath(path)
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
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
    child.kill = vi.fn(() => true)
    queueMicrotask(() => {
      const result = outputFor(command, args)
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout))
      child.exitCode = result.code ?? 0
      child.emit('close', child.exitCode)
    })
    return child
  }
}

const platform: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux'
const separator = platform === 'win32' ? ';' : ':'
const shim = (name: string): string => (platform === 'win32' ? `${name}.cmd` : name)
const executable = (name: string): string => (platform === 'win32' ? `${name}.exe` : name)

async function writeExecutable(path: string): Promise<void> {
  await writeFile(path, 'fixture')
  await chmod(path, 0o755)
}

async function fixtureFiles(root: string) {
  const electron = join(root, 'Electron Runtime')
  const managedNpm = join(root, 'packaged npm-cli.js')
  const managedNpx = join(root, 'packaged npx-cli.js')
  const managedPython = join(root, 'Managed Python')
  await Promise.all(
    [electron, managedNpm, managedNpx, managedPython].map(writeExecutable)
  )
  return { electron, managedNpm, managedNpx, managedPython }
}

describe('local tool environment', () => {
  it('builds the environment without running any executable', async () => {
    const root = await temporaryDirectory('local-tools-no-probe')
    const paths = await fixtureFiles(root)
    const spawnProcess = vi.fn<LocalToolProbeSpawn>()
    const bin = join(root, 'bin')

    const result = await createLocalToolEnvironment(
      {
        binDirectory: bin,
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: { PATH: '/usr/bin', OPENAI_API_KEY: 'secret' }
      },
      { platform, electronExecutablePath: paths.electron, spawnProcess }
    )

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(result.environment).toEqual({
      PATH: [join(bin, 'front'), '/usr/bin', join(bin, 'fallback')].join(separator)
    })
    expect(Object.isFrozen(result.environment)).toBe(true)
    expect((await readdir(join(bin, 'front'))).sort()).toEqual([])
    expect((await readdir(join(bin, 'fallback'))).sort()).toEqual(
      ['node', 'npm', 'npx', 'pip', 'python', 'python3'].map(shim).sort()
    )
  })

  it('puts explicit choices in front of the user PATH', async () => {
    const root = await temporaryDirectory('local-tools-front')
    const paths = await fixtureFiles(root)
    const bin = join(root, 'bin')

    const result = await createLocalToolEnvironment(
      {
        binDirectory: bin,
        nodeSelection: { source: 'managed' },
        pythonSelection: { source: 'custom', executablePath: paths.managedPython },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: { PATH: '/usr/bin' }
      },
      { platform, electronExecutablePath: paths.electron }
    )

    expect(result.shims.node).toMatchObject({ placement: 'front', origin: 'managed' })
    expect(result.shims.python).toMatchObject({
      placement: 'front',
      origin: 'custom',
      target: paths.managedPython
    })
    expect(await readdir(join(bin, 'fallback'))).toEqual([])
    const nodeShim = await readFile(result.shims.node!.shimPath, 'utf8')
    expect(nodeShim).toContain('ELECTRON_RUN_AS_NODE')
    expect(nodeShim).toContain(paths.electron.replaceAll('%', '%%'))
  })

  it('makes pip run the same interpreter as python', async () => {
    const root = await temporaryDirectory('local-tools-pip')
    const paths = await fixtureFiles(root)
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: { PATH: join(root, 'nowhere') }
      },
      { platform, electronExecutablePath: paths.electron }
    )
    expect(result.shims.python).toMatchObject({ origin: 'managed', placement: 'fallback' })
    const pip = await readFile(result.shims.pip!.shimPath, 'utf8')
    expect(pip).toContain(result.shims.python!.target!.replaceAll('%', '%%'))
    expect(pip).toMatch(/-m.*pip/u)
  })

  it('makes a missing explicit choice fail instead of falling through to PATH', async () => {
    const root = await temporaryDirectory('local-tools-missing')
    const paths = await fixtureFiles(root)
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'custom', executablePath: join(root, 'missing-node') },
        pythonSelection: { source: 'managed' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx
      },
      { platform, electronExecutablePath: paths.electron }
    )
    for (const name of ['node', 'npm', 'npx', 'python', 'python3', 'pip'] as const) {
      expect(result.shims[name]).toMatchObject({ placement: 'front' })
      expect(result.shims[name]?.target).toBeUndefined()
      expect(await readFile(result.shims[name]!.shimPath, 'utf8')).toContain('127')
    }
  })

  it('writes no Python wrapper in automatic mode when the built-in is not installed', async () => {
    const root = await temporaryDirectory('local-tools-auto-no-python')
    const paths = await fixtureFiles(root)
    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx
      },
      { platform, electronExecutablePath: paths.electron }
    )
    expect(result.shims.python).toBeUndefined()
    expect(result.shims.pip).toBeUndefined()
    expect(result.shims.node).toMatchObject({ placement: 'fallback' })
  })

  it('keeps PATH identical across rebuilds and removes stale wrappers', async () => {
    const root = await temporaryDirectory('local-tools-stable')
    const paths = await fixtureFiles(root)
    const options = {
      binDirectory: join(root, 'bin'),
      nodeSelection: { source: 'managed' } as const,
      pythonSelection: { source: 'auto' } as const,
      packagedNpmCliPath: paths.managedNpm,
      packagedNpxCliPath: paths.managedNpx,
      managedPythonExecutablePath: paths.managedPython,
      baseEnvironment: { PATH: '/usr/bin' }
    }
    const dependencies = { platform, electronExecutablePath: paths.electron }
    const first = await createLocalToolEnvironment(options, dependencies)
    const second = await createLocalToolEnvironment(
      { ...options, nodeSelection: { source: 'auto' } },
      dependencies
    )
    expect(second.environment.PATH).toBe(first.environment.PATH)
    expect(await readdir(join(root, 'bin', 'front'))).toEqual([])
  })

  it('uses only adjacent package managers with a custom Node', async () => {
    const root = await temporaryDirectory('local-tools-adjacent')
    const paths = await fixtureFiles(root)
    const customDirectory = join(root, 'custom-node')
    await mkdir(customDirectory)
    const customNode = join(customDirectory, executable('node'))
    const adjacentNpm = join(customDirectory, 'npm-cli.js')
    await Promise.all([writeExecutable(customNode), writeExecutable(adjacentNpm)])

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'custom', executablePath: customNode },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx
      },
      { platform, electronExecutablePath: paths.electron }
    )
    expect(result.shims.npm).toMatchObject({ target: adjacentNpm, origin: 'custom' })
    expect(result.shims.npx).toBeUndefined()
    expect(await readFile(result.shims.npm!.shimPath, 'utf8')).not.toContain(paths.managedNpm)
  })
})

describe('automatic Python', () => {
  it('skips the Windows Store stub and finds Python in a common install location', async () => {
    const root = await temporaryDirectory('local-tools-store-stub')
    const paths = await fixtureFiles(root)
    const windowsApps = join(root, 'Microsoft', 'WindowsApps')
    const miniconda = join(root, 'miniconda3')
    await Promise.all([mkdir(windowsApps, { recursive: true }), mkdir(miniconda)])
    await writeExecutable(join(windowsApps, 'python.exe'))
    const condaPython = join(miniconda, 'python.exe')
    await writeExecutable(condaPython)

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: { Path: windowsApps },
        pythonSearchDirectories: [miniconda]
      },
      { platform: 'win32', electronExecutablePath: paths.electron }
    )

    for (const name of ['python', 'python3', 'pip'] as const) {
      expect(result.shims[name]).toMatchObject({
        origin: 'system',
        placement: 'front',
        target: condaPython
      })
    }
  })

  it('prefers Python on PATH over install locations and the built-in', async () => {
    const root = await temporaryDirectory('local-tools-path-python')
    const paths = await fixtureFiles(root)
    const onPath = join(root, 'on-path')
    const elsewhere = join(root, 'elsewhere')
    await Promise.all([mkdir(onPath), mkdir(elsewhere)])
    const name = platform === 'win32' ? 'python.exe' : 'python3'
    await writeExecutable(join(onPath, name))
    await writeExecutable(join(elsewhere, name))

    const result = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: { PATH: onPath },
        pythonSearchDirectories: [elsewhere]
      },
      { platform, electronExecutablePath: paths.electron }
    )
    expect(result.shims.python).toMatchObject({
      origin: 'system',
      target: join(onPath, name)
    })
  })

  it('treats a Store stub resolved on PATH as not found', async () => {
    const root = await temporaryDirectory('local-tools-store-resolve')
    const paths = await fixtureFiles(root)
    const windowsApps = join(root, 'Microsoft', 'WindowsApps')
    await mkdir(windowsApps, { recursive: true })
    await writeExecutable(join(windowsApps, 'python.exe'))
    const base = { Path: windowsApps, PATHEXT: '.EXE;.CMD' }
    const environment = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: base
      },
      { platform: 'win32', electronExecutablePath: paths.electron }
    )
    await expect(resolveLocalTool('python', environment, base, 'win32')).resolves.toBeUndefined()
  })
})

it('drops inherited GoodBuddy wrapper directories from the user PATH', () => {
  expect(
    withoutGoodBuddyWrappers(
      'C:\\Users\\me\\AppData\\Roaming\\goodbuddy\\tool-environment\\bin\\generation-1;C:\\Tools;D:\\gb\\bin\\front',
      'D:\\gb\\bin',
      'win32'
    )
  ).toBe('C:\\Tools')
})

describe('buildLaunchPath', () => {
  it('appends the fallback directory after the user PATH', () => {
    expect(buildLaunchPath('/gb/front', '/gb/fallback', '/usr/bin:/bin', 'linux')).toBe(
      '/gb/front:/usr/bin:/bin:/gb/fallback'
    )
  })

  it('places the fallback before Windows Store aliases', () => {
    expect(
      buildLaunchPath(
        'C:\\gb\\front',
        'C:\\gb\\fallback',
        'C:\\Windows;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools',
        'win32'
      )
    ).toBe(
      'C:\\gb\\front;C:\\Windows;C:\\gb\\fallback;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools'
    )
  })
})

describe('resolution and detection', () => {
  it('reports the system program when it precedes the fallback wrapper', async () => {
    const root = await temporaryDirectory('local-tools-resolve-system')
    const paths = await fixtureFiles(root)
    const systemBin = join(root, 'system')
    await mkdir(systemBin)
    const systemPython = join(systemBin, executable(platform === 'win32' ? 'python' : 'python3'))
    await writeExecutable(systemPython)
    const base = { PATH: systemBin, PATHEXT: '.EXE;.CMD' }
    const environment = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        managedPythonExecutablePath: paths.managedPython,
        baseEnvironment: base
      },
      { platform, electronExecutablePath: paths.electron }
    )

    const pythonName = platform === 'win32' ? 'python' : 'python3'
    await expect(resolveLocalTool(pythonName, environment, base, platform)).resolves.toMatchObject({
      executablePath: systemPython,
      origin: 'system'
    })
    await expect(resolveLocalTool('node', environment, base, platform)).resolves.toMatchObject({
      origin: 'managed',
      executablePath: paths.electron
    })
  })

  it('detects versions only when asked and reports the effective origin', async () => {
    const root = await temporaryDirectory('local-tools-detect')
    const paths = await fixtureFiles(root)
    const base = { PATH: join(root, 'nowhere'), PATHEXT: '.EXE;.CMD' }
    const environment = await createLocalToolEnvironment(
      {
        binDirectory: join(root, 'bin'),
        nodeSelection: { source: 'auto' },
        pythonSelection: { source: 'auto' },
        packagedNpmCliPath: paths.managedNpm,
        packagedNpxCliPath: paths.managedNpx,
        baseEnvironment: base
      },
      { platform, electronExecutablePath: paths.electron }
    )
    const spawnProcess = vi.fn(probeSpawn(() => ({ stdout: 'v22.14.0\n' })))

    const detected = await detectLocalTools(
      environment,
      { node: { source: 'auto' }, python: { source: 'auto' } },
      base,
      {},
      { platform, spawnProcess }
    )

    expect(detected.node).toMatchObject({
      available: true,
      source: 'auto',
      origin: 'managed',
      version: '22.14.0',
      executablePath: paths.electron
    })
    expect(detected.python).toMatchObject({ available: false, source: 'auto' })
    expect(detected.python.origin).toBeUndefined()
    expect(spawnProcess.mock.calls.every(([, args]) => args[0] === '--version')).toBe(true)
  })

  it('resolves commands with stat only, honoring PATHEXT on Windows', async () => {
    const root = await temporaryDirectory('local-tools-which')
    const first = join(root, 'first')
    const second = join(root, 'second')
    await Promise.all([mkdir(first), mkdir(second)])
    const target = join(second, platform === 'win32' ? 'tool.CMD' : 'tool')
    await writeExecutable(target)
    await expect(
      resolveCommandOnPath('tool', [first, second].join(separator), platform, '.EXE;.CMD')
    ).resolves.toBe(target)
    await expect(
      resolveCommandOnPath('missing', [first, second].join(separator), platform)
    ).resolves.toBeUndefined()
  })
})

describe('inspectLocalToolExecutable', () => {
  it('inspects executed runtime metadata and rejects Python 2', async () => {
    const root = await temporaryDirectory('local-tools-inspection')
    const target = join(root, 'runtime')
    await writeFile(target, 'fixture')

    await expect(
      inspectLocalToolExecutable(
        'node',
        target,
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
      executablePath: target,
      version: '22.14.0',
      architecture: 'arm64'
    })

    await expect(
      inspectLocalToolExecutable(
        'python',
        target,
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

  it('cancels probes through process-tree cleanup', async () => {
    const root = await temporaryDirectory('local-tools-cancel')
    const target = join(root, 'runtime')
    await writeFile(target, 'fixture')
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
    const operation = inspectLocalToolExecutable(
      'node',
      target,
      { baseEnvironment: {}, signal: controller.signal, probeTimeoutMs: 60_000 },
      { platform: 'linux', spawnProcess: hangingSpawn, terminateProcessTree: terminate }
    )
    await vi.waitFor(() => expect(hangingSpawn).toHaveBeenCalledOnce())
    controller.abort(new Error('cancelled by test'))

    await expect(operation).rejects.toThrow('cancelled by test')
    expect(terminate).toHaveBeenCalledOnce()
  })
})

it('resolves development and packaged npm CLI locations', () => {
  expect(
    resolveNpmCliPaths({ appPath: '/app', resourcesPath: '/resources', packaged: false })
  ).toEqual({
    npmCliPath: join('/app', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    npxCliPath: join('/app', 'node_modules', 'npm', 'bin', 'npx-cli.js')
  })
  expect(
    resolveNpmCliPaths({ appPath: '/app', resourcesPath: '/resources', packaged: true })
  ).toEqual({
    npmCliPath: join('/resources', 'runtimes', 'npm', 'bin', 'npm-cli.js'),
    npxCliPath: join('/resources', 'runtimes', 'npm', 'bin', 'npx-cli.js')
  })
})
