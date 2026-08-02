import { spawnSync } from 'node:child_process'
import { posix } from 'node:path'

export type RuntimeSandboxMode = 'off' | 'auto' | 'strict'

export type RuntimeSandboxStatus = {
  mode: RuntimeSandboxMode
  enforcement: 'disabled' | 'unavailable' | 'bubblewrap'
  available: boolean
  detail: string
}

export type RuntimeSandboxResolution = {
  status: RuntimeSandboxStatus
  binaryPath?: string
}

export type BubblewrapLaunch = {
  command: string
  args: string[]
}

type SandboxProbe = (command: string) => boolean

type BubblewrapLaunchInput = {
  binaryPath: string
  command: string
  args: readonly string[]
  workspace: string
  readOnlyPaths?: readonly string[]
  writablePaths?: readonly string[]
  platform?: NodeJS.Platform
}

const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']

function defaultProbe(command: string): boolean {
  const result = spawnSync(
    command,
    [
      '--die-with-parent',
      '--unshare-all',
      '--share-net',
      '--ro-bind',
      '/',
      '/',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--',
      '/bin/true'
    ],
    {
      shell: false,
      stdio: 'ignore',
      timeout: 1_000,
      windowsHide: true
    }
  )
  return !result.error && result.status === 0
}

export function resolveRuntimeSandbox(
  mode: RuntimeSandboxMode,
  platform: NodeJS.Platform = process.platform,
  probe: SandboxProbe = defaultProbe
): RuntimeSandboxResolution {
  if (mode === 'off') {
    return {
      status: {
        mode,
        enforcement: 'disabled',
        available: false,
        detail: 'Runtime OS 沙箱已关闭'
      }
    }
  }
  if (platform !== 'linux') {
    return {
      status: {
        mode,
        enforcement: 'unavailable',
        available: false,
        detail:
          mode === 'strict'
            ? '严格 OS 沙箱当前仅支持安装 bubblewrap 的 Linux'
            : '当前平台尚无可用的 Runtime OS 沙箱'
      }
    }
  }
  if (!probe('bwrap')) {
    return {
      status: {
        mode,
        enforcement: 'unavailable',
        available: false,
        detail:
          mode === 'strict'
            ? '严格 OS 沙箱需要安装 bubblewrap（bwrap）'
            : '未检测到 bubblewrap，Runtime 将保持审批隔离但不启用 OS 沙箱'
      }
    }
  }
  return {
    binaryPath: 'bwrap',
    status: {
      mode,
      enforcement: 'bubblewrap',
      available: true,
      detail: 'Linux bubblewrap 文件系统沙箱已启用，网络仍按模型连接配置开放'
    }
  }
}

function normalizePath(value: string): string {
  if (
    !posix.isAbsolute(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
  ) {
    throw new Error('OS 沙箱路径必须是无控制字符的绝对路径')
  }
  return posix.normalize(value)
}

function isWithinPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`)
}

function uniquePaths(paths: readonly string[]): string[] {
  return [
    ...new Set(paths.map(normalizePath))
  ].sort((left, right) => left.length - right.length)
}

function addDestinationDirectories(
  args: string[],
  paths: readonly string[]
): void {
  const directories = new Set<string>()
  for (const target of paths) {
    let current = posix.parse(target).dir
    while (current && current !== posix.parse(current).root) {
      if (SYSTEM_PATHS.some((systemPath) => isWithinPath(current, systemPath))) {
        break
      }
      directories.add(current)
      current = posix.parse(current).dir
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => left.length - right.length
  )) {
    args.push('--dir', directory)
  }
}

export function buildBubblewrapLaunch(
  input: BubblewrapLaunchInput
): BubblewrapLaunch {
  if ((input.platform ?? process.platform) !== 'linux') {
    throw new Error('bubblewrap 仅支持 Linux 路径')
  }
  const workspace = normalizePath(input.workspace)
  const command =
    posix.isAbsolute(input.command)
      ? normalizePath(input.command)
      : input.command
  const writablePaths = uniquePaths([
    workspace,
    ...(input.writablePaths ?? [])
  ])
  if (
    writablePaths.some(
      (path) =>
        path === '/' ||
        SYSTEM_PATHS.some((systemPath) =>
          isWithinPath(path, systemPath)
        )
    )
  ) {
    throw new Error('OS 沙箱不允许将系统路径挂载为可写')
  }
  const readOnlyPaths = uniquePaths([
    ...(input.readOnlyPaths ?? []),
    ...(posix.isAbsolute(command) &&
    !SYSTEM_PATHS.some((systemPath) => isWithinPath(command, systemPath))
      ? [command]
      : [])
  ]).filter(
    (path) =>
      !writablePaths.some((writablePath) => isWithinPath(path, writablePath))
  )
  const mountedPaths = [...readOnlyPaths, ...writablePaths]
  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--share-net',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--dir',
    '/run',
    '--dir',
    '/home',
    '--dir',
    '/tmp/goodbuddy-home',
    '--setenv',
    'HOME',
    '/tmp/goodbuddy-home',
    '--setenv',
    'XDG_CONFIG_HOME',
    '/tmp/goodbuddy-home/.config',
    '--setenv',
    'XDG_CACHE_HOME',
    '/tmp/goodbuddy-home/.cache'
  ]
  for (const systemPath of SYSTEM_PATHS) {
    args.push('--ro-bind-try', systemPath, systemPath)
  }
  addDestinationDirectories(args, mountedPaths)
  for (const path of readOnlyPaths) {
    args.push('--ro-bind', path, path)
  }
  for (const path of writablePaths) {
    args.push('--bind', path, path)
  }
  args.push('--chdir', workspace, '--', command, ...input.args)
  return {
    command: input.binaryPath,
    args
  }
}
