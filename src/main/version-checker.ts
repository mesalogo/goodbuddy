import { z } from 'zod'
import type {
  VersionCheckFile,
  VersionCheckResult,
  VersionCheckTarget
} from '../shared/application-settings-contracts'
export type {
  VersionCheckResult,
  VersionCheckTarget
} from '../shared/application-settings-contracts'

export const GOODBUDDY_LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/mesalogo/goodbuddy/releases/latest'

const PRODUCT_NAME = 'GoodBuddy'
const RELEASE_WEB_ROOT =
  'https://github.com/mesalogo/goodbuddy/releases'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_JSON_BYTES = 512 * 1024
const MAX_TIMEOUT_MS = 60_000
const MAX_JSON_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const ALLOWED_RELEASE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'release-assets.githubusercontent.com'
])

const semVerPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+((?:[0-9a-zA-Z-]+)(?:\.[0-9a-zA-Z-]+)*))?$/u
const sha256Pattern = /^[a-f0-9]{64}$/u
const safeFileNamePattern = /^(?!\.{1,2}$)[^/\\\0]+$/u

const releaseAssetSchema = z.object({
  name: z.string().min(1).max(255),
  url: z.url().max(2_048),
  browser_download_url: z.url().max(2_048)
})

const githubReleaseSchema = z.object({
  tag_name: z.string().min(2).max(256),
  draft: z.boolean(),
  prerelease: z.boolean(),
  assets: z.array(releaseAssetSchema).max(256)
})

const releaseFileSchema = z
  .object({
    name: z.string().min(1).max(255).regex(safeFileNamePattern),
    size: z.number().int().positive().safe(),
    sha256: z.string().regex(sha256Pattern)
  })
  .strict()

const platformSchema = z.enum(['windows', 'macos', 'linux'])
const architectureSchema = z.enum(['x64', 'arm64'])
const formatSchema = z.enum([
  'nsis',
  'portable',
  'dmg',
  'zip',
  'AppImage',
  'deb'
])

const releaseTargetSchema = z
  .object({
    platform: platformSchema,
    arch: architectureSchema,
    formats: z.array(formatSchema).min(1).max(8),
    manifest: z
      .string()
      .min(1)
      .max(255)
      .regex(safeFileNamePattern),
    files: z.array(releaseFileSchema).min(1).max(16)
  })
  .strict()

const aggregateFileSchema = releaseFileSchema.extend({
  platform: platformSchema,
  arch: architectureSchema
})

const aggregateReleaseManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    productName: z.literal(PRODUCT_NAME),
    version: z.string().min(1).max(256),
    targets: z.array(releaseTargetSchema).min(1).max(6),
    files: z.array(aggregateFileSchema).min(1).max(96)
  })
  .strict()

type ParsedSemVer = {
  major: bigint
  minor: bigint
  patch: bigint
  prerelease: string[]
}

export type ReleaseFile = VersionCheckFile
export type ReleasePlatform = z.infer<typeof platformSchema>
export type ReleaseArchitecture = z.infer<typeof architectureSchema>

export type VersionCheckerDependencies = {
  fetch: typeof fetch
  currentVersion: string
  platform: NodeJS.Platform
  arch: string
  timeoutMs?: number
  maxJsonBytes?: number
}

function boundedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be an integer between ${minimum} and ${maximum}`
    )
  }
  return value
}

function parseSemVer(version: string): ParsedSemVer {
  const match = semVerPattern.exec(version)
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`)
  }
  return {
    major: BigInt(match[1] ?? ''),
    minor: BigInt(match[2] ?? ''),
    patch: BigInt(match[3] ?? ''),
    prerelease: match[4]?.split('.') ?? []
  }
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/u.test(left)
  const rightNumeric = /^\d+$/u.test(right)
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left)
    const rightNumber = BigInt(right)
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1
  }
  return left < right ? -1 : left > right ? 1 : 0
}

export function compareStrictSemVer(left: string, right: string): number {
  const parsedLeft = parseSemVer(left)
  const parsedRight = parseSemVer(right)
  for (const field of ['major', 'minor', 'patch'] as const) {
    if (parsedLeft[field] < parsedRight[field]) {
      return -1
    }
    if (parsedLeft[field] > parsedRight[field]) {
      return 1
    }
  }
  if (
    parsedLeft.prerelease.length === 0 ||
    parsedRight.prerelease.length === 0
  ) {
    return parsedLeft.prerelease.length === parsedRight.prerelease.length
      ? 0
      : parsedLeft.prerelease.length === 0
        ? 1
        : -1
  }
  const identifierCount = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length
  )
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1
    }
    const comparison = compareIdentifiers(leftIdentifier, rightIdentifier)
    if (comparison !== 0) {
      return comparison
    }
  }
  return 0
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal
): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
    ) {
      throw new RangeError('Version check response is too large')
    }
  }
  if (!response.body) {
    throw new Error('Version check response has no body')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let rejectForAbort: ((reason: DOMException) => void) | undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject
  })
  const abort = (): void => {
    rejectForAbort?.(
      new DOMException('The operation was aborted', 'AbortError')
    )
  }
  if (signal.aborted) {
    abort()
  } else {
    signal.addEventListener('abort', abort, { once: true })
  }
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abortPromise])
      if (result.done) {
        break
      }
      length += result.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        throw new RangeError('Version check response is too large')
      }
      chunks.push(result.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new Error('Version check response is not valid JSON')
  }
}

function normalizePlatform(platform: NodeJS.Platform): ReleasePlatform {
  if (platform === 'win32') {
    return 'windows'
  }
  if (platform === 'darwin') {
    return 'macos'
  }
  if (platform === 'linux') {
    return 'linux'
  }
  throw new Error(`Unsupported update platform: ${platform}`)
}

function normalizeArchitecture(arch: string): ReleaseArchitecture {
  const parsed = architectureSchema.safeParse(arch)
  if (!parsed.success) {
    throw new Error(`Unsupported update architecture: ${arch}`)
  }
  return parsed.data
}

function isCanonicalReleaseAssetApiUrl(value: string): boolean {
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    url.hostname === 'api.github.com' &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    /^\/repos\/mesalogo\/goodbuddy\/releases\/assets\/[1-9]\d*$/u.test(
      url.pathname
    )
  )
}

const expectedFormats: Record<ReleasePlatform, string[]> = {
  windows: ['nsis', 'portable'],
  macos: ['dmg', 'zip'],
  linux: ['AppImage', 'deb']
}

function hasExpectedFileFormats(
  platform: ReleasePlatform,
  files: ReleaseFile[]
): boolean {
  if (platform === 'windows') {
    return (
      files.filter((file) => /-setup\.exe$/u.test(file.name)).length === 1 &&
      files.filter((file) => /-portable\.zip$/u.test(file.name)).length === 1
    )
  }
  const extensions =
    platform === 'macos' ? ['.dmg', '.zip'] : ['.AppImage', '.deb']
  return extensions.every(
    (extension) =>
      files.filter((file) => file.name.endsWith(extension)).length === 1
  )
}

function sameFile(left: ReleaseFile, right: ReleaseFile): boolean {
  return (
    left.name === right.name &&
    left.size === right.size &&
    left.sha256 === right.sha256
  )
}

function validateCurrentTarget(
  manifest: z.infer<typeof aggregateReleaseManifestSchema>,
  platform: ReleasePlatform,
  arch: ReleaseArchitecture
): VersionCheckTarget {
  const targets = manifest.targets.filter(
    (target) => target.platform === platform && target.arch === arch
  )
  if (targets.length !== 1) {
    throw new Error(
      `Release manifest must contain exactly one ${platform}/${arch} target`
    )
  }
  const target = targets[0]
  if (!target) {
    throw new Error('Release manifest target is missing')
  }
  const formats = expectedFormats[platform]
  if (
    target.formats.length !== formats.length ||
    !formats.every((format, index) => target.formats[index] === format) ||
    target.manifest !== `release-manifest-${platform}-${arch}.json` ||
    target.files.length !== formats.length ||
    !hasExpectedFileFormats(platform, target.files) ||
    new Set(target.files.map((file) => file.name)).size !== target.files.length
  ) {
    throw new Error(`Release manifest target is invalid: ${platform}/${arch}`)
  }
  const aggregateFiles = manifest.files.filter(
    (file) => file.platform === platform && file.arch === arch
  )
  if (
    aggregateFiles.length !== target.files.length ||
    !target.files.every((file) =>
      aggregateFiles.some((candidate) => sameFile(file, candidate))
    )
  ) {
    throw new Error(
      `Release manifest file index does not match target: ${platform}/${arch}`
    )
  }
  return {
    platform,
    arch,
    formats: [...target.formats],
    files: target.files.map((file) => ({ ...file }))
  }
}

async function fetchJson(
  transport: typeof fetch,
  url: string,
  signal: AbortSignal,
  maximumBytes: number,
  accept: string
): Promise<unknown> {
  let currentUrl = new URL(url)
  for (let redirectCount = 0; ; redirectCount += 1) {
    const response = await transport(currentUrl, {
      method: 'GET',
      headers: {
        Accept: accept,
        'User-Agent': 'GoodBuddy-Version-Checker'
      },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'manual',
      referrerPolicy: 'no-referrer',
      signal
    })
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirectCount >= MAX_REDIRECTS) {
        throw new Error('GitHub release redirect is invalid or excessive')
      }
      const target = new URL(location, currentUrl)
      if (
        target.protocol !== 'https:' ||
        target.username ||
        target.password ||
        target.hash ||
        target.href.length > 8_192 ||
        !ALLOWED_RELEASE_HOSTS.has(target.hostname.toLowerCase())
      ) {
        throw new Error('GitHub release redirect target is not trusted')
      }
      currentUrl = target
      continue
    }
    if (!response.ok) {
      throw new Error(
        `Version check request failed with HTTP ${response.status}`
      )
    }
    return readBoundedJson(response, maximumBytes, signal)
  }
}

export async function checkForUpdates(
  dependencies: VersionCheckerDependencies
): Promise<VersionCheckResult> {
  const timeoutMs = boundedInteger(
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    'timeoutMs',
    1,
    MAX_TIMEOUT_MS
  )
  const maximumBytes = boundedInteger(
    dependencies.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES,
    'maxJsonBytes',
    1,
    MAX_JSON_BYTES
  )
  parseSemVer(dependencies.currentVersion)
  const platform = normalizePlatform(dependencies.platform)
  const arch = normalizeArchitecture(dependencies.arch)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const releasePayload = await fetchJson(
      dependencies.fetch,
      GOODBUDDY_LATEST_RELEASE_API_URL,
      controller.signal,
      maximumBytes,
      'application/vnd.github+json'
    )
    const release = githubReleaseSchema.parse(releasePayload)
    if (release.draft || release.prerelease) {
      throw new Error('GitHub latest release is not a stable published release')
    }
    if (!release.tag_name.startsWith('v')) {
      throw new Error('GitHub release tag must start with v')
    }
    const latestVersion = release.tag_name.slice(1)
    parseSemVer(latestVersion)
    const manifestUrl =
      `${RELEASE_WEB_ROOT}/download/v${latestVersion}/release-manifest.json`
    const manifests = release.assets.filter(
      (asset) => asset.name === 'release-manifest.json'
    )
    if (
      manifests.length !== 1 ||
      manifests[0]?.browser_download_url !== manifestUrl ||
      !isCanonicalReleaseAssetApiUrl(manifests[0].url)
    ) {
      throw new Error(
        'GitHub release does not contain the canonical aggregate manifest'
      )
    }
    const manifestPayload = await fetchJson(
      dependencies.fetch,
      manifests[0].url,
      controller.signal,
      maximumBytes,
      'application/octet-stream'
    )
    const manifest = aggregateReleaseManifestSchema.parse(manifestPayload)
    if (manifest.version !== latestVersion) {
      throw new Error('Release manifest version does not match the release tag')
    }
    const target = validateCurrentTarget(manifest, platform, arch)
    return {
      updateAvailable:
        compareStrictSemVer(latestVersion, dependencies.currentVersion) > 0,
      currentVersion: dependencies.currentVersion,
      latestVersion,
      releaseUrl: `${RELEASE_WEB_ROOT}/tag/v${latestVersion}`,
      target
    }
  } finally {
    clearTimeout(timeout)
  }
}

export class VersionChecker {
  constructor(private readonly dependencies: VersionCheckerDependencies) {}

  check(): Promise<VersionCheckResult> {
    return checkForUpdates(this.dependencies)
  }
}
