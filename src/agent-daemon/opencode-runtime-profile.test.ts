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
  it('runs Ask directly in the Workspace', () => {
    const fixture = createFixture()
    const profile = createOpenCodeLaunchProfile({
      ...fixture,
      workMode: 'ask'
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
  })

  it('runs Execute directly with the SSH account environment', () => {
    const fixture = createFixture()
    const execute = createOpenCodeLaunchProfile({
      ...fixture,
      workMode: 'execute'
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
  })

  it('keeps Runtime arguments credential-free and rejects a changed manifest', () => {
    const fixture = createFixture()
    const profile = createOpenCodeLaunchProfile({
      ...fixture,
      workMode: 'ask'
    })
    expect(profile.args.join('\0')).not.toContain('ANTHROPIC_API_KEY')

    expect(() =>
      createOpenCodeLaunchProfile({
        ...fixture,
        manifest: remoteRuntimeBundleManifestSchema.parse({
          ...fixture.manifest,
          allowedEnvironmentNames: ['HOME']
        }),
        workMode: 'ask'
      })
    ).toThrow(/environment allowlist/iu)
    expect(() =>
      createOpenCodeLaunchProfile({
        ...fixture,
        workspaceDirectory: 'relative/workspace',
        workMode: 'ask'
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
          workMode: 'ask'
        })
      ).toMatchObject({ workMode: 'ask' })
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
      workMode: 'ask',
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
      workMode: 'execute',
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

  it('allows Execute to use a workspace that contains managed Runtime paths', () => {
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
        workMode: 'execute',
        modelBridge
      })
    ).toMatchObject({
      cwd: workspaceDirectory,
      workMode: 'execute'
    })
    expect(
      createOpenCodeLaunchProfile({
        manifest: fixture.manifest,
        bundleDirectory,
        workspaceDirectory,
        workMode: 'ask',
        modelBridge
      })
    ).toMatchObject({
      cwd: workspaceDirectory,
      workMode: 'ask'
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
      runtimeVersion: '1.18.9',
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
          version: '1.18.9',
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
