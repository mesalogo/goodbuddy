import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from 'node:path'
import {
  OPENCODE_REMOTE_RUNTIME_ENVIRONMENT_NAMES,
  remoteRuntimeBundleManifestSchema,
  type RemoteRuntimeBundleManifest
} from '../shared/remote-runtime-launch-contracts'
import {
  modelBridgePolicySchema,
  type ModelBridgePolicy
} from '../shared/model-bridge-contracts'
import {
  assertAbsoluteManagedPath,
  ensurePrivateDirectoryTree
} from './managed-paths'

export const OPENCODE_BWRAP_EXECUTABLE = '/usr/bin/bwrap'

export type OpenCodeLaunchProfile = {
  executable: string
  processExecutable: string
  args: readonly string[]
  cwd: string
  env: Readonly<NodeJS.ProcessEnv>
  workMode: 'ask' | 'execute'
}

export function createOpenCodeLaunchProfile(input: {
  manifest: RemoteRuntimeBundleManifest
  bundleDirectory: string
  workspaceDirectory: string
  scratchDirectory: string
  workMode: 'ask' | 'execute'
  modelBridge?: {
    agentExecutablePath: string
    bridgeDirectory: string
    socketPath: string
    policy: ModelBridgePolicy
  }
}): OpenCodeLaunchProfile {
  const manifest = remoteRuntimeBundleManifestSchema.parse(
    input.manifest
  )
  if (
    manifest.runtimeId !== 'opencode' ||
    manifest.provider !== 'opencode' ||
    manifest.entrypoint.identity !== 'opencode-acp' ||
    manifest.entrypoint.argvPrefix.length !== 1 ||
    manifest.entrypoint.argvPrefix[0] !== 'acp'
  ) {
    throw new Error('Runtime manifest is not the fixed OpenCode ACP profile')
  }
  if (
    [...manifest.allowedEnvironmentNames].sort().join('\0') !==
    [...OPENCODE_REMOTE_RUNTIME_ENVIRONMENT_NAMES]
      .sort()
      .join('\0')
  ) {
    throw new Error(
      'OpenCode Runtime environment allowlist does not match the fixed profile'
    )
  }

  const bundleDirectory = assertAbsoluteManagedPath(
    resolve(input.bundleDirectory)
  )
  const workspaceDirectory = normalizedAbsolutePath(
    input.workspaceDirectory,
    'Workspace'
  )
  const modelBridge =
    input.modelBridge === undefined
      ? undefined
      : {
          agentExecutablePath: normalizedAbsolutePath(
            input.modelBridge.agentExecutablePath,
            'Agent executable'
          ),
          agentInstallationDirectory: normalizedAbsolutePath(
            dirname(input.modelBridge.agentExecutablePath),
            'Agent installation'
          ),
          bridgeDirectory: normalizedAbsolutePath(
            input.modelBridge.bridgeDirectory,
            'Model bridge'
          ),
          socketPath: normalizedAbsolutePath(
            input.modelBridge.socketPath,
            'Model bridge socket'
          ),
          policy: modelBridgePolicySchema.parse(
            input.modelBridge.policy
          )
        }
  if (
    modelBridge !== undefined &&
    (!isStrictDescendant(
      modelBridge.bridgeDirectory,
      modelBridge.socketPath
    ) ||
      !isStrictDescendant(
        modelBridge.agentInstallationDirectory,
        modelBridge.agentExecutablePath
      ))
  ) {
    throw new Error(
      'Model bridge socket or Agent executable escapes its managed directory'
    )
  }
  const managedPaths = [
    ['Runtime bundle', bundleDirectory],
    ['Workspace', workspaceDirectory],
    ...(modelBridge === undefined
      ? []
      : [
          [
            'Agent installation',
            modelBridge.agentInstallationDirectory
          ] as const,
          [
            'Model bridge',
            modelBridge.bridgeDirectory
          ] as const
        ])
  ] as const
  const executablePath = resolve(
    bundleDirectory,
    ...manifest.entrypoint.path.split('/')
  )
  if (!isStrictDescendant(bundleDirectory, executablePath)) {
    throw new Error('OpenCode entrypoint escapes its bundle directory')
  }

  const runtimeCommand =
    modelBridge === undefined
      ? {
          executable: executablePath,
          args: [...manifest.entrypoint.argvPrefix]
        }
      : {
          executable: join(
            modelBridge.agentInstallationDirectory,
            'node'
          ),
          args: [
            join(
              modelBridge.agentInstallationDirectory,
              'lib',
              'agent.cjs'
            ),
            'model-bridge-helper',
            '--socket-path',
            modelBridge.socketPath,
            '--protocol',
            modelBridge.policy.protocol,
            '--model',
            modelBridge.policy.model,
            '--supports-image-input',
            modelBridge.policy.supportsImageInput ? 'true' : 'false',
            '--opencode-entrypoint',
            executablePath
          ]
        }

  if (input.workMode === 'execute') {
    return {
      ...runtimeCommand,
      processExecutable: runtimeCommand.executable,
      cwd: workspaceDirectory,
      env: executeEnvironment(process.env, workspaceDirectory),
      workMode: 'execute'
    }
  }

  const scratchDirectory = assertAbsoluteManagedPath(
    resolve(input.scratchDirectory)
  )
  assertDisjointPaths([
    ...managedPaths,
    ['Runtime scratch', scratchDirectory]
  ])
  const scratchPaths = {
    home: join(scratchDirectory, 'home'),
    temporary: join(scratchDirectory, 'tmp'),
    cache: join(scratchDirectory, 'xdg-cache'),
    config: join(scratchDirectory, 'xdg-config'),
    data: join(scratchDirectory, 'xdg-data'),
    state: join(scratchDirectory, 'xdg-state')
  }
  for (const path of Object.values(scratchPaths)) {
    ensurePrivateDirectoryTree(path, scratchDirectory)
  }

  const environment: Readonly<Record<
    (typeof OPENCODE_REMOTE_RUNTIME_ENVIRONMENT_NAMES)[number],
    string
  >> = {
    HOME: scratchPaths.home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TMPDIR: scratchPaths.temporary,
    XDG_CACHE_HOME: scratchPaths.cache,
    XDG_CONFIG_HOME: scratchPaths.config,
    XDG_DATA_HOME: scratchPaths.data,
    XDG_STATE_HOME: scratchPaths.state
  }
  const args = [
    '--new-session',
    '--unshare-all',
    '--clearenv',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/run',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind-try',
    '/bin',
    '/bin',
    '--ro-bind-try',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--ro-bind',
    bundleDirectory,
    bundleDirectory,
    '--ro-bind',
    workspaceDirectory,
    workspaceDirectory,
    '--bind',
    scratchDirectory,
    scratchDirectory,
    ...Object.entries(environment).flatMap(([name, value]) => [
      '--setenv',
      name,
      value
    ]),
    '--chdir',
    workspaceDirectory,
    ...(modelBridge === undefined
      ? []
      : [
          '--ro-bind',
          modelBridge.agentInstallationDirectory,
          modelBridge.agentInstallationDirectory,
          '--ro-bind',
          modelBridge.bridgeDirectory,
          modelBridge.bridgeDirectory
        ]),
    '--',
    runtimeCommand.executable,
    ...runtimeCommand.args
  ] as const

  return {
    executable: OPENCODE_BWRAP_EXECUTABLE,
    processExecutable: runtimeCommand.executable,
    args,
    cwd: scratchDirectory,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C.UTF-8'
    },
    workMode: 'ask'
  }
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (
    value.includes('\0') ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${label} path must be a normalized absolute path`)
  }
  return value
}

function executeEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  workspaceDirectory: string
): Readonly<NodeJS.ProcessEnv> {
  const home = usableEnvironmentValue(source.HOME)
    ? source.HOME!
    : workspaceDirectory
  const defaults = {
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state')
  } as const
  const environment: NodeJS.ProcessEnv = { ...source }
  for (const [name, fallback] of Object.entries(defaults)) {
    if (!usableEnvironmentValue(environment[name])) {
      environment[name] = fallback
    }
  }
  return environment
}

function usableEnvironmentValue(
  value: string | undefined
): value is string {
  return value !== undefined && value.length > 0 && !value.includes('\0')
}

function assertDisjointPaths(
  paths: readonly (readonly [label: string, path: string])[]
): void {
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const leftEntry = paths[left]!
      const rightEntry = paths[right]!
      if (
        leftEntry[1] === rightEntry[1] ||
        isStrictDescendant(leftEntry[1], rightEntry[1]) ||
        isStrictDescendant(rightEntry[1], leftEntry[1])
      ) {
        throw new Error(
          `${leftEntry[0]} and ${rightEntry[0]} paths must not overlap`
        )
      }
    }
  }
}

function isStrictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate)
  return (
    child.length > 0 &&
    child !== '..' &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  )
}
