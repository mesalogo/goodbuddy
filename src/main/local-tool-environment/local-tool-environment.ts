import { chmod, mkdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import spawn from 'cross-spawn'
import type {
  LocalToolCandidate,
  LocalToolKind,
  LocalToolRuntimeSelection
} from '../../shared/local-tool-environment-contracts'
import {
  terminateProcessTreeAndWait,
  type WaitableProcessTreeChild
} from '../agent/child-process-termination'

const DEFAULT_PROBE_TIMEOUT_MS = 3_000
const DEFAULT_PROBE_OUTPUT_LIMIT = 8 * 1024
const DEFAULT_TERMINATION_WAIT_MS = 500

export type LocalToolName =
  | 'node'
  | 'npm'
  | 'npx'
  | 'python'
  | 'python3'
  | 'pip'

export type LocalToolSource = LocalToolRuntimeSelection['source']

export type LocalToolDiagnostic = {
  available: boolean
  source: LocalToolSource
  version?: string
  executablePath?: string
  shimPath?: string
  detail: string
}

export type LocalToolEnvironmentDiagnostics = {
  binDirectory: string
  tools: Readonly<Record<LocalToolName, LocalToolDiagnostic>>
  warnings: readonly string[]
}

export type LocalToolEnvironment = {
  binDirectory: string
  environment: Readonly<NodeJS.ProcessEnv>
  diagnostics: LocalToolEnvironmentDiagnostics
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
  signal?: AbortSignal
  probeTimeoutMs?: number
  probeOutputLimit?: number
  terminationWaitMs?: number
}

export type LocalToolEnvironmentDependencies = {
  platform?: NodeJS.Platform
  electronExecutablePath?: string
  spawnProcess?: LocalToolProbeSpawn
  terminateProcessTree?: typeof terminateProcessTreeAndWait
}

type ProbeResult =
  | { ok: true; output: string }
  | {
      ok: false
      reason: 'cancelled' | 'exit' | 'output-limit' | 'spawn' | 'timeout'
    }

type ResolvedRuntime = {
  path: string
  source: LocalToolSource
  managedElectron?: boolean
  version?: string
}

type PackageManagerInvocation = {
  command: string
  argsPrefix: readonly string[]
  path: string
  source: LocalToolSource
  managedElectron?: boolean
  version?: string
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
  signal: AbortSignal | undefined,
  dependencies: LocalToolEnvironmentDependencies,
  options: LocalToolEnvironmentOptions
): Promise<ProbeResult> {
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
        waitMs: options.terminationWaitMs ?? DEFAULT_TERMINATION_WAIT_MS
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
      options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
    )
    signal?.addEventListener('abort', onAbort, { once: true })

    const collect = (chunk: Buffer | string): void => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += value.byteLength
      if (outputBytes > (options.probeOutputLimit ?? DEFAULT_PROBE_OUTPUT_LIMIT)) {
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

export type LocalToolExecutableInspectionOptions = {
  baseEnvironment: NodeJS.ProcessEnv
  managedElectron?: boolean
  signal?: AbortSignal
  probeTimeoutMs?: number
  probeOutputLimit?: number
  terminationWaitMs?: number
}

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
    options.signal,
    dependencies,
    {
      binDirectory: dirname(path),
      nodeSelection: { source: 'managed' },
      pythonSelection: { source: 'managed' },
      packagedNpmCliPath: path,
      packagedNpxCliPath: path,
      ...options
    }
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

async function resolveRuntime(
  kind: LocalToolKind,
  selection: LocalToolRuntimeSelection,
  managedExecutablePath: string | undefined,
  managedElectron: boolean,
  options: LocalToolEnvironmentOptions,
  dependencies: LocalToolEnvironmentDependencies,
  base: NodeJS.ProcessEnv
): Promise<ResolvedRuntime | undefined> {
  const selectedPath =
    selection.source === 'custom'
      ? selection.executablePath
      : managedExecutablePath
  if (!selectedPath) {
    return undefined
  }
  const inspected = await inspectLocalToolExecutable(
    kind,
    selectedPath,
    {
      baseEnvironment: base,
      managedElectron,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.probeTimeoutMs
        ? { probeTimeoutMs: options.probeTimeoutMs }
        : {}),
      ...(options.probeOutputLimit
        ? { probeOutputLimit: options.probeOutputLimit }
        : {}),
      ...(options.terminationWaitMs
        ? { terminationWaitMs: options.terminationWaitMs }
        : {})
    },
    dependencies
  )
  if (!inspected) {
    return undefined
  }
  return {
    path: inspected.executablePath,
    source: selection.source,
    managedElectron,
    version: inspected.version
  }
}

function adjacentPackageManagerNames(
  name: 'npm' | 'npx',
  platform: NodeJS.Platform
): readonly string[] {
  return platform === 'win32'
    ? [`${name}.cmd`, `${name}.exe`, `${name}-cli.js`]
    : [name, `${name}-cli.js`]
}

async function resolvePackageManager(
  name: 'npm' | 'npx',
  node: ResolvedRuntime,
  packagedCliPath: string,
  options: LocalToolEnvironmentOptions,
  dependencies: LocalToolEnvironmentDependencies,
  base: NodeJS.ProcessEnv
): Promise<PackageManagerInvocation | undefined> {
  const platform = dependencies.platform ?? process.platform
  const candidates =
    node.source === 'managed'
      ? [{ path: packagedCliPath, cli: true }]
      : adjacentPackageManagerNames(name, platform).map((fileName) => ({
          path: join(dirname(node.path), fileName),
          cli: fileName.endsWith('-cli.js')
        }))

  for (const candidate of candidates) {
    const path = await canonicalFile(candidate.path)
    if (!path) {
      continue
    }
    const command = candidate.cli ? node.path : path
    const argsPrefix = candidate.cli ? [path] : []
    const probe = await probeExecutable(
      command,
      [...argsPrefix, '--version'],
      runtimeProbeEnvironment(base, node.managedElectron === true),
      options.signal,
      dependencies,
      options
    )
    if (!probe.ok) {
      if (probe.reason === 'cancelled') {
        throw abortError(options.signal!)
      }
      continue
    }
    return {
      command,
      argsPrefix,
      path,
      source: node.source,
      managedElectron: node.managedElectron,
      version: safeVersion(probe.output)
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

function unavailable(
  source: LocalToolSource,
  detail: string,
  executablePath?: string
): LocalToolDiagnostic {
  return { available: false, source, executablePath, detail }
}

function available(
  source: LocalToolSource,
  executablePath: string,
  version: string | undefined,
  shimPath: string
): LocalToolDiagnostic {
  return {
    available: true,
    source,
    version,
    executablePath,
    shimPath,
    detail: `${source} tool is ready${version ? ` (${version})` : ''}.`
  }
}

function selectedPath(
  selection: LocalToolRuntimeSelection,
  managedPath: string | undefined
): string | undefined {
  return selection.source === 'custom'
    ? selection.executablePath
    : managedPath
}

function launchEnvironmentSnapshot(
  binDirectory: string,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Readonly<NodeJS.ProcessEnv> {
  const inheritedPath =
    source.PATH ?? source.Path ?? source.path ?? ''
  const path = inheritedPath
    ? `${binDirectory}${platform === 'win32' ? ';' : ':'}${inheritedPath}`
    : binDirectory
  return Object.freeze({ PATH: path })
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

export async function createLocalToolEnvironment(
  options: LocalToolEnvironmentOptions,
  dependencies: LocalToolEnvironmentDependencies = {}
): Promise<LocalToolEnvironment> {
  if (!isAbsolute(options.binDirectory)) {
    throw new Error('Local tool bin directory must be absolute.')
  }
  options.signal?.throwIfAborted()
  const platform = dependencies.platform ?? process.platform
  const base = { ...(options.baseEnvironment ?? process.env) }
  delete base.ELECTRON_RUN_AS_NODE
  const warnings: string[] = []
  await mkdir(options.binDirectory, { recursive: true, mode: 0o700 })
  if (platform !== 'win32') {
    await chmod(options.binDirectory, 0o700)
  }

  const shimPaths = Object.fromEntries(
    (['node', 'npm', 'npx', 'python', 'python3', 'pip'] as const).map(
      (name) => [name, join(options.binDirectory, shimFileName(name, platform))]
    )
  ) as Record<LocalToolName, string>
  await Promise.all(
    Object.values(shimPaths).map((path) =>
      unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          throw error
        }
      })
    )
  )

  const managedNodePath =
    dependencies.electronExecutablePath ?? process.execPath
  const [node, python] = await Promise.all([
    resolveRuntime(
      'node',
      options.nodeSelection,
      managedNodePath,
      options.nodeSelection.source === 'managed',
      options,
      dependencies,
      base
    ),
    resolveRuntime(
      'python',
      options.pythonSelection,
      options.managedPythonExecutablePath,
      false,
      options,
      dependencies,
      base
    )
  ])
  options.signal?.throwIfAborted()

  const nodeSelectedPath = selectedPath(
    options.nodeSelection,
    managedNodePath
  )
  const pythonSelectedPath = selectedPath(
    options.pythonSelection,
    options.managedPythonExecutablePath
  )
  const diagnostics: Record<LocalToolName, LocalToolDiagnostic> = {
    node: unavailable(
      options.nodeSelection.source,
      'The selected Node runtime is unavailable or failed its version probe.',
      nodeSelectedPath
    ),
    npm: unavailable(
      options.nodeSelection.source,
      'No verified npm from the selected Node installation is available.'
    ),
    npx: unavailable(
      options.nodeSelection.source,
      'No verified npx from the selected Node installation is available.'
    ),
    python: unavailable(
      options.pythonSelection.source,
      'The selected Python runtime is not installed, invalid, or failed its version probe.',
      pythonSelectedPath
    ),
    python3: unavailable(
      options.pythonSelection.source,
      'The selected Python runtime is not installed, invalid, or failed its version probe.',
      pythonSelectedPath
    ),
    pip: unavailable(
      options.pythonSelection.source,
      'The selected Python runtime does not provide a verified pip module.',
      pythonSelectedPath
    )
  }

  if (node) {
    await writeShim(
      shimPaths.node,
      commandLines({
        platform,
        command: node.path,
        managedElectron: node.managedElectron
      }),
      platform
    )
    diagnostics.node = available(
      node.source,
      node.path,
      node.version,
      shimPaths.node
    )

    const [npm, npx] = await Promise.all([
      resolvePackageManager(
        'npm',
        node,
        options.packagedNpmCliPath,
        options,
        dependencies,
        base
      ),
      resolvePackageManager(
        'npx',
        node,
        options.packagedNpxCliPath,
        options,
        dependencies,
        base
      )
    ])
    options.signal?.throwIfAborted()
    for (const [name, manager] of [
      ['npm', npm],
      ['npx', npx]
    ] as const) {
      if (!manager) {
        continue
      }
      await writeShim(
        shimPaths[name],
        commandLines({
          platform,
          command: manager.command,
          argsPrefix: manager.argsPrefix,
          managedElectron: manager.managedElectron,
          packageManagerPath: manager.path,
          nodePath: node.path
        }),
        platform
      )
      diagnostics[name] = available(
        manager.source,
        manager.path,
        manager.version,
        shimPaths[name]
      )
    }
  }

  if (python) {
    for (const name of ['python', 'python3'] as const) {
      await writeShim(
        shimPaths[name],
        commandLines({ platform, command: python.path }),
        platform
      )
      diagnostics[name] = available(
        python.source,
        python.path,
        python.version,
        shimPaths[name]
      )
    }
    const pipProbe = await probeExecutable(
      python.path,
      ['-m', 'pip', '--version'],
      base,
      options.signal,
      dependencies,
      options
    )
    options.signal?.throwIfAborted()
    if (pipProbe.ok) {
      await writeShim(
        shimPaths.pip,
        commandLines({
          platform,
          command: python.path,
          argsPrefix: ['-m', 'pip']
        }),
        platform
      )
      diagnostics.pip = available(
        python.source,
        python.path,
        safeVersion(pipProbe.output),
        shimPaths.pip
      )
    }
  }

  return {
    binDirectory: options.binDirectory,
    environment: launchEnvironmentSnapshot(
      options.binDirectory,
      base,
      platform
    ),
    diagnostics: {
      binDirectory: options.binDirectory,
      tools: Object.freeze(diagnostics),
      warnings: Object.freeze(warnings)
    }
  }
}
