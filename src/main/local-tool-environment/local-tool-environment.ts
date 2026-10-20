import { chmod, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import spawn from 'cross-spawn'
import type {
  LocalToolCandidate,
  LocalToolKind,
  LocalToolOrigin,
  LocalToolRuntimeSelection
} from '../../shared/local-tool-environment-contracts'
import {
  terminateProcessTreeAndWait,
  type WaitableProcessTreeChild
} from '../agent/child-process-termination'

const DEFAULT_PROBE_TIMEOUT_MS = 3_000
const DEFAULT_PROBE_OUTPUT_LIMIT = 8 * 1024
const DEFAULT_TERMINATION_WAIT_MS = 500

export const localToolNames = [
  'node',
  'npm',
  'npx',
  'python',
  'python3',
  'pip'
] as const

export type LocalToolName = (typeof localToolNames)[number]

export type LocalToolSource = LocalToolRuntimeSelection['source']

export type LocalToolDiagnostic = {
  available: boolean
  source: LocalToolSource
  /** Effective origin of the executable; absent when nothing was found. */
  origin?: LocalToolOrigin
  version?: string
  executablePath?: string
  detail: string
}

/**
 * A wrapper written into one of the two GoodBuddy wrapper directories.
 *
 * - `front` wrappers precede the user's PATH and force an explicit choice
 *   (built-in or a specific path).
 * - `fallback` wrappers follow the user's PATH, so the operating system only
 *   reaches them when the user's PATH has no such command (automatic mode).
 */
export type LocalToolShim = {
  name: LocalToolName
  shimPath: string
  /** The real program; absent for a wrapper that reports a missing choice. */
  target?: string
  /** `system` means a user installation found without PATH reaching it. */
  origin: LocalToolOrigin
  placement: 'front' | 'fallback'
}

export type LocalToolEnvironment = {
  binDirectory: string
  /** Contains only PATH; callers merge it into a full process environment. */
  environment: Readonly<NodeJS.ProcessEnv>
  shims: Readonly<Partial<Record<LocalToolName, LocalToolShim>>>
}

type ProbeOutput = {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
}

export type LocalToolProbeProcess = WaitableProcessTreeChild & {
  stdout?: ProbeOutput | null
  stderr?: ProbeOutput | null
}

export type LocalToolProbeSpawn = (
  command: string,
  args: string[],
  options: {
    detached: boolean
    env: NodeJS.ProcessEnv
    shell: false
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  }
) => LocalToolProbeProcess

export type LocalToolEnvironmentOptions = {
  binDirectory: string
  nodeSelection: LocalToolRuntimeSelection
  pythonSelection: LocalToolRuntimeSelection
  packagedNpmCliPath: string
  packagedNpxCliPath: string
  managedPythonExecutablePath?: string
  baseEnvironment?: NodeJS.ProcessEnv
  /**
   * Common install locations (Conda, virtual environments, Program Files…)
   * searched after PATH in automatic mode. Only checked with `stat`.
   */
  pythonSearchDirectories?: readonly string[]
}

export type LocalToolEnvironmentDependencies = {
  platform?: NodeJS.Platform
  electronExecutablePath?: string
  spawnProcess?: LocalToolProbeSpawn
  terminateProcessTree?: typeof terminateProcessTreeAndWait
}

export type LocalToolProbeLimits = {
  signal?: AbortSignal
  probeTimeoutMs?: number
  probeOutputLimit?: number
  terminationWaitMs?: number
}

type ProbeResult =
  | { ok: true; output: string }
  | {
      ok: false
      reason: 'cancelled' | 'exit' | 'output-limit' | 'spawn' | 'timeout'
    }

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function quoteCmd(value: string): string {
  return `"${value.replaceAll('%', '%%')}"`
}

function stripUnsafeCharacters(value: string): string {
  let result = ''
  let inEscapeSequence = false
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0
    if (inEscapeSequence) {
      if (point >= 64 && point <= 126) {
        inEscapeSequence = false
      }
      continue
    }
    if (point === 27) {
      inEscapeSequence = true
    } else if (point >= 32 && point !== 127) {
      result += character
    }
  }
  return result
}

function safeVersion(output: string): string | undefined {
  const firstLine = output
    .split(/\r?\n/u)
    .map((line) => stripUnsafeCharacters(line).trim())
    .find(Boolean)
  if (!firstLine) {
    return undefined
  }
  const version = firstLine.match(
    /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/u
  )
  return (version?.[1] ?? firstLine).slice(0, 160)
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation aborted', 'AbortError')
}

async function canonicalFile(filePath: string): Promise<string | undefined> {
  if (!isAbsolute(filePath)) {
    return undefined
  }
  try {
    const path = await realpath(filePath)
    return (await stat(path)).isFile() ? path : undefined
  } catch {
    return undefined
  }
}

function probeExecutable(
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  limits: LocalToolProbeLimits,
  dependencies: LocalToolEnvironmentDependencies
): Promise<ProbeResult> {
  const signal = limits.signal
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, reason: 'cancelled' })
      return
    }
    const platform = dependencies.platform ?? process.platform
    let child: LocalToolProbeProcess
    try {
      child = (dependencies.spawnProcess ?? spawn)(command, args, {
        detached: platform !== 'win32',
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch {
      resolve({ ok: false, reason: 'spawn' })
      return
    }

    let settled = false
    let cleaning = false
    let output = ''
    let outputBytes = 0
    const finish = (result: ProbeResult): void => {
      if (settled || cleaning) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const failWithCleanup = (
      reason: Extract<ProbeResult, { ok: false }>['reason']
    ): void => {
      if (settled || cleaning) {
        return
      }
      cleaning = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      void (
        dependencies.terminateProcessTree ?? terminateProcessTreeAndWait
      )(child, {
        platform,
        processGroup: platform !== 'win32',
        signal: 'SIGKILL',
        waitMs: limits.terminationWaitMs ?? DEFAULT_TERMINATION_WAIT_MS
      }).then(
        () => {
          settled = true
          resolve({ ok: false, reason })
        },
        () => {
          settled = true
          resolve({ ok: false, reason })
        }
      )
    }
    const onAbort = (): void => failWithCleanup('cancelled')
    const timeout = setTimeout(
      () => failWithCleanup('timeout'),
      limits.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })

    const collect = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += value.byteLength
      if (outputBytes > (limits.probeOutputLimit ?? DEFAULT_PROBE_OUTPUT_LIMIT)) {
        failWithCleanup('output-limit')
        return
      }
      output += value.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish({ ok: false, reason: 'spawn' }))
    child.once('close', (code: unknown) => {
      if (cleaning) {
        return
      }
      finish(
        code === 0
          ? { ok: true, output }
          : { ok: false, reason: 'exit' }
      )
    })
  })
}

export type LocalToolExecutableInspectionOptions = LocalToolProbeLimits & {
  baseEnvironment: NodeJS.ProcessEnv
  managedElectron?: boolean
}

/**
 * Runs an executable once to confirm it is a usable Node.js or Python 3.
 * Used only for explicit user actions (choosing a path, scanning candidates),
 * never while building the launch environment.
 */
export async function inspectLocalToolExecutable(
  kind: LocalToolKind,
  executablePath: string,
  options: LocalToolExecutableInspectionOptions,
  dependencies: LocalToolEnvironmentDependencies = {}
): Promise<LocalToolCandidate | undefined> {
  const path = await canonicalFile(executablePath)
  if (!path) {
    return undefined
  }
  const script =
    kind === 'node'
      ? 'console.log(JSON.stringify({version:process.versions.node,architecture:process.arch}))'
      : [
          'import json, platform, sys',
          'print(json.dumps({"version": platform.python_version(), "architecture": platform.machine()}))'
        ].join(';')
  const probe = await probeExecutable(
    path,
    kind === 'node' ? ['-e', script] : ['-I', '-c', script],
    runtimeProbeEnvironment(
      options.baseEnvironment,
      options.managedElectron === true
    ),
    options,
    dependencies
  )
  if (!probe.ok) {
    if (probe.reason === 'cancelled') {
      throw abortError(options.signal!)
    }
    return undefined
  }
  try {
    const parsed = JSON.parse(probe.output.trim()) as {
      version?: unknown
      architecture?: unknown
    }
    if (
      typeof parsed.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(parsed.version) ||
      (kind === 'python' && !parsed.version.startsWith('3.')) ||
      typeof parsed.architecture !== 'string'
    ) {
      return undefined
    }
    const architecture = parsed.architecture.trim().toLocaleLowerCase()
    if (!/^[0-9a-z][0-9a-z._-]{0,63}$/u.test(architecture)) {
      return undefined
    }
    return {
      kind,
      executablePath: path,
      version: parsed.version,
      architecture
    }
  } catch {
    return undefined
  }
}

function runtimeProbeEnvironment(
  base: NodeJS.ProcessEnv,
  managedElectron: boolean
): NodeJS.ProcessEnv {
  const environment = { ...base }
  for (const key of Object.keys(environment)) {
    if (
      [
        'electron_run_as_node',
        'node_options',
        'node_path',
        'pythonhome',
        'pythoninspect',
        'pythonpath',
        'pythonstartup',
        'pythonwarnings'
      ].includes(key.toLocaleLowerCase())
    ) {
      delete environment[key]
    }
  }
  if (managedElectron) {
    environment.ELECTRON_RUN_AS_NODE = '1'
  }
  return environment
}

function adjacentPackageManagerNames(
  name: 'npm' | 'npx',
  platform: NodeJS.Platform
): readonly string[] {
  return platform === 'win32'
    ? [`${name}.cmd`, `${name}.exe`, `${name}-cli.js`]
    : [name, `${name}-cli.js`]
}

async function adjacentPackageManager(
  name: 'npm' | 'npx',
  nodePath: string,
  platform: NodeJS.Platform
): Promise<{ path: string; cli: boolean } | undefined> {
  for (const fileName of adjacentPackageManagerNames(name, platform)) {
    const path = await canonicalFile(join(dirname(nodePath), fileName))
    if (path) {
      return { path, cli: fileName.endsWith('-cli.js') }
    }
  }
  return undefined
}

function shimFileName(name: LocalToolName, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.cmd` : name
}

function commandLines(input: {
  platform: NodeJS.Platform
  command: string
  argsPrefix?: readonly string[]
  managedElectron?: boolean
  packageManagerPath?: string
  nodePath?: string
}): string {
  const prefix = input.argsPrefix ?? []
  if (input.platform === 'win32') {
    const lines = ['@echo off', 'setlocal']
    if (input.managedElectron) {
      lines.push('set "ELECTRON_RUN_AS_NODE=1"')
    }
    if (input.packageManagerPath && input.nodePath) {
      lines.push(
        `set "npm_execpath=${input.packageManagerPath.replaceAll('%', '%%')}"`
      )
      lines.push(
        `set "npm_node_execpath=${input.nodePath.replaceAll('%', '%%')}"`
      )
    }
    lines.push(
      [quoteCmd(input.command), ...prefix.map(quoteCmd), '%*'].join(' ')
    )
    return `${lines.join('\r\n')}\r\n`
  }
  const assignments: string[] = []
  if (input.managedElectron) {
    assignments.push('ELECTRON_RUN_AS_NODE=1')
  }
  if (input.packageManagerPath && input.nodePath) {
    assignments.push(`npm_execpath=${quotePosix(input.packageManagerPath)}`)
    assignments.push(`npm_node_execpath=${quotePosix(input.nodePath)}`)
  }
  return [
    '#!/bin/sh',
    `${assignments.length ? `${assignments.join(' ')} ` : ''}exec ${quotePosix(
      input.command
    )}${prefix.length ? ` ${prefix.map(quotePosix).join(' ')}` : ''} "$@"`,
    ''
  ].join('\n')
}

/**
 * An explicit choice whose program is missing must fail loudly instead of
 * silently falling through to whatever the user's PATH provides.
 */
function unavailableCommandLines(
  platform: NodeJS.Platform,
  name: LocalToolName,
  reason: string
): string {
  const message = `GoodBuddy: ${name} is unavailable: ${reason}. Change it in Settings > Tool execution environment.`
  return platform === 'win32'
    ? `@echo off\r\necho ${message.replace(/[&|<>^%]/gu, '')} 1>&2\r\nexit /b 127\r\n`
    : `#!/bin/sh\necho ${quotePosix(message)} >&2\nexit 127\n`
}

async function writeShim(
  path: string,
  content: string,
  platform: NodeJS.Platform
): Promise<void> {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o700 })
  if (platform !== 'win32') {
    await chmod(path, 0o700)
  }
}

function pathSeparator(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

function inheritedPath(environment: NodeJS.ProcessEnv): string {
  return environment.PATH ?? environment.Path ?? environment.path ?? ''
}

const windowsStoreAliasDirectory = /[\\/]microsoft[\\/]windowsapps[\\/]?$/iu

/** Microsoft Store app execution aliases are installer stubs, not programs. */
export function isWindowsStoreAlias(path: string): boolean {
  return windowsStoreAliasDirectory.test(dirname(path))
}

function pythonExecutableNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['python3', 'python']
}

function isUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string): string => {
    const trimmed = value.replace(/[\\/]+$/u, '')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const child = normalize(path)
  const parent = normalize(root)
  return child === parent || child.startsWith(`${parent}${platform === 'win32' ? '\\' : '/'}`)
}

const goodBuddyWrapperDirectory = /[\\/]goodbuddy[\\/]tool-environment[\\/]bin(?:[\\/]|$)/iu

function isGoodBuddyWrapperDirectory(
  directory: string,
  binDirectory: string,
  platform: NodeJS.Platform
): boolean {
  return (
    isUnder(directory, binDirectory, platform) ||
    goodBuddyWrapperDirectory.test(directory)
  )
}

/**
 * Removes wrapper directories inherited from a GoodBuddy process (for example
 * when GoodBuddy was started from a terminal that GoodBuddy itself opened).
 * They would otherwise be mistaken for the user's own installations.
 */
export function withoutGoodBuddyWrappers(
  userPath: string,
  binDirectory: string,
  platform: NodeJS.Platform
): string {
  const separator = pathSeparator(platform)
  return userPath
    .split(separator)
    .filter(
      (entry) =>
        !isGoodBuddyWrapperDirectory(entry.trim(), binDirectory, platform)
    )
    .join(separator)
}

/**
 * The first real Python in PATH order, then in the common install locations.
 * Uses only `stat`: Microsoft Store stubs and GoodBuddy's own wrappers are
 * skipped, and nothing is executed.
 */
export async function findUserPython(
  userPath: string,
  searchDirectories: readonly string[],
  platform: NodeJS.Platform,
  excludedRoot: string
): Promise<string | undefined> {
  const directories = [
    ...userPath.split(pathSeparator(platform)),
    ...searchDirectories
  ]
  const seen = new Set<string>()
  for (const raw of directories) {
    const directory = raw.trim().replace(/^"(.*)"$/u, '$1')
    if (!directory || !isAbsolute(directory)) continue
    const key = platform === 'win32' ? directory.toLowerCase() : directory
    if (seen.has(key)) continue
    seen.add(key)
    if (
      isGoodBuddyWrapperDirectory(directory, excludedRoot, platform) ||
      (platform === 'win32' && windowsStoreAliasDirectory.test(directory))
    ) {
      continue
    }
    for (const name of pythonExecutableNames(platform)) {
      const candidate = join(directory, name)
      try {
        const metadata = await stat(candidate)
        if (
          metadata.isFile() &&
          (platform === 'win32' || (metadata.mode & 0o111) !== 0)
        ) {
          return (await canonicalFile(candidate)) ?? candidate
        }
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

/**
 * `front` + user PATH + `fallback`. On Windows the fallback directory is
 * placed before the Microsoft Store `WindowsApps` aliases, which are
 * installer stubs that would otherwise shadow the built-in Python.
 */
export function buildLaunchPath(
  frontDirectory: string,
  fallbackDirectory: string,
  userPath: string,
  platform: NodeJS.Platform
): string {
  const separator = pathSeparator(platform)
  const entries = userPath.split(separator).filter((entry) => entry !== '')
  const storeIndex =
    platform === 'win32'
      ? entries.findIndex((entry) =>
          windowsStoreAliasDirectory.test(entry.trim())
        )
      : -1
  const tail =
    storeIndex >= 0
      ? [
          ...entries.slice(0, storeIndex),
          fallbackDirectory,
          ...entries.slice(storeIndex)
        ]
      : [...entries, fallbackDirectory]
  return [frontDirectory, ...tail].join(separator)
}

/**
 * Writes the wrapper scripts for the current settings. This never runs any
 * executable: in automatic mode the operating system's own PATH lookup picks
 * the user's installation first and reaches the fallback wrappers only when
 * the user's PATH has none.
 */
export async function createLocalToolEnvironment(
  options: LocalToolEnvironmentOptions,
  dependencies: LocalToolEnvironmentDependencies = {}
): Promise<LocalToolEnvironment> {
  if (!isAbsolute(options.binDirectory)) {
    throw new Error('Local tool bin directory must be absolute.')
  }
  const platform = dependencies.platform ?? process.platform
  const base = options.baseEnvironment ?? process.env
  const directories = {
    front: join(options.binDirectory, 'front'),
    fallback: join(options.binDirectory, 'fallback')
  } as const
  // The directories are stable so PATH does not change between rebuilds;
  // stale wrappers from earlier settings are removed instead.
  for (const directory of Object.values(directories)) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (platform !== 'win32') {
      await chmod(directory, 0o700)
    }
    await Promise.all(
      localToolNames.map((name) =>
        rm(join(directory, shimFileName(name, platform)), { force: true })
      )
    )
  }

  const shims: Partial<Record<LocalToolName, LocalToolShim>> = {}
  const write = async (
    shim: Omit<LocalToolShim, 'shimPath'>,
    content: string
  ): Promise<void> => {
    const shimPath = join(
      directories[shim.placement],
      shimFileName(shim.name, platform)
    )
    await writeShim(shimPath, content, platform)
    shims[shim.name] = { ...shim, shimPath }
  }
  const placementFor = (
    selection: LocalToolRuntimeSelection
  ): LocalToolShim['placement'] =>
    selection.source === 'auto' ? 'fallback' : 'front'

  // Node.js and its package managers.
  const nodeSelection = options.nodeSelection
  if (nodeSelection.source === 'custom') {
    const node = await canonicalFile(nodeSelection.executablePath)
    if (!node) {
      for (const name of ['node', 'npm', 'npx'] as const) {
        await write(
          { name, origin: 'custom', placement: 'front' },
          unavailableCommandLines(platform, name, 'the selected Node.js executable is missing')
        )
      }
    } else {
      await write(
        { name: 'node', target: node, origin: 'custom', placement: 'front' },
        commandLines({ platform, command: node })
      )
      for (const name of ['npm', 'npx'] as const) {
        const manager = await adjacentPackageManager(name, node, platform)
        if (!manager) continue
        await write(
          { name, target: manager.path, origin: 'custom', placement: 'front' },
          commandLines({
            platform,
            command: manager.cli ? node : manager.path,
            argsPrefix: manager.cli ? [manager.path] : [],
            packageManagerPath: manager.path,
            nodePath: node
          })
        )
      }
    }
  } else {
    const placement = placementFor(nodeSelection)
    const electron = dependencies.electronExecutablePath ?? process.execPath
    await write(
      { name: 'node', target: electron, origin: 'managed', placement },
      commandLines({ platform, command: electron, managedElectron: true })
    )
    for (const [name, cliPath] of [
      ['npm', options.packagedNpmCliPath],
      ['npx', options.packagedNpxCliPath]
    ] as const) {
      const cli = await canonicalFile(cliPath)
      if (!cli) continue
      await write(
        { name, target: cli, origin: 'managed', placement },
        commandLines({
          platform,
          command: electron,
          argsPrefix: [cli],
          managedElectron: true,
          packageManagerPath: cli,
          nodePath: electron
        })
      )
    }
  }

  // Python and pip. Unlike Node, automatic mode cannot rely on PATH order
  // alone: on Windows the Microsoft Store stub `python.exe` is usually on
  // PATH and would win, and real installations such as Conda are often not
  // on PATH at all. So the user's own Python is located with `stat` (PATH
  // order first, then common install locations) and placed in front.
  const pythonSelection = options.pythonSelection
  const managedPython = options.managedPythonExecutablePath
    ? await canonicalFile(options.managedPythonExecutablePath)
    : undefined
  let python: string | undefined
  let pythonOrigin: LocalToolOrigin
  let pythonPlacement: LocalToolShim['placement']
  if (pythonSelection.source === 'custom') {
    python = await canonicalFile(pythonSelection.executablePath)
    pythonOrigin = 'custom'
    pythonPlacement = 'front'
  } else if (pythonSelection.source === 'managed') {
    python = managedPython
    pythonOrigin = 'managed'
    pythonPlacement = 'front'
  } else {
    const userPython = await findUserPython(
      inheritedPath(base),
      options.pythonSearchDirectories ?? [],
      platform,
      options.binDirectory
    )
    python = userPython ?? managedPython
    pythonOrigin = userPython ? 'system' : 'managed'
    pythonPlacement = userPython ? 'front' : 'fallback'
  }
  if (!python && pythonSelection.source !== 'auto') {
    const reason =
      pythonSelection.source === 'custom'
        ? 'the selected Python executable is missing'
        : 'the built-in Python is not installed'
    for (const name of ['python', 'python3', 'pip'] as const) {
      await write(
        { name, origin: pythonOrigin, placement: 'front' },
        unavailableCommandLines(platform, name, reason)
      )
    }
  }
  if (python) {
    const placement = pythonPlacement
    const origin = pythonOrigin
    for (const name of ['python', 'python3'] as const) {
      await write(
        { name, target: python, origin, placement },
        commandLines({ platform, command: python })
      )
    }
    // pip is always `<the same interpreter> -m pip`, so it can never belong
    // to a different Python than `python`.
    await write(
      { name: 'pip', target: python, origin, placement },
      commandLines({ platform, command: python, argsPrefix: ['-m', 'pip'] })
    )
  }

  return {
    binDirectory: options.binDirectory,
    environment: Object.freeze({
      PATH: buildLaunchPath(
        directories.front,
        directories.fallback,
        withoutGoodBuddyWrappers(inheritedPath(base), options.binDirectory, platform),
        platform
      )
    }),
    shims: Object.freeze(shims)
  }
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

/**
 * Finds a command the way the operating system would, using only `stat`.
 */
export async function resolveCommandOnPath(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform,
  pathExtensions = '.COM;.EXE;.BAT;.CMD'
): Promise<string | undefined> {
  const extensions =
    platform === 'win32'
      ? pathExtensions
          .split(';')
          .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension))
      : ['']
  for (const raw of pathValue.split(pathSeparator(platform))) {
    const directory = raw.trim().replace(/^"(.*)"$/u, '$1')
    if (!directory || !isAbsolute(directory)) continue
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        const metadata = await stat(candidate)
        if (
          metadata.isFile() &&
          (platform === 'win32' || (metadata.mode & 0o111) !== 0)
        ) {
          return candidate
        }
      } catch {
        // Not in this directory.
      }
    }
  }
  return undefined
}

export type ResolvedLocalTool = {
  /** What the operating system runs: a system executable or a wrapper. */
  command: string
  /** The real program behind it; absent when the chosen program is missing. */
  executablePath?: string
  origin: LocalToolOrigin
}

export async function resolveLocalTool(
  name: LocalToolName,
  environment: LocalToolEnvironment,
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Promise<ResolvedLocalTool | undefined> {
  const command = await resolveCommandOnPath(
    name,
    inheritedPath(environment.environment),
    platform,
    baseEnvironment.PATHEXT
  )
  if (!command) return undefined
  const shim = Object.values(environment.shims).find(
    (candidate) => candidate && samePath(candidate.shimPath, command, platform)
  )
  if (!shim) {
    if (platform === 'win32' && isWindowsStoreAlias(command)) return undefined
    const executablePath = (await canonicalFile(command)) ?? command
    return { command: executablePath, executablePath, origin: 'system' }
  }
  return {
    command,
    ...(shim.target ? { executablePath: shim.target } : {}),
    origin: shim.origin
  }
}

/**
 * Reports which program each command actually resolves to and its version.
 * Runs each resolved command once with `--version`; only called on explicit
 * request (opening settings, re-detecting, or after a settings change).
 */
export async function detectLocalTools(
  environment: LocalToolEnvironment,
  selections: Readonly<Record<LocalToolKind, LocalToolRuntimeSelection>>,
  baseEnvironment: NodeJS.ProcessEnv,
  limits: LocalToolProbeLimits = {},
  dependencies: LocalToolEnvironmentDependencies = {}
): Promise<Record<LocalToolName, LocalToolDiagnostic>> {
  const platform = dependencies.platform ?? process.platform
  const probeEnvironment: NodeJS.ProcessEnv = runtimeProbeEnvironment(
    baseEnvironment,
    false
  )
  for (const key of Object.keys(probeEnvironment)) {
    if (key.toLowerCase() === 'path') {
      delete probeEnvironment[key]
    }
  }
  probeEnvironment.PATH = inheritedPath(environment.environment)
  const entries = await Promise.all(
    localToolNames.map(async (name) => {
      const kind: LocalToolKind = ['node', 'npm', 'npx'].includes(name)
        ? 'node'
        : 'python'
      const source = selections[kind].source
      const resolved = await resolveLocalTool(
        name,
        environment,
        baseEnvironment,
        platform
      )
      if (!resolved || !resolved.executablePath) {
        const diagnostic: LocalToolDiagnostic = {
          available: false,
          source,
          ...(resolved ? { origin: resolved.origin } : {}),
          detail: `${name} was not found.`
        }
        return [name, diagnostic] as const
      }
      const probe = await probeExecutable(
        resolved.command,
        ['--version'],
        probeEnvironment,
        limits,
        dependencies
      )
      if (!probe.ok && probe.reason === 'cancelled') {
        throw abortError(limits.signal!)
      }
      const diagnostic: LocalToolDiagnostic = probe.ok
        ? {
            available: true,
            source,
            origin: resolved.origin,
            version: safeVersion(probe.output),
            executablePath: resolved.executablePath,
            detail: `${name} is ready.`
          }
        : {
            available: false,
            source,
            origin: resolved.origin,
            executablePath: resolved.executablePath,
            detail: `${name} was found but could not run (${probe.reason}).`
          }
      return [name, diagnostic] as const
    })
  )
  return Object.fromEntries(entries) as Record<LocalToolName, LocalToolDiagnostic>
}

export function resolveNpmCliPaths(input: {
  appPath: string
  resourcesPath: string
  packaged: boolean
}): { npmCliPath: string; npxCliPath: string } {
  const bin = input.packaged
    ? join(input.resourcesPath, 'runtimes', 'npm', 'bin')
    : join(input.appPath, 'node_modules', 'npm', 'bin')
  return {
    npmCliPath: join(bin, 'npm-cli.js'),
    npxCliPath: join(bin, 'npx-cli.js')
  }
}
