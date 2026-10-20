import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultLocalToolEnvironmentSettings,
  type LocalToolEnvironmentSettings
} from '../../shared/local-tool-environment-contracts'
import {
  LocalToolEnvironmentService,
  validateManagedPython
} from './local-tool-environment-service'
import type { LocalToolEnvironmentServiceOptions } from './local-tool-environment-service'
import type {
  LocalToolProbeProcess,
  LocalToolProbeSpawn
} from './local-tool-environment'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-local-tools-'))
  roots.push(root)
  const node = join(root, 'node.exe')
  const python = join(root, 'python.exe')
  await Promise.all([writeFile(node, ''), writeFile(python, '')])
  let settings: LocalToolEnvironmentSettings = {
    ...defaultLocalToolEnvironmentSettings
  }
  const settingsStore = {
    get: vi.fn(async () => ({ localToolEnvironment: settings })),
    update: vi.fn(async (input: { localToolEnvironment: LocalToolEnvironmentSettings }) => {
      settings = input.localToolEnvironment
      return { localToolEnvironment: settings }
    })
  }
  const options: LocalToolEnvironmentServiceOptions = {
    settingsStore: settingsStore as never,
    binDirectory: join(root, 'bin'),
    managedPythonRoot: join(root, 'managed-python'),
    pythonArtifactCatalogPath: join(
      process.cwd(),
      'resources',
      'tool-environment',
      'managed-python-artifacts.json'
    ),
    packagedNpmCliPath: join(root, 'npm-cli.js'),
    packagedNpxCliPath: join(root, 'npx-cli.js'),
    selectExecutable: vi.fn(async () => python),
    // Match fixture casing on case-sensitive hosts while simulating Windows.
    baseEnvironment: { PATH: root, PATHEXT: '.exe;.cmd' },
    platform: 'win32',
    arch: 'x64'
  }
  const service = new LocalToolEnvironmentService(options, {
    toolEnvironment: {
      platform: 'win32',
      spawnProcess: fakeInspectionSpawn()
    }
  })
  return { service, settingsStore, node, python, options }
}

function fakeInspectionSpawn(
  invalidPath?: string
): LocalToolProbeSpawn {
  return (command, args) => {
    const child = new EventEmitter() as LocalToolProbeProcess & EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
    }
    child.exitCode = null
    child.killed = false
    child.pid = 1234
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => true)
    queueMicrotask(() => {
      const invalid = command === invalidPath
      const python = args[0] === '-I'
      if (!invalid) {
        child.stdout.emit(
          'data',
          JSON.stringify({
            version: python ? '3.12.8' : '22.14.0',
            architecture: 'x64'
          })
        )
      }
      child.exitCode = invalid ? 1 : 0
      child.emit('close', child.exitCode)
    })
    return child
  }
}

describe('LocalToolEnvironmentService', () => {
  it('does not discover PATH candidates until explicitly refreshed', async () => {
    const { service, node, python } = await fixture()
    expect((await service.getSnapshot()).candidates).toEqual([])

    const snapshot = await service.refreshCandidates()
    expect(snapshot.candidates).toEqual([
      {
        kind: 'node',
        executablePath: node,
        version: '22.14.0',
        architecture: 'x64'
      },
      {
        kind: 'python',
        executablePath: python,
        version: '3.12.8',
        architecture: 'x64'
      }
    ])
  })

  it('discovers validated virtual-environment and Conda interpreters outside PATH', async () => {
    const { options } = await fixture()
    const virtualEnvironment = join(options.managedPythonRoot, 'project-venv')
    const condaEnvironment = join(options.managedPythonRoot, 'conda-env')
    const condaEnvironments = join(options.managedPythonRoot, 'conda-envs')
    const namedCondaEnvironment = join(condaEnvironments, 'analytics')
    const virtualPython = join(virtualEnvironment, 'python.exe')
    const condaPython = join(condaEnvironment, 'python.exe')
    const namedCondaPython = join(namedCondaEnvironment, 'python.exe')
    await Promise.all([
      mkdir(virtualEnvironment, { recursive: true }),
      mkdir(condaEnvironment, { recursive: true }),
      mkdir(namedCondaEnvironment, { recursive: true })
    ])
    await Promise.all([
      writeFile(virtualPython, ''),
      writeFile(condaPython, ''),
      writeFile(namedCondaPython, '')
    ])
    const service = new LocalToolEnvironmentService(
      {
        ...options,
        baseEnvironment: {
          PATH: Array.from(
            { length: 80 },
            (_, index) => join(options.managedPythonRoot, `path-${index}`)
          ).join(';'),
          VIRTUAL_ENV: virtualEnvironment,
          CONDA_PREFIX: condaEnvironment,
          CONDA_ENVS_PATH: condaEnvironments
        }
      },
      {
        toolEnvironment: {
          platform: 'win32',
          spawnProcess: fakeInspectionSpawn()
        }
      }
    )

    const snapshot = await service.refreshCandidates()

    expect(
      snapshot.candidates.map(({ executablePath }) => executablePath)
    ).toEqual([virtualPython, condaPython, namedCondaPython])
    expect(snapshot.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'python',
          version: '3.12.8',
          architecture: 'x64'
        })
      ])
    )
  })

  it('persists the complete nested settings object through one store authority', async () => {
    const { service, settingsStore, node } = await fixture()
    const next: LocalToolEnvironmentSettings = {
      node: { source: 'custom', executablePath: node },
      python: { source: 'managed' },
      artifactDownloadSource: 'oss'
    }
    await service.updateSettings(next)
    expect(settingsStore.update).toHaveBeenCalledWith({
      localToolEnvironment: next
    })
    await expect(
      service.updateSettings({ ...next, command: 'node' })
    ).rejects.toThrow()
  })

  it('keeps the same immutable PATH snapshot when settings change', async () => {
    const { service, node } = await fixture()
    await service.initialize()
    const initial = service.launchEnvironmentProvider()

    expect(Object.isFrozen(initial)).toBe(true)
    expect(initial.PATH).toContain('bin')

    await service.updateSettings({
      ...defaultLocalToolEnvironmentSettings,
      node: { source: 'custom', executablePath: node }
    })

    // Only the wrapper files change; PATH (and therefore runtime reuse keys)
    // stays identical, so reused runtimes are not restarted.
    expect(service.launchEnvironmentProvider()).toBe(initial)
  })

  it('does not run any executable while starting up', async () => {
    const { options } = await fixture()
    const spawnProcess = vi.fn(fakeInspectionSpawn())
    const service = new LocalToolEnvironmentService(options, {
      toolEnvironment: { platform: 'win32', spawnProcess }
    })
    await service.initialize()
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('starts initialization once and lets consumers wait for the built environment', async () => {
    const { service } = await fixture()
    await expect(service.whenReady()).resolves.toBeUndefined()

    const started = service.initialize()
    expect(service.initialize()).toBe(started)
    expect(service.launchEnvironmentProvider()).toEqual({})

    await service.whenReady()
    expect(service.launchEnvironmentProvider().PATH).toContain('bin')
    await started
  })

  it('applies a settings update after an in-flight initialization, never before it', async () => {
    const { service, node } = await fixture()
    const order: string[] = []
    const initialization = service.initialize().then(() => {
      order.push('initialized')
    })
    const update = service
      .updateSettings({
        ...defaultLocalToolEnvironmentSettings,
        node: { source: 'custom', executablePath: node }
      })
      .then(() => {
        order.push('updated')
      })
    await Promise.all([initialization, update])

    expect(order).toEqual(['initialized', 'updated'])
    expect(service.launchEnvironmentProvider().PATH).toContain('bin')
  })

  it('reports a failed initialization through whenReady and still disposes', async () => {
    const { service, options } = await fixture()
    const failing = new LocalToolEnvironmentService(
      { ...options, pythonArtifactCatalogPath: join(options.managedPythonRoot, 'missing.json') },
      { toolEnvironment: { platform: 'win32', spawnProcess: fakeInspectionSpawn() } }
    )
    await expect(failing.initialize()).rejects.toThrow()
    await expect(failing.whenReady()).rejects.toThrow()
    await expect(failing.dispose()).resolves.toBeUndefined()
    await service.dispose()
  })

  it('keeps executable paths inside the Main-owned picker callback', async () => {
    const { service, settingsStore, python } = await fixture()
    const snapshot = await service.selectExecutable('python')
    expect(settingsStore.update).toHaveBeenCalledWith({
      localToolEnvironment: {
        ...defaultLocalToolEnvironmentSettings,
        python: { source: 'custom', executablePath: python }
      }
    })
    expect(snapshot.settings.python).toEqual({
      source: 'custom',
      executablePath: python
    })
  })

  it('rejects an invalid new custom selection without persisting it', async () => {
    const { settingsStore, node, options } = await fixture()
    const invalid = join(node, '..', 'invalid-node.exe')
    await writeFile(invalid, '')
    const customService = new LocalToolEnvironmentService(
      {
        ...options,
        selectExecutable: async () => invalid
      },
      {
        toolEnvironment: {
          platform: 'win32',
          spawnProcess: fakeInspectionSpawn(invalid)
        }
      }
    )

    await expect(customService.selectExecutable('node')).rejects.toThrow(
      'Selected node executable is invalid'
    )
    expect(settingsStore.update).not.toHaveBeenCalled()
    expect((await customService.getSnapshot()).settings.node).toEqual({
      source: 'auto'
    })
  })

  it('reports the system programs found before the fallback wrappers', async () => {
    const { service, node, python } = await fixture()
    await service.initialize()
    const snapshot = await service.diagnose('all')

    expect(snapshot.diagnostics.node).toMatchObject({
      available: true,
      source: 'auto',
      origin: 'system',
      executablePath: node
    })
    expect(snapshot.diagnostics.python).toMatchObject({
      available: true,
      source: 'auto',
      origin: 'system',
      executablePath: python
    })
  })

  it('restores persisted settings when launch environment publication fails', async () => {
    const { settingsStore, node, options } = await fixture()
    const blockedBinDirectory = join(node, '..', 'blocked-bin')
    await writeFile(blockedBinDirectory, '')
    const customService = new LocalToolEnvironmentService(
      {
        ...options,
        binDirectory: blockedBinDirectory
      },
      {
        toolEnvironment: {
          platform: 'win32',
          spawnProcess: fakeInspectionSpawn()
        }
      }
    )

    await expect(
      customService.updateSettings({
        ...defaultLocalToolEnvironmentSettings,
        node: { source: 'custom', executablePath: node }
      })
    ).rejects.toThrow()
    expect(settingsStore.update).toHaveBeenLastCalledWith({
      localToolEnvironment: defaultLocalToolEnvironmentSettings
    })
    expect((await customService.getSnapshot()).settings).toEqual(
      defaultLocalToolEnvironmentSettings
    )
  })

  it('validates pip and a disposable venv with separated bounded process calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goodbuddy-python-validation-'))
    roots.push(root)
    const python = join(root, 'python.exe')
    const staging = join(root, 'stage')
    const validationVenv = join(staging, '.validation-venv')
    await Promise.all([writeFile(python, ''), mkdir(staging)])
    const calls: Array<{
      command: string
      args: string[]
      options: Parameters<LocalToolProbeSpawn>[2]
    }> = []
    const spawnProcess: LocalToolProbeSpawn = (command, args, options) => {
      calls.push({ command, args, options })
      const child = new EventEmitter() as LocalToolProbeProcess &
        EventEmitter & {
          stdout: EventEmitter
          stderr: EventEmitter
        }
      child.exitCode = null
      child.killed = false
      child.pid = 4321
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn(() => true)
      queueMicrotask(() => {
        if (args[0] === '-m' && args[1] === 'pip') {
          child.stdout.emit('data', 'pip 24.3 from managed Python\n')
        } else if (args[0] === '-m' && args[1] === 'venv') {
          mkdirSync(validationVenv, { recursive: true })
        } else {
          child.stdout.emit(
            'data',
            JSON.stringify({
              version: '3.12.8',
              architecture: 'AMD64',
              ssl: 'OpenSSL 3.0.15',
              stdlib: join(root, 'Lib')
            })
          )
        }
        child.exitCode = 0
        child.emit('close', 0)
      })
      return child
    }

    await validateManagedPython(
      python,
      staging,
      '3.12.8',
      'x64',
      new AbortController().signal,
      'win32',
      { platform: 'win32', spawnProcess }
    )

    expect(calls).toHaveLength(3)
    expect(calls[0]).toMatchObject({
      command: python,
      args: ['-m', 'pip', '--version']
    })
    expect(calls[1]).toMatchObject({
      command: python,
      args: ['-m', 'venv', '--without-pip', validationVenv]
    })
    expect(calls[2]).toMatchObject({
      command: join(validationVenv, 'Scripts', 'python.exe')
    })
    expect(calls[2]?.args.slice(0, 2)).toEqual(['-I', '-c'])
    expect(calls.every(({ options }) => options.shell === false)).toBe(true)
    await expect(access(validationVenv)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
