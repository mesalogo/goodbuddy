import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  normalize
} from 'node:path'
import spawn from 'cross-spawn'
import {
  terminateProcessTreeAndWait,
  type WaitableProcessTreeChild
} from './child-process-termination'
import { buildRuntimeEnvironment } from './process-environment'
import type {
  AgentRuntimeDetection,
  RuntimeBinaryDetection
} from '../../shared/contracts'

const VERSION_TIMEOUT_MS = 3_000
const VERSION_OUTPUT_LIMIT = 8 * 1024
const VERSION_TERMINATION_WAIT_MS = 500

export type RuntimeBinaryDiscoveryInput = {
  binaryPath: string
  bundledPath?: string
  validation?: 'execute' | 'canonical-file' | 'path-only'
  bundledValidation?: 'execute' | 'canonical-file'
  bundledVersion?: string
  allowAutomaticDiscovery?: boolean
  binaryNames: readonly string[]
  label: string
}

type VersionValidation =
  | { valid: true; version?: string }
  | { valid: false }

type RuntimeVersionOutput = {
  on(
    event: 'data',
    listener: (chunk: Buffer | string) => void
  ): unknown
}

export type RuntimeVersionProcess = WaitableProcessTreeChild & {
  stdout?: RuntimeVersionOutput | null
  stderr?: RuntimeVersionOutput | null
}

export type RuntimeVersionSpawn = (
  command: string,
  args: string[],
  options: {
    detached: boolean
    env: NodeJS.ProcessEnv
    shell: false
    stdio: ['ignore', 'pipe', 'pipe']
    windowsHide: true
  }
) => RuntimeVersionProcess

export type RuntimeVersionValidationDependencies = {
  platform?: NodeJS.Platform
  spawnProcess?: RuntimeVersionSpawn
  terminateProcessTree?: typeof terminateProcessTreeAndWait
  timeoutMs?: number
  outputLimit?: number
  terminationWaitMs?: number
}

function stripUnsafeCharacters(value: string): string {
  let result = ''
  let inEscapeSequence = false
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (inEscapeSequence) {
      if (codePoint >= 64 && codePoint <= 126) {
        inEscapeSequence = false
      }
      continue
    }
    if (codePoint === 27) {
      inEscapeSequence = true
    } else if (codePoint >= 32 && codePoint !== 127) {
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

  const semanticVersion = firstLine.match(
    /\bv?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)\b/u
  )
  return (semanticVersion?.[1] ?? firstLine).slice(0, 160)
}

export function validateRuntimeVersion(
  binaryPath: string,
  dependencies: RuntimeVersionValidationDependencies = {}
): Promise<VersionValidation> {
  return new Promise((resolve) => {
    let settled = false
    let cleanupStarted = false
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const platform = dependencies.platform ?? process.platform
    const timeoutMs = dependencies.timeoutMs ?? VERSION_TIMEOUT_MS
    const outputLimit =
      dependencies.outputLimit ?? VERSION_OUTPUT_LIMIT

    const child = (dependencies.spawnProcess ?? spawn)(
      binaryPath,
      ['--version'],
      {
        detached: platform !== 'win32',
        env: buildRuntimeEnvironment({}),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )

    const finish = (result: VersionValidation): void => {
      if (settled || cleanupStarted) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }

    const failAfterCleanup = (): void => {
      if (settled || cleanupStarted) {
        return
      }
      cleanupStarted = true
      clearTimeout(timeout)
      void (
        dependencies.terminateProcessTree ??
        terminateProcessTreeAndWait
      )(child, {
        platform,
        processGroup: platform !== 'win32',
        signal: 'SIGKILL',
        waitMs:
          dependencies.terminationWaitMs ??
          VERSION_TERMINATION_WAIT_MS
      }).then(
        () => {
          settled = true
          resolve({ valid: false })
        },
        () => {
          settled = true
          resolve({ valid: false })
        }
      )
    }

    const timeout = setTimeout(() => {
      failAfterCleanup()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stdoutBytes += value.byteLength
      if (stdoutBytes > outputLimit) {
        failAfterCleanup()
        return
      }
      stdout += value.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      stderrBytes += value.byteLength
      if (stderrBytes > outputLimit) {
        failAfterCleanup()
        return
      }
      stderr += value.toString('utf8')
    })
    child.once('error', () => {
      if (cleanupStarted) {
        return
      }
      finish({ valid: false })
    })
    child.once('close', (code) => {
      if (cleanupStarted) {
        return
      }
      if (code !== 0) {
        finish({ valid: false })
        return
      }
      finish({
        valid: true,
        version: safeVersion(stdout || stderr)
      })
    })
  })
}

async function canonicalFile(filePath: string): Promise<string | undefined> {
  if (!isAbsolute(filePath)) {
    return undefined
  }

  try {
    const canonicalPath = await realpath(filePath)
    const metadata = await stat(canonicalPath)
    return metadata.isFile() && isAbsolute(canonicalPath)
      ? canonicalPath
      : undefined
  } catch {
    return undefined
  }
}

function windowsExtensions(): string[] {
  const configured = (process.env.PATHEXT ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => /^\.[A-Za-z0-9]+$/u.test(value))
  return [...new Set([...configured, '.COM', '.EXE', '.BAT', '.CMD'])]
}

function executableNames(binaryNames: readonly string[]): string[] {
  if (process.platform !== 'win32') {
    return [...binaryNames]
  }

  const extensions = windowsExtensions()
  return binaryNames.flatMap((name) =>
    extname(name)
      ? [name]
      : extensions.map((extension) => `${name}${extension}`)
  )
}

function pathDirectories(): string[] {
  const pathValue =
    process.env.PATH ?? process.env.Path ?? process.env.path ?? ''
  return pathValue
    .split(delimiter)
    .map((directory) => directory.trim())
    .filter((directory) => directory.length > 0 && isAbsolute(directory))
}

function trustedDirectories(): string[] {
  if (process.platform === 'win32') {
    const directories: string[] = []
    const appData = process.env.APPDATA
    if (appData && isAbsolute(appData)) {
      directories.push(join(appData, 'npm'))
    }
    return directories
  }

  const home = homedir()
  return [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/opt/homebrew/bin',
    '/opt/local/bin',
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin')
  ]
}

function automaticCandidates(binaryNames: readonly string[]): string[] {
  const names = executableNames(binaryNames)
  const candidates: string[] = []
  const seen = new Set<string>()

  for (const directory of [...pathDirectories(), ...trustedDirectories()]) {
    for (const name of names) {
      const candidate = join(directory, name)
      const key =
        process.platform === 'win32'
          ? normalize(candidate).toLowerCase()
          : normalize(candidate)
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

function availableDetection(
  label: string,
  path: string,
  version?: string,
  source: 'bundled' | 'configured' | 'automatic' = 'automatic'
): RuntimeBinaryDetection {
  return {
    available: true,
    path,
    version,
    source,
    detail: `${source === 'bundled' ? '内置 ' : ''}${label}${
      version ? ` ${version}` : ''
    } 已就绪`
  }
}

export async function detectRuntimeBinary(
  input: RuntimeBinaryDiscoveryInput
): Promise<RuntimeBinaryDetection> {
  const configuredPath = input.binaryPath.trim()
  let configuredPathProblem: 'relative' | 'invalid' | 'validation' | undefined

  const detectBundled = async (): Promise<
    RuntimeBinaryDetection | undefined
  > => {
    const bundledPath = input.bundledPath?.trim()
    if (!bundledPath) {
      return undefined
    }
    if (input.validation === 'path-only') {
      return isAbsolute(bundledPath)
        ? availableDetection(
            input.label,
            normalize(bundledPath),
            input.bundledVersion,
            'bundled'
          )
        : undefined
    }
    const canonicalPath = await canonicalFile(bundledPath)
    if (!canonicalPath) {
      return undefined
    }
    if (
      (input.bundledValidation ?? input.validation) ===
      'canonical-file'
    ) {
      return availableDetection(
        input.label,
        canonicalPath,
        input.bundledVersion,
        'bundled'
      )
    }
    const validation = await validateRuntimeVersion(canonicalPath)
    return validation.valid
      ? availableDetection(
          input.label,
          canonicalPath,
          validation.version,
          'bundled'
        )
      : undefined
  }

  if (configuredPath) {
    if (!isAbsolute(configuredPath)) {
      configuredPathProblem = 'relative'
    } else if (input.validation === 'path-only') {
      return availableDetection(
        input.label,
        normalize(configuredPath),
        undefined,
        'configured'
      )
    } else {
      const canonicalPath = await canonicalFile(configuredPath)
      if (!canonicalPath) {
        configuredPathProblem = 'invalid'
      } else if (input.validation === 'canonical-file') {
        return availableDetection(
          input.label,
          canonicalPath,
          undefined,
          'configured'
        )
      } else {
        const validation = await validateRuntimeVersion(canonicalPath)
        if (validation.valid) {
          return availableDetection(
            input.label,
            canonicalPath,
            validation.version,
            'configured'
          )
        }
        configuredPathProblem = 'validation'
      }
    }
  }

  const bundled = await detectBundled()
  if (bundled) {
    return bundled
  }

  let foundAutomaticCandidate = false
  if (input.allowAutomaticDiscovery !== false) {
    for (const candidate of automaticCandidates(input.binaryNames)) {
      const canonicalPath = await canonicalFile(candidate)
      if (!canonicalPath) {
        continue
      }
      foundAutomaticCandidate = true
      if (
        input.validation === 'canonical-file' ||
        input.validation === 'path-only'
      ) {
        return availableDetection(
          input.label,
          canonicalPath
        )
      }
      const validation = await validateRuntimeVersion(canonicalPath)
      if (validation.valid) {
        return availableDetection(
          input.label,
          canonicalPath,
          validation.version,
          'automatic'
        )
      }
    }
  }

  let detail: string
  if (foundAutomaticCandidate || configuredPathProblem === 'validation') {
    detail = `${input.label} 候选未通过 --version 安全验证`
  } else if (configuredPathProblem === 'relative') {
    detail = `${input.label} 自定义路径必须为绝对路径，且未自动检测到可用安装`
  } else if (configuredPathProblem === 'invalid') {
    detail = `${input.label} 自定义路径不是普通文件，且未自动检测到可用安装`
  } else {
    detail = `未自动检测到 ${input.label}，请配置绝对二进制路径`
  }

  return {
    available: false,
    detail
  }
}

export async function detectAgentRuntimes(input: {
  opencodeBinaryPath: string
  continueBinaryPath: string
  bundledPaths?: {
    opencode: string
    continue: string
    deepseekHarness: string
  }
  bundledVersions?: {
    continue: string
    deepseekHarness: string
  }
}): Promise<AgentRuntimeDetection> {
  const [opencode, continueRuntime, deepseekHarness] = await Promise.all([
    detectRuntimeBinary({
      binaryPath: input.opencodeBinaryPath,
      bundledPath: input.bundledPaths?.opencode,
      binaryNames: ['opencode'],
      label: 'OpenCode CLI'
    }),
    detectRuntimeBinary({
      binaryPath: input.continueBinaryPath,
      bundledPath: input.bundledPaths?.continue,
      bundledValidation: 'canonical-file',
      bundledVersion: input.bundledVersions?.continue,
      binaryNames: ['cn'],
      label: 'Continue CLI'
    }),
    detectRuntimeBinary({
      binaryPath: '',
      bundledPath: input.bundledPaths?.deepseekHarness,
      bundledValidation: 'canonical-file',
      bundledVersion: input.bundledVersions?.deepseekHarness,
      allowAutomaticDiscovery: false,
      binaryNames: [],
      label: 'GoodBuddy DeepSeek Harness Host'
    })
  ])

  return {
    opencode,
    continue: continueRuntime,
    deepseekHarness
  }
}
