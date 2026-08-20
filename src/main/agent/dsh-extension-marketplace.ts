import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  readFile,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  delimiter,
  join,
  posix,
  relative
} from 'node:path'
import spawn from 'cross-spawn'
import { z } from 'zod'
import {
  runtimeExtensionCatalogEntrySchema,
  runtimeExtensionIntegritySchema,
  runtimeExtensionPackageNameSchema,
  runtimeExtensionVersionSchema,
  type RuntimeExtensionCatalogEntry
} from '../../shared/runtime-extension-contracts'
import { buildControlledHarnessEnvironment } from './process-environment'
import type {
  RuntimeExtensionCatalog,
  RuntimeExtensionStoreDependencies
} from './runtime-extension-store'
import { terminateProcessTreeAndWait } from './child-process-termination'

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
const NPM_SEARCH_PAGE_SIZE = 250
const MAXIMUM_CATALOG_ENTRIES = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000
const MAXIMUM_PROCESS_OUTPUT_CHARACTERS = 64 * 1024
const MAXIMUM_PACKUMENT_VERSIONS = 20_000

const npmSearchPackageSchema = z
  .object({
    name: runtimeExtensionPackageNameSchema,
    version: runtimeExtensionVersionSchema,
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    license: z.string().optional(),
    links: z
      .object({
        homepage: z.string().optional(),
        repository: z.string().optional(),
        npm: z.string().optional()
      })
      .passthrough()
      .optional()
  })
  .passthrough()

const npmSearchResponseSchema = z
  .object({
    total: z.number().int().nonnegative(),
    objects: z.array(
      z
        .object({
          package: npmSearchPackageSchema
        })
        .passthrough()
    )
  })
  .passthrough()

const npmDistributionSchema = z
  .object({
    integrity: runtimeExtensionIntegritySchema
  })
  .passthrough()

const npmInstalledManifestSchema = z
  .object({
    name: runtimeExtensionPackageNameSchema,
    version: runtimeExtensionVersionSchema,
    main: z.string().optional(),
    exports: z.unknown().optional(),
    dsh: z
      .object({
        bundle: z
          .object({
            patch: z.string().min(1)
          })
          .passthrough()
      })
      .passthrough()
  })
  .passthrough()

const npmVersionManifestSchema = npmInstalledManifestSchema.extend({
  dist: npmDistributionSchema
})

function isPlainObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const npmPackumentVersionsSchema = z
  .custom<Record<string, unknown>>(isPlainObject, {
    message: 'npm packument versions must be a plain object'
  })
  .superRefine((versions, context) => {
    const keys = Object.keys(versions)
    if (keys.length > MAXIMUM_PACKUMENT_VERSIONS) {
      context.addIssue({
        code: 'too_big',
        origin: 'object',
        maximum: MAXIMUM_PACKUMENT_VERSIONS,
        inclusive: true,
        path: [],
        message: 'npm packument contains too many versions'
      })
    }
    if (
      keys.some(
        (key) =>
          key === '__proto__' ||
          key === 'prototype' ||
          key === 'constructor'
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: [],
        message: 'npm packument contains an unsafe version key'
      })
    }
  })

const npmPackumentSchema = z
  .custom<Record<string, unknown>>(isPlainObject, {
    message: 'npm packument must be a plain object'
  })
  .pipe(
    z
      .object({
        versions: npmPackumentVersionsSchema
      })
      .passthrough()
  )

type NpmVersionManifest = z.infer<typeof npmVersionManifestSchema>

export type PackageManagerRunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type PackageManagerRunner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    signal?: AbortSignal
  }
) => Promise<PackageManagerRunResult>

async function terminatePackageManager(
  child: ReturnType<typeof spawn>
): Promise<void> {
  await terminateProcessTreeAndWait(child, {
    processGroup: true,
    signal: 'SIGKILL',
    waitMs: 5_000
  })
}

function boundedAppend(current: string, chunk: unknown): string {
  const next = current + String(chunk)
  return next.length <= MAXIMUM_PROCESS_OUTPUT_CHARACTERS
    ? next
    : next.slice(-MAXIMUM_PROCESS_OUTPUT_CHARACTERS)
}

export const runPackageManager: PackageManagerRunner = (
  command,
  args,
  options
) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('DSH 插件安装已取消')
      )
      return
    }
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let terminating = false
    const onStdout = (chunk: unknown): void => {
      stdout = boundedAppend(stdout, chunk)
    }
    const onStderr = (chunk: unknown): void => {
      stderr = boundedAppend(stderr, chunk)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
    }
    const settleRejected = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const terminateAndReject = (error: Error): void => {
      if (settled || terminating) {
        return
      }
      terminating = true
      void terminatePackageManager(child).then(
        () => settleRejected(error),
        () => settleRejected(error)
      )
    }
    const onAbort = (): void => {
      terminateAndReject(
        options.signal?.reason instanceof Error
          ? options.signal.reason
          : new Error('DSH 插件安装已取消')
      )
    }
    const onError = (error: Error): void => {
      if (terminating) {
        return
      }
      settleRejected(error)
    }
    const onClose = (code: number | null): void => {
      if (settled || terminating) {
        return
      }
      settled = true
      cleanup()
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      })
    }
    const timer = setTimeout(
      () =>
        terminateAndReject(new Error('DSH 插件安装超时')),
      options.timeoutMs
    )
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)
    child.once('error', onError)
    child.once('close', onClose)
    options.signal?.addEventListener('abort', onAbort, {
      once: true
    })
    if (options.signal?.aborted) {
      onAbort()
    }
  })

function publicHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const normalized = value
    .trim()
    .replace(/^git\+/u, '')
    .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
    .replace(/^git@github\.com:/u, 'https://github.com/')
  try {
    const url = new URL(normalized)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

function extensionId(packageName: string): string {
  const slug = packageName
    .toLowerCase()
    .replace(/^@/u, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 100)
  const digest = createHash('sha256')
    .update(packageName)
    .digest('hex')
    .slice(0, 12)
  return `${slug || 'extension'}-${digest}`
}

function catalogEntry(
  packageMetadata: z.infer<typeof npmSearchPackageSchema>
): RuntimeExtensionCatalogEntry {
  const repository =
    publicHttpUrl(packageMetadata.links?.repository) ??
    publicHttpUrl(packageMetadata.links?.homepage) ??
    publicHttpUrl(packageMetadata.links?.npm)
  return runtimeExtensionCatalogEntrySchema.parse({
    id: extensionId(packageMetadata.name),
    package: {
      name: packageMetadata.name,
      version: packageMetadata.version
    },
    displayName: packageMetadata.name,
    description:
      packageMetadata.description?.trim().slice(0, 2_000) ||
      `DeepSeek Harness plugin ${packageMetadata.name}`,
    ...(repository ? { repository } : {}),
    ...(packageMetadata.license?.trim()
      ? { license: packageMetadata.license.trim().slice(0, 128) }
      : {})
  })
}

async function fetchJson(
  fetcher: typeof fetch,
  url: URL,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const response = await fetcher(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'GoodBuddy-DSH-Marketplace/1'
    },
    signal: signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal
  })
  if (!response.ok) {
    throw new Error(`DSH 插件市场请求失败（HTTP ${response.status}）`)
  }
  return response.json()
}

export class DshNpmMarketplaceCatalog
  implements RuntimeExtensionCatalog
{
  private cache?: {
    expiresAt: number
    entries: RuntimeExtensionCatalogEntry[]
  }
  private inFlight?: Promise<
    readonly RuntimeExtensionCatalogEntry[]
  >

  constructor(
    private readonly options: {
      fetcher?: typeof fetch
      registryUrl?: string
      requestTimeoutMs?: number
      cacheTtlMs?: number
    } = {}
  ) {}

  async list(): Promise<readonly RuntimeExtensionCatalogEntry[]> {
    const now = Date.now()
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.entries
    }
    if (this.inFlight) {
      return this.inFlight
    }
    const request = this.load()
    this.inFlight = request
    try {
      return await request
    } finally {
      if (this.inFlight === request) {
        this.inFlight = undefined
      }
    }
  }

  private async load(): Promise<
    readonly RuntimeExtensionCatalogEntry[]
  > {
    const fetcher = this.options.fetcher ?? fetch
    const registryUrl = (
      this.options.registryUrl ?? NPM_REGISTRY_URL
    ).replace(/\/$/u, '')
    const timeoutMs =
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const first = await this.fetchPage(
      fetcher,
      registryUrl,
      0,
      timeoutMs
    )
    const total = Math.min(
      first.total,
      MAXIMUM_CATALOG_ENTRIES
    )
    const offsets: number[] = []
    for (
      let offset = NPM_SEARCH_PAGE_SIZE;
      offset < total;
      offset += NPM_SEARCH_PAGE_SIZE
    ) {
      offsets.push(offset)
    }
    const remaining = await Promise.all(
      offsets.map((offset) =>
        this.fetchPage(fetcher, registryUrl, offset, timeoutMs)
      )
    )
    const packages = [first, ...remaining].flatMap((page) =>
      page.objects.map((item) => item.package)
    )
    const entries = [
      ...new Map(
        packages
          .filter((item) =>
            item.keywords?.some(
              (keyword) => keyword.toLowerCase() === 'dsh-plugin'
            )
          )
          .map((item) => [item.name, catalogEntry(item)] as const)
      ).values()
    ].sort((left, right) =>
      left.displayName.localeCompare(right.displayName, 'en')
    )
    this.cache = {
      expiresAt:
        Date.now() +
        (this.options.cacheTtlMs ?? 5 * 60_000),
      entries
    }
    return entries
  }

  private async fetchPage(
    fetcher: typeof fetch,
    registryUrl: string,
    from: number,
    timeoutMs: number
  ): Promise<z.infer<typeof npmSearchResponseSchema>> {
    const url = new URL(`${registryUrl}/-/v1/search`)
    url.searchParams.set('text', 'keywords:dsh-plugin')
    url.searchParams.set('size', String(NPM_SEARCH_PAGE_SIZE))
    url.searchParams.set('from', String(from))
    return npmSearchResponseSchema.parse(
      await fetchJson(fetcher, url, timeoutMs)
    )
  }
}

function packageDirectory(
  destinationDirectory: string,
  packageName: string
): string {
  return join(
    destinationDirectory,
    'node_modules',
    ...packageName.split('/')
  )
}

function exportsEntrypoint(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  return (
    exportsEntrypoint(record['.']) ??
    exportsEntrypoint(record.import) ??
    exportsEntrypoint(record.default) ??
    exportsEntrypoint(record.require)
  )
}

function normalizeEntrypoint(
  manifest: z.infer<typeof npmInstalledManifestSchema>
): string {
  const entrypoint =
    manifest.main ??
    exportsEntrypoint(manifest.exports) ??
    'index.js'
  const normalized = posix.normalize(entrypoint.replaceAll('\\', '/'))
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized)
  ) {
    throw new Error('DSH 插件入口无效')
  }
  return normalized.replace(/^\.\//u, '')
}

function packageManagerError(error: unknown): Error {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined
  return code === 'ENOENT'
    ? new Error('DSH 插件安装 Runtime 不可用')
    : error instanceof Error
      ? error
      : new Error('DSH 插件安装失败')
}

function quotePosixShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function prepareNodeCommand(
  directory: string,
  executablePath: string
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform === 'win32') {
    const commandPath = join(directory, 'node.cmd')
    await writeFile(
      commandPath,
      [
        '@echo off',
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${executablePath.replaceAll('%', '%%')}" %*`,
        ''
      ].join('\r\n'),
      { encoding: 'utf8', mode: 0o700 }
    )
    return commandPath
  }
  const commandPath = join(directory, 'node')
  await writeFile(
    commandPath,
    [
      '#!/bin/sh',
      `ELECTRON_RUN_AS_NODE=1 exec ${quotePosixShell(executablePath)} "$@"`,
      ''
    ].join('\n'),
    { encoding: 'utf8', mode: 0o700 }
  )
  await chmod(commandPath, 0o700)
  return commandPath
}

export class DshNpmExtensionInstaller {
  private disposed = false
  private readonly activeInstalls = new Map<
    Promise<{
      entrypoint: string
      integrity?: string
    }>,
    AbortController
  >()

  constructor(
    private readonly options: {
      dshHome: string
      npmCliPath?: string
      nodeExecutablePath?: string
      fetcher?: typeof fetch
      registryUrl?: string
      runner?: PackageManagerRunner
      requestTimeoutMs?: number
      installTimeoutMs?: number
      environment?: NodeJS.ProcessEnv
    }
  ) {}

  install(
    input: Parameters<
      RuntimeExtensionStoreDependencies['install']
    >[0]
  ): Promise<{
    entrypoint: string
    integrity?: string
  }> {
    if (this.disposed) {
      return Promise.reject(new Error('DSH 插件安装器正在关闭'))
    }
    const controller = new AbortController()
    const operation = this.performInstall(input, controller.signal)
    this.activeInstalls.set(operation, controller)
    void operation.then(
      () => {
        this.activeInstalls.delete(operation)
      },
      () => {
        this.activeInstalls.delete(operation)
      }
    )
    return operation
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const active = [...this.activeInstalls.entries()]
    for (const [, controller] of active) {
      controller.abort(new Error('应用退出，DSH 插件安装已取消'))
    }
    await Promise.allSettled(
      active.map(([operation]) => operation)
    )
  }

  private async performInstall(
    input: Parameters<
      RuntimeExtensionStoreDependencies['install']
    >[0],
    signal: AbortSignal
  ): Promise<{
    entrypoint: string
    integrity?: string
  }> {
    const manifest = await this.resolveManifest(input.entry, signal)
    signal.throwIfAborted()
    await writeFile(
      join(input.destinationDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'goodbuddy-dsh-extension-host',
          private: true,
          version: '1.0.0'
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    const environment =
      this.options.environment ??
      buildControlledHarnessEnvironment(this.options.dshHome)
    const runner = this.options.runner ?? runPackageManager
    const npmCliPath = this.options.npmCliPath
    const nodeExecutablePath =
      this.options.nodeExecutablePath ?? process.execPath
    let command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    let prefixArgs: string[] = []
    let packageManagerEnvironment = environment
    if (npmCliPath) {
      const npmCli = await stat(npmCliPath).catch(() => undefined)
      if (!npmCli?.isFile()) {
        throw new Error('GoodBuddy 内置 npm Runtime 缺失')
      }
      const runtimeBin = join(
        this.options.dshHome,
        'package-manager-bin'
      )
      await prepareNodeCommand(runtimeBin, nodeExecutablePath)
      const inheritedPath =
        environment.PATH ?? environment.Path ?? ''
      const runtimePath = inheritedPath
        ? `${runtimeBin}${delimiter}${inheritedPath}`
        : runtimeBin
      command = nodeExecutablePath
      prefixArgs = [npmCliPath]
      packageManagerEnvironment = {
        ...environment,
        PATH: runtimePath,
        Path: runtimePath,
        ELECTRON_RUN_AS_NODE: '1',
        npm_execpath: npmCliPath,
        npm_node_execpath: nodeExecutablePath
      }
    }
    let result: PackageManagerRunResult
    try {
      result = await runner(
        command,
        [
          ...prefixArgs,
          'install',
          '--save-exact',
          '--no-audit',
          '--no-fund',
          '--dangerously-allow-all-scripts',
          '--loglevel=error',
          `${input.entry.package.name}@${input.entry.package.version}`
        ],
        {
          cwd: input.destinationDirectory,
          signal,
          env: {
            ...packageManagerEnvironment,
            npm_config_audit: 'false',
            npm_config_fund: 'false',
            npm_config_progress: 'false',
            npm_config_update_notifier: 'false',
            npm_config_registry:
              this.options.registryUrl ?? NPM_REGISTRY_URL
          },
          timeoutMs:
            this.options.installTimeoutMs ??
            DEFAULT_INSTALL_TIMEOUT_MS
        }
      )
    } catch (error) {
      throw packageManagerError(error)
    }
    signal.throwIfAborted()
    if (result.exitCode !== 0) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `exit code ${result.exitCode}`
      throw new Error(
        `DSH 插件安装失败：${detail.slice(0, 4_000)}`
      )
    }

    const installedDirectory = packageDirectory(
      input.destinationDirectory,
      input.entry.package.name
    )
    const installedManifest = npmInstalledManifestSchema.parse(
      JSON.parse(
        await readFile(join(installedDirectory, 'package.json'), 'utf8')
      ) as unknown
    )
    if (
      installedManifest.name !== input.entry.package.name ||
      installedManifest.version !== input.entry.package.version
    ) {
      throw new Error('DSH 插件安装版本与市场选择不一致')
    }
    const entrypoint = join(
      installedDirectory,
      normalizeEntrypoint(installedManifest)
    )
    if (!(await stat(entrypoint)).isFile()) {
      throw new Error('DSH 插件入口文件不存在')
    }
    const lock = JSON.parse(
      await readFile(
        join(input.destinationDirectory, 'package-lock.json'),
        'utf8'
      )
    ) as {
      packages?: Record<string, { integrity?: unknown }>
    }
    const lockKey = relative(
      input.destinationDirectory,
      installedDirectory
    ).replaceAll('\\', '/')
    const installedIntegrity =
      lock.packages?.[lockKey]?.integrity
    if (
      installedIntegrity !== manifest.dist.integrity
    ) {
      throw new Error('DSH 插件 npm 完整性校验不一致')
    }
    return {
      entrypoint: relative(
        input.destinationDirectory,
        entrypoint
      ).replaceAll('\\', '/'),
      integrity: manifest.dist.integrity
    }
  }

  private async resolveManifest(
    entry: RuntimeExtensionCatalogEntry,
    signal: AbortSignal
  ): Promise<NpmVersionManifest> {
    const registryUrl = (
      this.options.registryUrl ?? NPM_REGISTRY_URL
    ).replace(/\/$/u, '')
    const url = new URL(
      `${registryUrl}/${encodeURIComponent(entry.package.name)}`
    )
    const packument = npmPackumentSchema.parse(
      await fetchJson(
        this.options.fetcher ?? fetch,
        url,
        this.options.requestTimeoutMs ??
          DEFAULT_REQUEST_TIMEOUT_MS,
        signal
      )
    )
    if (
      !Object.prototype.hasOwnProperty.call(
        packument.versions,
        entry.package.version
      )
    ) {
      throw new Error('DSH 插件精确版本未发布')
    }
    const manifest = npmVersionManifestSchema.parse(
      packument.versions[entry.package.version]
    )
    if (
      manifest.name !== entry.package.name ||
      manifest.version !== entry.package.version
    ) {
      throw new Error('DSH 插件 npm 元数据不一致')
    }
    return manifest
  }
}
