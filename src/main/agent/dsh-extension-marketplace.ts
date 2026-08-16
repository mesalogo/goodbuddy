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

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
const NPM_SEARCH_PAGE_SIZE = 250
const MAXIMUM_CATALOG_ENTRIES = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000
const MAXIMUM_PROCESS_OUTPUT_CHARACTERS = 64 * 1024

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

const npmPackumentSchema = z
  .object({
    versions: z.record(z.string(), npmVersionManifestSchema)
  })
  .passthrough()

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
  }
) => Promise<PackageManagerRunResult>

function waitForProcessClose(
  child: ReturnType<typeof spawn>
): Promise<void> {
  if (child.exitCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function terminatePackageManager(
  child: ReturnType<typeof spawn>
): Promise<void> {
  const closed = waitForProcessClose(child)
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn(
      'taskkill.exe',
      ['/PID', String(child.pid), '/T', '/F'],
      {
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      }
    )
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000)
      const finish = (): void => {
        clearTimeout(timer)
        resolve()
      }
      killer.once('close', finish)
      killer.once('error', finish)
    })
  } else if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGKILL')
  }
  if (child.exitCode === null) {
    child.kill('SIGKILL')
  }
  await closed
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
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      void terminatePackageManager(child).then(
        () => reject(new Error('DSH 插件安装超时')),
        () => reject(new Error('DSH 插件安装超时'))
      )
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout = boundedAppend(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = boundedAppend(stderr, chunk)
    })
    child.once('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      })
    })
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
  timeoutMs: number
): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'GoodBuddy-DSH-Marketplace/1'
    },
    signal: AbortSignal.timeout(timeoutMs)
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

  async install(
    input: Parameters<
      RuntimeExtensionStoreDependencies['install']
    >[0]
  ): Promise<{
    entrypoint: string
    integrity?: string
  }> {
    const manifest = await this.resolveManifest(input.entry)
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
    entry: RuntimeExtensionCatalogEntry
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
          DEFAULT_REQUEST_TIMEOUT_MS
      )
    )
    const manifest = packument.versions[entry.package.version]
    if (!manifest) {
      throw new Error('DSH 插件精确版本未发布')
    }
    if (
      manifest.name !== entry.package.name ||
      manifest.version !== entry.package.version
    ) {
      throw new Error('DSH 插件 npm 元数据不一致')
    }
    return manifest
  }
}
