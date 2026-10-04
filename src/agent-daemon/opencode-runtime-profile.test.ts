import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  remoteRuntimeBundleManifestSchema,
  type RemoteRuntimeBundleManifest
} from '../shared/remote-runtime-launch-contracts'
import {
  createOpenCodeLaunchProfile
} from './opencode-runtime-profile'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe('OpenCode direct launch profile', () => {
  it('launches Continue through the managed HTTP facade without a mode option', () => {
    const fixture = createFixture()
    const manifest = remoteRuntimeBundleManifestSchema.parse({
      ...fixture.manifest, runtimeId: 'continue', provider: 'continue', runtimeVersion: '1.5.47',
      files: fixture.manifest.files.map(file => file.path === 'bin/opencode' ? { ...file, path: 'lib/continue/dist/cn.js' } : file),
      entrypoint: { ...fixture.manifest.entrypoint, identity: 'continue-acp', path: 'lib/continue/dist/cn.js', argvPrefix: [] }
    })
    expect(() => createOpenCodeLaunchProfile({ ...fixture, manifest })).toThrow(/model bridge/)
    const profile = createOpenCodeLaunchProfile({ ...fixture, manifest,
      modelBridge: {
        agentExecutablePath: resolve(fixture.bundleDirectory, 'agent', 'goodbuddy-agent'),
        bridgeDirectory: resolve(fixture.bundleDirectory, 'bridge'),
        socketPath: resolve(fixture.bundleDirectory, 'bridge', 'model.sock'),
        sharedSessions: true,
        policy: { protocol: 'openai-responses', model: 'selected-model',
          modelProfileDigest: `sha256:${'9'.repeat(64)}`, supportsImageInput: true }
      }
    })
    expect(profile.args).toEqual(expect.arrayContaining([
      'model-bridge-helper', '--runtime-id', 'continue', '--continue-entrypoint',
      resolve(fixture.bundleDirectory, 'lib/continue/dist/cn.js'),
      '--shared-sessions', 'true'
    ]))
    expect(profile.args).not.toContain('acp')
    expect(profile.args).not.toContain('--work-mode')
    expect(profile).not.toHaveProperty('workMode')
    expect(profile.cwd).toBe(fixture.workspaceDirectory)
    expect(profile.env.OPENCODE_CONFIG_CONTENT === process.env.OPENCODE_CONFIG_CONTENT).toBe(true)
  })

  it(
    'disables unused automatic Git snapshots',
    () => {
      const profile = createOpenCodeLaunchProfile({
        ...createFixture()
      })
      const config = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT!)
      expect(profile.env).toMatchObject({
        DO_NOT_TRACK: '1', OTEL_SDK_DISABLED: 'true',
        OTEL_LOGS_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_TRACES_EXPORTER: 'none',
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1'
      })
      expect(config.snapshot).toBe(false)
      expect(config.permission).toBe('allow')
    }
  )

  it('runs directly in the Workspace with normal tools available', () => {
    const fixture = createFixture()
    const profile = createOpenCodeLaunchProfile({
      ...fixture,
    })

    expect(profile.executable).toBe(
      resolve(fixture.bundleDirectory, 'bin', 'opencode')
    )
    expect(profile.processExecutable).toBe(profile.executable)
    expect(profile.args).toEqual(['acp'])
    expect(profile.cwd).toBe(fixture.workspaceDirectory)
    expect(profile.env).toMatchObject({
      HOME:
        process.env.HOME ?? fixture.workspaceDirectory,
      PATH: process.env.PATH || '/usr/bin:/bin'
    })
    expect(
      JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT!)
    ).toMatchObject({
      permission: 'allow',
      agent: {
        build: {
          permission: 'allow'
        }
      }
    })
  })

  it('runs directly with the SSH account environment', () => {
    const fixture = createFixture()
    const execute = createOpenCodeLaunchProfile({
      ...fixture,
    })

    expect(execute.executable).toBe(
      resolve(fixture.bundleDirectory, 'bin', 'opencode')
    )
    expect(execute.processExecutable).toBe(execute.executable)
    expect(execute.args).toEqual(['acp'])
    expect(execute.cwd).toBe(fixture.workspaceDirectory)
    expect(execute.env).toMatchObject({
      HOME:
        process.env.HOME ?? fixture.workspaceDirectory,
      LANG: process.env.LANG || 'C.UTF-8',
      LC_ALL: process.env.LC_ALL || 'C.UTF-8',
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: process.env.TMPDIR || '/tmp',
      XDG_CACHE_HOME:
        process.env.XDG_CACHE_HOME ||
        resolve(
          process.env.HOME ?? fixture.workspaceDirectory,
          '.cache'
        ),
      XDG_CONFIG_HOME:
        process.env.XDG_CONFIG_HOME ||
        resolve(
          process.env.HOME ?? fixture.workspaceDirectory,
          '.config'
        ),
      XDG_DATA_HOME:
        process.env.XDG_DATA_HOME ||
        resolve(
          process.env.HOME ?? fixture.workspaceDirectory,
          '.local',
          'share'
        ),
      XDG_STATE_HOME:
        process.env.XDG_STATE_HOME ||
        resolve(
          process.env.HOME ?? fixture.workspaceDirectory,
          '.local',
          'state'
        )
    })
    expect(execute.args).not.toContain('--unshare-all')
    expect(JSON.parse(execute.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      permission: 'allow',
      agent: { build: { permission: 'allow' } }
    })
  })

  it('keeps Runtime arguments credential-free and rejects a changed manifest', () => {
    const fixture = createFixture()
    const profile = createOpenCodeLaunchProfile({
      ...fixture,
    })
    expect(profile.args.join('\0')).not.toContain('ANTHROPIC_API_KEY')

    expect(() =>
      createOpenCodeLaunchProfile({
        ...fixture,
        manifest: remoteRuntimeBundleManifestSchema.parse({
          ...fixture.manifest,
          allowedEnvironmentNames: ['HOME']
        }),
      })
    ).toThrow(/environment allowlist/iu)
    expect(() =>
      createOpenCodeLaunchProfile({
        ...fixture,
        workspaceDirectory: 'relative/workspace',
      })
    ).toThrow(/normalized absolute/iu)
  })

  it('does not impose mount-layout constraints on direct launches', () => {
    const fixture = createFixture()
    for (const conflict of [
      {
        workspaceDirectory: resolve(
          fixture.bundleDirectory,
          'workspace'
        )
      },
      {
        workspaceDirectory: resolve(
          fixture.bundleDirectory,
          '..'
        )
      }
    ]) {
      expect(
        createOpenCodeLaunchProfile({
          ...fixture,
          ...conflict,
        })
      ).toMatchObject({ cwd: conflict.workspaceDirectory })
    }
  })

  it('launches the signed Agent helper with fixed credential-free bridge argv', () => {
    const fixture = createFixture()
    const bridgeDirectory = resolve(
      fixture.workspaceDirectory,
      '..',
      'bridge'
    )
    mkdirSync(bridgeDirectory, { mode: 0o700 })
    const agentInstallationDirectory = resolve(
      fixture.workspaceDirectory,
      '..',
      'agent-installation'
    )
    mkdirSync(agentInstallationDirectory, { mode: 0o700 })
    const agentExecutablePath = resolve(
      agentInstallationDirectory,
      'goodbuddy-agent'
    )
    const socketPath = resolve(
      bridgeDirectory,
      'model-bridge.sock'
    )
    const profile = createOpenCodeLaunchProfile({
      ...fixture,
      modelBridge: {
        agentExecutablePath,
        bridgeDirectory,
        socketPath,
        policy: {
          protocol: 'anthropic-messages',
          model: 'private-model',
          modelProfileDigest: `sha256:${'9'.repeat(64)}`,
          supportsImageInput: false
        }
      }
    })

    expect(profile.executable).toBe(
      resolve(agentInstallationDirectory, 'node')
    )
    expect(profile.args).toEqual([
      resolve(agentInstallationDirectory, 'lib', 'agent.cjs'),
      'model-bridge-helper',
      '--socket-path',
      socketPath,
      '--protocol',
      'anthropic-messages',
      '--model',
      'private-model',
      '--supports-image-input',
      'false',
      '--opencode-entrypoint',
      resolve(fixture.bundleDirectory, 'bin', 'opencode')
    ])
    expect(profile.processExecutable).toBe(
      resolve(agentInstallationDirectory, 'node')
    )
    expect(profile.args.join('\0')).not.toMatch(
      /api[-_]?key|authorization|bearer|(?:^|\0)--token(?:\0|$)/iu
    )

    const executeProfile = createOpenCodeLaunchProfile({
      ...fixture,
      modelBridge: {
        agentExecutablePath,
        bridgeDirectory,
        socketPath,
        policy: {
          protocol: 'anthropic-messages',
          model: 'private-model',
          modelProfileDigest: `sha256:${'9'.repeat(64)}`,
          supportsImageInput: false
        }
      }
    })
    expect(executeProfile.executable).toBe(
      resolve(agentInstallationDirectory, 'node')
    )
    expect(executeProfile.processExecutable).toBe(
      resolve(agentInstallationDirectory, 'node')
    )
    expect(executeProfile.args[0]).toBe(
      resolve(agentInstallationDirectory, 'lib', 'agent.cjs')
    )
  })

  it('allows a workspace that contains managed Runtime paths', () => {
    const fixture = createFixture()
    const workspaceDirectory = resolve(
      fixture.workspaceDirectory,
      '..'
    )
    const managedRoot = resolve(workspaceDirectory, '.goodbuddy')
    const bundleDirectory = resolve(
      managedRoot,
      'runtimes',
      'opencode'
    )
    const agentInstallationDirectory = resolve(
      managedRoot,
      'agent',
      'installation'
    )
    const bridgeDirectory = resolve(
      managedRoot,
      'bridges',
      'prompt'
    )
    const modelBridge = {
      agentExecutablePath: resolve(
        agentInstallationDirectory,
        'goodbuddy-agent'
      ),
      bridgeDirectory,
      socketPath: resolve(
        bridgeDirectory,
        'model-bridge.sock'
      ),
      policy: {
        protocol: 'anthropic-messages' as const,
        model: 'private-model',
        modelProfileDigest: `sha256:${'9'.repeat(64)}`,
        supportsImageInput: false
      }
    }

    expect(
      createOpenCodeLaunchProfile({
        manifest: fixture.manifest,
        bundleDirectory,
        workspaceDirectory,
        modelBridge
      })
    ).toMatchObject({
      cwd: workspaceDirectory,
    })
  })
})

function createFixture(): {
  manifest: RemoteRuntimeBundleManifest
  bundleDirectory: string
  workspaceDirectory: string
} {
  const root = resolve(
    mkdtempSync(join(tmpdir(), 'goodbuddy-opencode-profile-'))
  )
  temporaryPaths.push(root)
  const bundleDirectory = resolve(root, 'bundle')
  const workspaceDirectory = resolve(root, 'workspace')
  for (const directory of [root, bundleDirectory, workspaceDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      chmodSync(directory, 0o700)
    }
  }
  return {
    bundleDirectory,
    workspaceDirectory,
    manifest: remoteRuntimeBundleManifestSchema.parse({
      formatVersion: 2,
      product: 'GoodBuddy',
      runtimeId: 'opencode',
      runtimeVersion: '1.18.29',
      provider: 'opencode',
      platform: 'linux',
      architecture: 'x64',
      signingKeyId: 'runtime-test',
      bundleDigest: `sha256:${'a'.repeat(64)}`,
      adapterDigest: `sha256:${'b'.repeat(64)}`,
      sourcePackage: {
        name: 'opencode-linux-x64-baseline',
        integrity:
          'sha512-x4KiJk9EF7ktM18Ru5Jue4kTntxMvlhWb7tHniQGGRvY2KeoK1iIkyAFd7ri5H/fSkM22hNv/Gg1Jk6/h9IlxQ=='
      },
      entrypoint: {
        identity: 'opencode-acp',
        path: 'bin/opencode',
        sha256: 'd'.repeat(64),
        argvPrefix: ['acp']
      },
      files: [
        {
          path: 'bin/opencode',
          size: 64,
          sha256: 'd'.repeat(64),
          mode: '0755'
        },
        {
          path: 'licenses/opencode.txt',
          size: 4,
          sha256: 'e'.repeat(64),
          mode: '0644'
        }
      ],
      licenses: [
        {
          package: 'opencode-ai',
          version: '1.18.29',
          spdx: 'MIT',
          path: 'licenses/opencode.txt'
        }
      ],
      allowedEnvironmentNames: [
        'HOME',
        'LANG',
        'LC_ALL',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME'
      ],
      protocol: { major: 1, minor: 0 },
      acpCapabilitiesDigest: `sha256:${'f'.repeat(64)}`,
      limits: {
        maximumPromptRuntimeMilliseconds: 60_000,
        maximumPromptInputBytes: 4096,
        maximumPromptOutputBytes: 1024 * 1024
      }
    })
  }
}
