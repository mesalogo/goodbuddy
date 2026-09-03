import { createHash, randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  browserProfileIdSchema,
  browserProfileNameSchema,
  browserProfilesSummarySchema,
  builtinMcpAssignmentsSchema,
  builtinMcpServerIdSchema,
  builtinMcpServerStateSummarySchema,
  capabilityDiagnosticReportSchema,
  capabilityAssignmentsSchema,
  computerCapabilityConfigSummarySchema,
  computerCapabilityIdSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mcpServerSummarySchema,
  runtimeTargetSchema,
  skillIdSchema,
  skillSummarySchema,
  webSearchCapabilitySchema,
  type CapabilityAssignments,
  type CapabilityDiagnosticReport,
  type CapabilitySnapshot,
  type BrowserProfilesSummary,
  type BuiltinMcpServerId,
  type ComputerCapabilityId,
  type McpServerInput,
  type McpServerSummary,
  type RuntimeTarget,
  type SkillSummary
} from '../../shared/capability-contracts'
import type { SettingsWarning } from '../../shared/settings-warning-contracts'
import {
  assertSupportedSettingsVersion,
  isolateCorruptSettingsFile,
  isMissingFileError,
  type SettingsFileOperations,
  UnsupportedSettingsVersionError,
  writeJsonFileAtomically
} from '../settings-file-utils'
import {
  decryptSettingsCredential,
  encryptedSettingsCredentialSchema,
  encryptSettingsCredential,
  type SettingsCredentialCipher
} from '../settings-credential-cipher'
import {
  BrowserProfileService,
  FileBrowserProfileStore,
  type BrowserProfileState
} from './browser-profile-service'
import {
  CapabilityDiagnostics,
  type CapabilityDiagnosticCheck
} from './capability-diagnostics'
import {
  computerCapabilityCatalog,
  getComputerCapability,
  isComputerCapabilitySupported,
  type ComputerCapabilityImplementationKind
} from './computer-capability-catalog'
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_SKILL_PACKAGE_FILES = 128
const MAX_SKILL_DEPTH = 6
const MAX_SKILL_DISCOVERY_DEPTH = 4
const DEFAULT_DISABLED_BUILTIN_SKILL_IDS = new Set([
  'product-marketing',
  'product-evidence',
  'product-presentation'
])
const MAX_SKILL_DISCOVERY_RESULTS = 64
const MAX_SKILL_INSTRUCTION_CHARACTERS = 262_144
const SKILL_DISCOVERY_IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '__pycache__',
  '__MACOSX'
])

// Block scalars in SKILL.md frontmatter carry newlines that would break the
// single-line summary surfaces the renderer and runtimes rely on.
function collapsedText(maximum: number): z.ZodType<string> {
  return z
    .string()
    .transform((value) => value.replace(/\s+/gu, ' ').trim())
    .pipe(z.string().min(1).max(maximum))
}

const skillMetadataSchema = z.object({
  id: skillIdSchema.optional(),
  name: collapsedText(80),
  description: collapsedText(500),
  version: collapsedText(32).optional(),
  tags: z.array(collapsedText(32)).max(12).default([])
})

const skillStateSchema = z
  .object({
    enabled: z.boolean(),
    assignments: capabilityAssignmentsSchema
  })
  .strict()

const builtinMcpServerStateSchema = z
  .object({
    enabled: z.boolean(),
    assignments: builtinMcpAssignmentsSchema
  })
  .strict()

const legacyBuiltinMcpServerStatesSchema = z
  .object({
    'knowledge-base': builtinMcpServerStateSchema,
    'magic-notes': builtinMcpServerStateSchema,
    'goodbuddy-config': builtinMcpServerStateSchema
  })
  .strict()

const builtinMcpServerStatesSchema =
  legacyBuiltinMcpServerStatesSchema.extend({
    'builtin-browser': builtinMcpServerStateSchema
  })

const encryptedSecretSchema =
  encryptedSettingsCredentialSchema.optional()

const storedMcpCommonShape = {
  id: mcpServerIdSchema,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  allowDynamicTools: z.boolean().default(false),
  assignments: capabilityAssignmentsSchema,
  credential: encryptedSecretSchema
}

const storedMcpServerSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...storedMcpCommonShape,
      transport: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string())
    })
    .strict(),
  z
    .object({
      ...storedMcpCommonShape,
      transport: z.literal('http'),
      url: z.string()
    })
    .strict(),
  z
    .object({
      ...storedMcpCommonShape,
      transport: z.literal('sse'),
      url: z.string()
    })
    .strict()
])

const storedCapabilitiesV1Schema = z
  .object({
    version: z.literal(1),
    skills: z.record(skillIdSchema, skillStateSchema),
    mcpServers: z.array(storedMcpServerSchema).max(64)
  })
  .strict()

const computerCapabilityStateSchema = z
  .object({
    enabled: z.boolean(),
    browserProfileId: browserProfileIdSchema.nullable()
  })
  .strict()

const storedCapabilitiesV2Schema = z
  .object({
    version: z.literal(2),
    skills: z.record(skillIdSchema, skillStateSchema),
    mcpServers: z.array(storedMcpServerSchema).max(64),
    computerCapabilities: z
      .object({
        'host-browser-control': computerCapabilityStateSchema,
        'linux-desktop-control': computerCapabilityStateSchema
      })
      .strict()
  })
  .strict()

const webSearchStateSchema = z
  .object({
    enabled: z.boolean()
  })
  .strict()

const storedCapabilitiesV3Schema = z
  .object({
    version: z.literal(3),
    skills: z.record(skillIdSchema, skillStateSchema),
    mcpServers: z.array(storedMcpServerSchema).max(64),
    webSearch: webSearchStateSchema,
    computerCapabilities: z
      .object({
        'host-browser-control': computerCapabilityStateSchema,
        'linux-desktop-control': computerCapabilityStateSchema
      })
      .strict()
  })
  .strict()

const storedCapabilitiesV4Schema = storedCapabilitiesV3Schema.extend({
  version: z.literal(4)
})

const storedCapabilitiesV5Schema = storedCapabilitiesV4Schema.extend({
  version: z.literal(5),
  builtinMcpServers: legacyBuiltinMcpServerStatesSchema
})

const storedCapabilitiesSchema = storedCapabilitiesV5Schema.extend({
  version: z.literal(6),
  builtinMcpServers: builtinMcpServerStatesSchema
})

type StoredCapabilitiesV1 = z.infer<typeof storedCapabilitiesV1Schema>
type StoredCapabilities = z.infer<typeof storedCapabilitiesSchema>
type StoredMcpServer = z.infer<typeof storedMcpServerSchema>

const secretPayloadSchema = z
  .object({
    version: z.literal(1),
    serverId: mcpServerIdSchema,
    secret: z.string()
  })
  .strict()

export type CapabilityCipher = SettingsCredentialCipher

export type ResolvedMcpServer = McpServerSummary & {
  secret?: string
}

export type RuntimeSkillPackage = {
  id: string
  directory: string
}

export type RuntimeSkillContext = {
  instructions: string
  packages: RuntimeSkillPackage[]
}

export type SkillImportInspection = {
  sourcePath: string
  digest: string
  skills: Array<Omit<SkillSummary, 'enabled' | 'assignments'>>
}

export type CapabilityServiceOptions = Readonly<{
  platform?: NodeJS.Platform
  architecture?: string
  electronTarget?: boolean
  browserProfiles?: BrowserProfileService
  diagnostics?: CapabilityDiagnostics
  availableComputerCapabilityImplementations?: readonly ComputerCapabilityImplementationKind[]
  settingsFileOperations?: Partial<SettingsFileOperations>
}>

function defaultComputerCapabilityStates(): StoredCapabilities['computerCapabilities'] {
  return {
    'host-browser-control': {
      enabled: false,
      browserProfileId: null
    },
    'linux-desktop-control': {
      enabled: false,
      browserProfileId: null
    }
  }
}

function defaultBuiltinMcpServerStates(
  browserEnabled = false
): StoredCapabilities['builtinMcpServers'] {
  const defaultState = (): z.infer<typeof builtinMcpServerStateSchema> => ({
    enabled: true,
    assignments: ['model', 'opencode', 'continue']
  })
  return {
    'knowledge-base': defaultState(),
    'magic-notes': defaultState(),
    'goodbuddy-config': defaultState(),
    'builtin-browser': {
      enabled: browserEnabled,
      assignments: ['model', 'opencode', 'continue']
    }
  }
}

function emptyStoredCapabilities(
  webSearchEnabled = true
): StoredCapabilities {
  return {
    version: 6,
    skills: {},
    builtinMcpServers: defaultBuiltinMcpServerStates(),
    mcpServers: [],
    webSearch: { enabled: webSearchEnabled },
    computerCapabilities: defaultComputerCapabilityStates()
  }
}

function defaultSkillState(
  skill?: Pick<SkillSummary, 'id' | 'source'>
): z.infer<typeof skillStateSchema> {
  return {
    enabled:
      skill?.source !== 'builtin' ||
      !DEFAULT_DISABLED_BUILTIN_SKILL_IDS.has(skill.id),
    assignments: [
      'model',
      'opencode',
      'continue',
      'deepseek-harness'
    ]
  }
}

async function readSkill(
  directoryPath: string,
  source: SkillSummary['source'],
  expectedId: string | null = basename(directoryPath)
): Promise<Omit<SkillSummary, 'enabled' | 'assignments'>> {
  const filePath = join(directoryPath, 'SKILL.md')
  const file = await stat(filePath)
  if (!file.isFile() || file.size > MAX_SKILL_FILE_BYTES) {
    throw new Error(`${basename(directoryPath)} 的 SKILL.md 无效或过大`)
  }
  const content = await readFile(filePath, 'utf8')
  return parseSkillContent(
    content,
    basename(directoryPath),
    source,
    expectedId
  )
}

function parseSkillContent(
  content: string,
  displayName: string,
  source: SkillSummary['source'],
  expectedId: string | null
): Omit<SkillSummary, 'enabled' | 'assignments'> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content)
  if (!match?.[1] || !match[2]?.trim()) {
    throw new Error(`${displayName} 的 SKILL.md 格式无效`)
  }
  const metadata = skillMetadataSchema.parse(parseYaml(match[1]))
  // Standard SKILL.md files identify the skill by `name`; GoodBuddy packages
  // add an explicit `id` alongside a human-readable `name`.
  const identifier = skillIdSchema.safeParse(metadata.id ?? metadata.name)
  if (!identifier.success) {
    throw new Error(
      `${displayName} 的 SKILL.md 缺少可用的 Skill ID，请提供小写连字符格式的 id 或 name`
    )
  }
  if (expectedId !== null && identifier.data !== expectedId) {
    throw new Error(`Skill ID 必须与目录名一致：${identifier.data}`)
  }
  return skillSummarySchema
    .omit({ enabled: true, assignments: true })
    .parse({
      ...metadata,
      id: identifier.data,
      source,
      digest: createHash('sha256').update(content).digest('hex')
    })
}

async function listSkills(
  root: string,
  source: SkillSummary['source']
): Promise<Array<Omit<SkillSummary, 'enabled' | 'assignments'>>> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) {
      return []
    }
    throw error
  }
  return Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.')
      )
      .map((entry) => readSkill(join(root, entry.name), source))
  )
}

async function pathExists(candidate: string): Promise<boolean> {
  return stat(candidate)
    .then(() => true)
    .catch(() => false)
}

// Mirrors the conventional layout where the first directory containing
// SKILL.md is the skill root, so users can pick a suite directory that holds
// many skills instead of one package at a time.
async function discoverSkillDirectories(root: string): Promise<string[]> {
  if (await pathExists(join(root, 'SKILL.md'))) {
    return [root]
  }
  const found: string[] = []
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DISCOVERY_DEPTH || found.length > MAX_SKILL_DISCOVERY_RESULTS) {
      return
    }
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith('.') ||
        SKILL_DISCOVERY_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue
      }
      const child = join(current, entry.name)
      if (await pathExists(join(child, 'SKILL.md'))) {
        found.push(child)
        continue
      }
      await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  if (found.length > MAX_SKILL_DISCOVERY_RESULTS) {
    throw new Error(
      `所选目录包含的 Skill 超过 ${MAX_SKILL_DISCOVERY_RESULTS} 个，请选择更精确的目录`
    )
  }
  return found.sort((left, right) => left.localeCompare(right))
}

type SkillPackageFile = {
  relativePath: string
  contents: Buffer
}

async function captureSkillPackage(
  sourceRoot: string
): Promise<SkillPackageFile[]> {
  let fileCount = 0
  let totalBytes = 0
  const files: SkillPackageFile[] = []

  const captureDirectory = async (
    source: string,
    relativeRoot: string,
    depth: number
  ): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH) {
      throw new Error('Skill 目录层级超过安全限制')
    }
    const entries = (await readdir(source, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name)
    )
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const relativePath = relativeRoot
        ? `${relativeRoot}/${entry.name}`
        : entry.name
      const details = await lstat(sourcePath)
      if (details.isSymbolicLink()) {
        throw new Error('Skill 包不能包含符号链接')
      }
      if (details.isDirectory()) {
        await captureDirectory(sourcePath, relativePath, depth + 1)
        continue
      }
      if (!details.isFile()) {
        throw new Error('Skill 包只能包含普通文件和目录')
      }
      const contents = await readFile(sourcePath)
      if (contents.byteLength !== details.size) {
        throw new Error('Skill 内容在读取期间已发生变化，请重试')
      }
      fileCount += 1
      totalBytes += contents.byteLength
      if (
        fileCount > MAX_SKILL_PACKAGE_FILES ||
        contents.byteLength > MAX_SKILL_FILE_BYTES ||
        totalBytes > MAX_SKILL_PACKAGE_BYTES
      ) {
        throw new Error('Skill 包大小或文件数量超过安全限制')
      }
      files.push({ relativePath, contents })
    }
  }

  await captureDirectory(sourceRoot, '', 0)
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  )
}

function digestSkillFiles(files: readonly SkillPackageFile[]): string {
  const packageHash = createHash('sha256')
  for (const file of files) {
    packageHash.update(
      `file\0${file.relativePath}\0${file.contents.byteLength}\0`
    )
    packageHash.update(file.contents)
    packageHash.update('\0')
  }
  return packageHash.digest('hex')
}

async function writeSkillPackageFiles(
  files: readonly SkillPackageFile[],
  targetRoot: string
): Promise<void> {
  await mkdir(targetRoot, { recursive: true })
  for (const file of files) {
    const targetPath = join(targetRoot, ...file.relativePath.split('/'))
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, file.contents, { mode: 0o600 })
  }
}

async function copySkillPackage(
  sourceRoot: string,
  targetRoot: string
): Promise<string> {
  const files = await captureSkillPackage(sourceRoot)
  await writeSkillPackageFiles(files, targetRoot)
  return digestSkillFiles(files)
}

async function digestSkillPackage(sourceRoot: string): Promise<string> {
  return digestSkillFiles(await captureSkillPackage(sourceRoot))
}

function parseSkillZipPath(path: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  const withoutTrailingSlash = normalized.replace(/\/+$/u, '')
  if (
    !withoutTrailingSlash ||
    normalized.startsWith('/') ||
    /^[a-z]:/iu.test(normalized)
  ) {
    throw new Error('Skill ZIP 包含不安全路径')
  }
  const segments = withoutTrailingSlash.split('/')
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.length > 255 ||
        [...segment].some((character) => {
          const code = character.charCodeAt(0)
          return code <= 31 || code === 127
        })
    ) ||
    normalized.length > 512
  ) {
    throw new Error('Skill ZIP 包含不安全路径')
  }
  return segments
}

function isIgnoredSkillZipPath(segments: readonly string[]): boolean {
  return (
    segments[0] === '__MACOSX' ||
    segments.at(-1) === '.DS_Store'
  )
}

type ParsedSkillZip = {
  directoryName?: string
  files: SkillPackageFile[]
}

async function parseSkillZip(archivePath: string): Promise<ParsedSkillZip> {
  const archiveDetails = await stat(archivePath)
  if (
    !archiveDetails.isFile() ||
    archiveDetails.size > MAX_SKILL_PACKAGE_BYTES
  ) {
    throw new Error('Skill ZIP 文件无效或过大')
  }
  const archiveBytes = await readFile(archivePath)
  const selectedPaths = new Map<string, string[]>()
  const normalizedPaths = new Set<string>()
  let fileCount = 0
  let totalBytes = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(archiveBytes, {
      filter: (file) => {
        const segments = parseSkillZipPath(file.name)
        if (
          file.name.endsWith('/') ||
          isIgnoredSkillZipPath(segments)
        ) {
          return false
        }
        const normalizedPath = segments.join('/').toLowerCase()
        if (normalizedPaths.has(normalizedPath)) {
          throw new Error('Skill ZIP 包含重复文件路径')
        }
        normalizedPaths.add(normalizedPath)
        fileCount += 1
        totalBytes += file.originalSize
        if (
          fileCount > MAX_SKILL_PACKAGE_FILES ||
          file.originalSize > MAX_SKILL_FILE_BYTES ||
          totalBytes > MAX_SKILL_PACKAGE_BYTES
        ) {
          throw new Error('Skill ZIP 大小或文件数量超过安全限制')
        }
        selectedPaths.set(file.name, segments)
        return true
      }
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Skill ZIP')) {
      throw error
    }
    throw new Error('Skill ZIP 文件无效或不受支持', {
      cause: error
    })
  }

  const skillEntries = [...selectedPaths.entries()].filter(
    ([, segments]) => segments.at(-1) === 'SKILL.md'
  )
  if (skillEntries.length !== 1) {
    throw new Error('Skill ZIP 必须且只能包含一个 SKILL.md')
  }
  const packageRoot = skillEntries[0]![1].slice(0, -1)
  const packageRootKey = packageRoot
    .map((segment) => segment.toLowerCase())
  for (const segments of selectedPaths.values()) {
    const belongsToPackage = packageRootKey.every(
      (segment, index) => segments[index]?.toLowerCase() === segment
    )
    if (!belongsToPackage || segments.length <= packageRoot.length) {
      throw new Error('Skill ZIP 只能包含一个 Skill 包')
    }
    if (segments.length - packageRoot.length - 1 > MAX_SKILL_DEPTH) {
      throw new Error('Skill ZIP 目录层级超过安全限制')
    }
  }

  return {
    ...(packageRoot.at(-1)
      ? { directoryName: packageRoot.at(-1) }
      : {}),
    files: Object.entries(files)
      .flatMap(([archiveName, contents]) => {
        const segments = selectedPaths.get(archiveName)
        if (!segments) {
          return []
        }
        return [
          {
            relativePath: segments.slice(packageRoot.length).join('/'),
            contents: Buffer.from(contents)
          }
        ]
      })
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath)
      )
  }
}

export class CapabilityService {
  private state?: StoredCapabilities
  private loadPromise?: Promise<StoredCapabilities>
  private warnings: SettingsWarning[] = []
  private updateQueue: Promise<void> = Promise.resolve()
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly electronTarget: boolean
  private readonly browserProfiles: BrowserProfileService
  private readonly diagnostics: CapabilityDiagnostics
  private readonly settingsFileOperations?: Partial<SettingsFileOperations>
  private readonly availableComputerCapabilityImplementations: ReadonlySet<ComputerCapabilityImplementationKind>

  constructor(
    private readonly filePath: string,
    private readonly builtinSkillsRoot: string,
    private readonly importedSkillsRoot: string,
    private readonly cipher: CapabilityCipher,
    options: CapabilityServiceOptions = {}
  ) {
    this.platform = options.platform ?? process.platform
    this.architecture = options.architecture ?? process.arch
    this.electronTarget =
      options.electronTarget ?? Boolean(process.versions.electron)
    this.availableComputerCapabilityImplementations = new Set(
      options.availableComputerCapabilityImplementations ?? [
        'managed-browser-driver'
      ]
    )
    this.settingsFileOperations = options.settingsFileOperations
    this.browserProfiles =
      options.browserProfiles ??
      new BrowserProfileService(
        new FileBrowserProfileStore(
          join(dirname(this.filePath), 'browser-profiles')
        )
      )
    const checks: CapabilityDiagnosticCheck[] = [
      {
        id: 'browser-executable',
        run: async () =>
          this.electronTarget
            ? {
                status: 'available',
                summary: 'GoodBuddy 的受管 Electron 浏览器核心可用。'
              }
            : {
                status: 'unavailable',
                summary: '当前进程不是受支持的 Electron 桌面目标。',
                remedy: '请从 GoodBuddy 桌面应用运行此诊断。'
              }
      },
      {
        id: 'managed-profile-root',
        run: async () => {
          await this.browserProfiles.getSnapshot()
          return {
            status: 'available',
            summary: '内置浏览器隔离存储可用。'
          }
        }
      }
    ]
    this.diagnostics =
      options.diagnostics ?? new CapabilityDiagnostics(checks)
  }

  private load(): Promise<StoredCapabilities> {
    if (this.state) {
      return Promise.resolve(this.state)
    }
    if (this.loadPromise) {
      return this.loadPromise
    }
    const pending = this.loadUncached()
    const tracked = pending.catch((error: unknown) => {
      if (this.loadPromise === tracked) {
        this.loadPromise = undefined
        this.state = undefined
      }
      throw error
    })
    this.loadPromise = tracked
    return tracked
  }

  private async loadUncached(): Promise<StoredCapabilities> {
    let loaded: StoredCapabilities
    let shouldPersist = false
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown
      assertSupportedSettingsVersion(raw, 6, (version) =>
        `当前 GoodBuddy 不支持能力设置版本 ${version}，请升级应用后重试`
      )
      const version = z
        .object({
          version: z.union([
            z.literal(1),
            z.literal(2),
            z.literal(3),
            z.literal(4),
            z.literal(5),
            z.literal(6)
          ])
        })
        .passthrough()
        .parse(raw).version
      if (version === 1) {
        const legacy: StoredCapabilitiesV1 =
          storedCapabilitiesV1Schema.parse(raw)
        loaded = {
          version: 6,
          skills: legacy.skills,
          builtinMcpServers: defaultBuiltinMcpServerStates(),
          mcpServers: legacy.mcpServers,
          webSearch: { enabled: true },
          computerCapabilities: defaultComputerCapabilityStates()
        }
        shouldPersist = true
      } else if (version === 2) {
        const legacy = storedCapabilitiesV2Schema.parse(raw)
        loaded = {
          ...legacy,
          version: 6,
          builtinMcpServers: defaultBuiltinMcpServerStates(
            legacy.computerCapabilities['host-browser-control'].enabled
          ),
          webSearch: { enabled: true }
        }
        shouldPersist = true
      } else if (version === 3) {
        const legacy = storedCapabilitiesV3Schema.parse(raw)
        loaded = {
          ...legacy,
          version: 6,
          builtinMcpServers: defaultBuiltinMcpServerStates(
            legacy.computerCapabilities['host-browser-control'].enabled
          )
        }
        shouldPersist = true
      } else if (version === 4) {
        const legacy = storedCapabilitiesV4Schema.parse(raw)
        loaded = {
          ...legacy,
          version: 6,
          builtinMcpServers: defaultBuiltinMcpServerStates(
            legacy.computerCapabilities['host-browser-control'].enabled
          )
        }
        shouldPersist = true
      } else if (version === 5) {
        const legacy = storedCapabilitiesV5Schema.parse(raw)
        loaded = {
          ...legacy,
          version: 6,
          builtinMcpServers: {
            ...legacy.builtinMcpServers,
            'builtin-browser': {
              enabled:
                legacy.computerCapabilities['host-browser-control'].enabled,
              assignments: ['model', 'opencode', 'continue']
            }
          }
        }
        shouldPersist = true
      } else {
        loaded = storedCapabilitiesSchema.parse(raw)
      }
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) {
        throw error
      }
      if (isMissingFileError(error)) {
        loaded = emptyStoredCapabilities()
      } else {
        await isolateCorruptSettingsFile(
          this.filePath,
          '能力设置已损坏且无法隔离',
          Date.now,
          this.settingsFileOperations
        )
        this.warnings = [{ code: 'capability-settings-recovered' }]
        loaded = emptyStoredCapabilities(false)
        shouldPersist = true
      }
    }
    this.state = storedCapabilitiesSchema.parse(loaded)
    await this.validateBrowserProfileReferences(this.state)
    if (shouldPersist) {
      await this.persist(this.state)
    }
    return this.state
  }

  private async validateBrowserProfileReferences(
    state: StoredCapabilities
  ): Promise<void> {
    const profiles = await this.browserProfiles.getSnapshot()
    const profileIds = new Set(profiles.profiles.map((profile) => profile.id))
    for (const capability of computerCapabilityCatalog) {
      const profileId =
        state.computerCapabilities[capability.id].browserProfileId
      if (profileId && !profileIds.has(profileId)) {
        throw new Error('电脑控制能力引用了不存在的浏览器配置')
      }
      if (capability.id !== 'host-browser-control' && profileId) {
        throw new Error('此电脑控制能力不支持浏览器配置')
      }
    }
  }

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.updateQueue.then(operation)
    this.updateQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async persist(state: StoredCapabilities): Promise<void> {
    const validated = storedCapabilitiesSchema.parse(state)
    await writeJsonFileAtomically(
      this.filePath,
      validated,
      this.settingsFileOperations
    )
    this.state = validated
  }

  private clearRecoveryWarnings(): void {
    this.warnings = this.warnings.filter(
      (warning) => warning.code !== 'capability-settings-recovered'
    )
  }

  private async persistUserChange(
    state: StoredCapabilities
  ): Promise<void> {
    await this.persist(state)
    this.clearRecoveryWarnings()
  }

  private async getSkillCatalog(): Promise<
    Array<Omit<SkillSummary, 'enabled' | 'assignments'>>
  > {
    const [builtins, imported] = await Promise.all([
      listSkills(this.builtinSkillsRoot, 'builtin'),
      listSkills(this.importedSkillsRoot, 'imported')
    ])
    const builtinIds = new Set(builtins.map((skill) => skill.id))
    const catalog = [
      ...builtins,
      ...imported.filter((skill) => !builtinIds.has(skill.id))
    ]
    if (catalog.length > 256) {
      throw new Error('Skill 数量超过 256 个安全限制')
    }
    return catalog
  }

  private toMcpSummary(server: StoredMcpServer): McpServerSummary {
    const { credential, ...configuration } = server
    return mcpServerSummarySchema.parse({
      ...configuration,
      secretConfigured: Boolean(credential)
    })
  }

  async getSnapshot(): Promise<CapabilitySnapshot> {
    const [state, catalog, browserProfileState] = await Promise.all([
      this.load(),
      this.getSkillCatalog(),
      this.browserProfiles.getSnapshot()
    ])
    return {
      skills: catalog
        .map((skill) => ({
          ...skill,
          ...(state.skills[skill.id] ?? defaultSkillState(skill))
        }))
        .sort((left, right) =>
          left.source === right.source
            ? left.name.localeCompare(right.name, 'zh-CN')
            : left.source === 'builtin'
              ? -1
              : 1
        ),
      builtinMcpServers: builtinMcpServerIdSchema.options.map((id) =>
        builtinMcpServerStateSummarySchema.parse({
          id,
          ...state.builtinMcpServers[id]
        })
      ),
      mcpServers: state.mcpServers.map((server) =>
        this.toMcpSummary(server)
      ),
      webSearch: webSearchCapabilitySchema.parse({
        provider: 'exa',
        enabled: state.webSearch.enabled,
        availableIn: ['ask', 'execute'],
        tools: ['web_search', 'web_fetch']
      }),
      computerCapabilities: computerCapabilityCatalog.map((capability) =>
        computerCapabilityConfigSummarySchema.parse({
          id: capability.id,
          name: capability.name,
          description: capability.description,
          enabled:
            capability.id === 'host-browser-control'
              ? state.builtinMcpServers['builtin-browser'].enabled
              : state.computerCapabilities[capability.id].enabled,
          supported: isComputerCapabilitySupported(
            capability,
            this.platform,
            this.architecture,
            this.availableComputerCapabilityImplementations
          ),
          browserProfileId:
            state.computerCapabilities[capability.id].browserProfileId,
          riskSummary: capability.riskSummary
        })
      ),
      browserProfiles: this.toBrowserProfilesSummary(browserProfileState),
      ...(this.warnings.length > 0
        ? { warnings: [...this.warnings] }
        : {})
    }
  }

  async getConfigurationDigest(): Promise<string> {
    const state = await this.load()
    const sanitized = {
      ...state,
      mcpServers: state.mcpServers.map((server) => ({
        ...server,
        credentialConfigured: Boolean(server.credential),
        credential: undefined
      }))
    }
    return createHash('sha256')
      .update(JSON.stringify(sanitized))
      .digest('hex')
  }

  async getWebSearchCapabilityStatus(): Promise<{ enabled: boolean }> {
    const state = await this.load()
    return { enabled: state.webSearch.enabled }
  }

  setWebSearchEnabled(enabled: boolean): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const state = await this.load()
      await this.persistUserChange({
        ...state,
        webSearch: { enabled }
      })
      return this.getSnapshot()
    })
  }

  async getComputerCapabilityStatus(
    capabilityId: ComputerCapabilityId
  ): Promise<{ enabled: boolean; supported: boolean }> {
    const id = computerCapabilityIdSchema.parse(capabilityId)
    const capability = getComputerCapability(id)
    const state = await this.load()
    return {
      enabled:
        id === 'host-browser-control'
          ? state.builtinMcpServers['builtin-browser'].enabled
          : state.computerCapabilities[id].enabled,
      supported: isComputerCapabilitySupported(
        capability,
        this.platform,
        this.architecture,
        this.availableComputerCapabilityImplementations
      )
    }
  }

  private toBrowserProfilesSummary(
    state: BrowserProfileState
  ): BrowserProfilesSummary {
    return browserProfilesSummarySchema.parse({
      profiles: state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        mode: profile.mode
      })),
      defaultProfileId: state.defaultProfileId
    })
  }

  setComputerCapabilityEnabled(
    capabilityId: ComputerCapabilityId,
    enabled: boolean
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = computerCapabilityIdSchema.parse(capabilityId)
      const capability = getComputerCapability(id)
      if (
        enabled &&
        !isComputerCapabilitySupported(
          capability,
          this.platform,
          this.architecture,
          this.availableComputerCapabilityImplementations
        )
      ) {
        throw new Error('当前操作系统或处理器架构不支持此能力')
      }
      if (enabled) {
        const report = await this.diagnoseComputerCapabilityState(id, true)
        if (report.status === 'unavailable') {
          throw new Error('能力诊断不可用，未启用此能力')
        }
      }
      const state = await this.load()
      await this.persistUserChange({
        ...state,
        ...(id === 'host-browser-control'
          ? {
              builtinMcpServers: {
                ...state.builtinMcpServers,
                'builtin-browser': {
                  ...state.builtinMcpServers['builtin-browser'],
                  enabled
                }
              }
            }
          : {}),
        computerCapabilities: {
          ...state.computerCapabilities,
          [id]: {
            ...state.computerCapabilities[id],
            enabled
          }
        }
      })
      return this.getSnapshot()
    })
  }

  setComputerCapabilityBrowserProfile(
    capabilityId: ComputerCapabilityId,
    browserProfileId: string | null
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = computerCapabilityIdSchema.parse(capabilityId)
      const profileId = browserProfileIdSchema.nullable().parse(
        browserProfileId
      )
      if (id !== 'host-browser-control' && profileId) {
        throw new Error('此电脑控制能力不支持浏览器配置')
      }
      const profiles = await this.browserProfiles.getSnapshot()
      if (
        profileId &&
        !profiles.profiles.some((profile) => profile.id === profileId)
      ) {
        throw new Error('浏览器配置不存在')
      }
      const state = await this.load()
      const previousProfileId =
        state.computerCapabilities[id].browserProfileId
      if (profileId === previousProfileId) {
        return this.getSnapshot()
      }
      const reference = { kind: 'capability' as const, id }
      if (profileId) {
        try {
          await this.browserProfiles.addReference(profileId, reference)
        } catch (error) {
          try {
            await this.browserProfiles.removeReference(profileId, reference)
          } catch (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              '浏览器配置引用添加失败，且补偿清理未完成',
              { cause: compensationError }
            )
          }
          throw error
        }
      }
      const nextState: StoredCapabilities = {
        ...state,
        computerCapabilities: {
          ...state.computerCapabilities,
          [id]: {
            ...state.computerCapabilities[id],
            browserProfileId: profileId
          }
        }
      }
      try {
        await this.persistUserChange(nextState)
      } catch (error) {
        if (profileId) {
          try {
            await this.browserProfiles.removeReference(profileId, reference)
          } catch (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              '电脑控制配置保存失败，且新增引用补偿清理未完成',
              { cause: compensationError }
            )
          }
        }
        throw error
      }
      if (previousProfileId) {
        try {
          await this.browserProfiles.removeReference(
            previousProfileId,
            reference
          )
        } catch (error) {
          try {
            await this.browserProfiles.addReference(
              previousProfileId,
              reference
            )
            await this.persistUserChange(state)
            if (profileId) {
              await this.browserProfiles.removeReference(
                profileId,
                reference
              )
            }
          } catch (compensationError) {
            throw new AggregateError(
              [error, compensationError],
              '旧浏览器配置引用移除失败，且回滚未完成',
              { cause: compensationError }
            )
          }
          throw error
        }
      }
      return this.getSnapshot()
    })
  }

  async diagnoseComputerCapability(
    capabilityId: ComputerCapabilityId
  ): Promise<CapabilityDiagnosticReport> {
    const id = computerCapabilityIdSchema.parse(capabilityId)
    const state = await this.load()
    return this.diagnoseComputerCapabilityState(
      id,
      id === 'host-browser-control'
        ? state.builtinMcpServers['builtin-browser'].enabled
        : state.computerCapabilities[id].enabled
    )
  }

  private async diagnoseComputerCapabilityState(
    id: ComputerCapabilityId,
    enabled: boolean
  ): Promise<CapabilityDiagnosticReport> {
    if (
      id === 'host-browser-control' &&
      enabled &&
      !this.electronTarget
    ) {
      return capabilityDiagnosticReportSchema.parse({
        capabilityId: id,
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        checks: [
          {
            id: 'electron-target',
            status: 'unavailable',
            summary: '当前进程不是受支持的 Electron 桌面目标。',
            remedy: '请从 GoodBuddy 桌面应用运行此诊断。'
          }
        ]
      })
    }
    return capabilityDiagnosticReportSchema.parse(
      await this.diagnostics.diagnose({
        capabilityId: id,
        enabled,
        platform: this.platform,
        architecture: this.architecture,
        availableImplementationKinds:
          this.availableComputerCapabilityImplementations
      })
    )
  }

  createBrowserProfile(name: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.createProfile(
        browserProfileNameSchema.parse(name)
      )
      this.clearRecoveryWarnings()
      return this.getSnapshot()
    })
  }

  renameBrowserProfile(
    profileId: string,
    name: string
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.renameProfile(
        browserProfileIdSchema.parse(profileId),
        browserProfileNameSchema.parse(name)
      )
      this.clearRecoveryWarnings()
      return this.getSnapshot()
    })
  }

  setDefaultBrowserProfile(profileId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.setDefaultProfile(
        browserProfileIdSchema.parse(profileId)
      )
      this.clearRecoveryWarnings()
      return this.getSnapshot()
    })
  }

  removeBrowserProfile(profileId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.deleteProfile(
        browserProfileIdSchema.parse(profileId)
      )
      this.clearRecoveryWarnings()
      return this.getSnapshot()
    })
  }

  private async stageSkillDirectory(
    sourceDirectory: string,
    expectedId: string | null | undefined,
    expectedPackageDigest?: string
  ): Promise<{
    skill: Omit<SkillSummary, 'enabled' | 'assignments'>
    temporaryPath: string
    targetPath: string
  }> {
    const temporaryPath = join(
      this.importedSkillsRoot,
      `.import-${randomUUID()}`
    )
    try {
      const skill = await readSkill(
        sourceDirectory,
        'imported',
        expectedId
      )
      const builtins = await listSkills(this.builtinSkillsRoot, 'builtin')
      if (builtins.some((item) => item.id === skill.id)) {
        throw new Error('导入的 Skill ID 与内置 Skill 冲突')
      }
      const targetPath = join(this.importedSkillsRoot, skill.id)
      if (await pathExists(targetPath)) {
        throw new Error('同名 Skill 已导入，请先删除后重试')
      }
      const copiedDigest = await copySkillPackage(
        sourceDirectory,
        temporaryPath
      )
      if (
        expectedPackageDigest !== undefined &&
        copiedDigest !== expectedPackageDigest
      ) {
        throw new Error(
          'Skill 内容在确认后已发生变化，请重新生成导入计划'
        )
      }
      await readSkill(temporaryPath, 'imported', skill.id)
      return { skill, temporaryPath, targetPath }
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true })
      throw error
    }
  }

  private async importSkillDirectory(
    sourceDirectory: string,
    expectedId: string | null | undefined,
    initialState: z.infer<typeof skillStateSchema> = defaultSkillState(),
    expectedPackageDigest?: string
  ): Promise<string> {
    const staged = await this.stageSkillDirectory(
      sourceDirectory,
      expectedId,
      expectedPackageDigest
    )
    try {
      await rename(staged.temporaryPath, staged.targetPath)
      const state = await this.load()
      await this.persistUserChange({
        ...state,
        skills: {
          ...state.skills,
          [staged.skill.id]: skillStateSchema.parse(initialState)
        }
      })
      return staged.skill.id
    } catch (error) {
      await rm(staged.temporaryPath, { recursive: true, force: true })
      throw error
    }
  }

  async inspectSkillImport(
    sourcePath: string
  ): Promise<SkillImportInspection> {
    const canonicalSource = await realpath(sourcePath)
    const sourceDetails = await stat(canonicalSource)
    const isDirectory = sourceDetails.isDirectory()
    const isZip =
      sourceDetails.isFile() &&
      extname(canonicalSource).toLowerCase() === '.zip'
    if (!isDirectory && !isZip) {
      throw new Error('所选 Skill 路径必须是目录或 .zip 文件')
    }
    let directories: string[]
    let expectedId: string | null | undefined
    let zipFiles: SkillPackageFile[] | undefined
    if (isZip) {
      const parsedZip = await parseSkillZip(canonicalSource)
      zipFiles = parsedZip.files
      directories = []
      expectedId = parsedZip.directoryName ?? null
    } else {
      directories = await discoverSkillDirectories(canonicalSource)
      if (directories.length === 0) {
        throw new Error(
          '所选目录及其子目录中没有找到 SKILL.md，请选择 Skill 目录或包含多个 Skill 的目录'
        )
      }
    }

    const skills = isZip
      ? [
          parseSkillContent(
            zipFiles
              ?.find((file) => file.relativePath === 'SKILL.md')
              ?.contents.toString('utf8') ?? '',
            expectedId ?? 'Skill ZIP',
            'imported',
            expectedId ?? null
          )
        ]
      : await Promise.all(
          directories.map((directory) =>
            readSkill(
              directory,
              'imported',
              directories.length === 1 ? undefined : null
            )
          )
        )
    const ids = new Set(skills.map((skill) => skill.id))
    if (ids.size !== skills.length) {
      throw new Error('所选目录包含重复的 Skill ID')
    }
    const [builtins, imported] = await Promise.all([
      listSkills(this.builtinSkillsRoot, 'builtin'),
      listSkills(this.importedSkillsRoot, 'imported')
    ])
    const unavailableIds = new Set([
      ...builtins.map((skill) => skill.id),
      ...imported.map((skill) => skill.id)
    ])
    const conflict = skills.find((skill) => unavailableIds.has(skill.id))
    if (conflict) {
      throw new Error(
        builtins.some((skill) => skill.id === conflict.id)
          ? `导入的 Skill ID 与内置 Skill 冲突：${conflict.id}`
          : `同名 Skill 已导入：${conflict.id}`
      )
    }
    const packageDigests = isZip
      ? [digestSkillFiles(zipFiles ?? [])]
      : await Promise.all(
          directories.map((directory) => digestSkillPackage(directory))
        )
    const digest = createHash('sha256')
      .update(
        skills
          .map((skill, index) => ({
            id: skill.id,
            digest: packageDigests[index]
          }))
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((item) => `${item.id}\0${item.digest}`)
          .join('\0')
      )
      .digest('hex')
    return {
      sourcePath: canonicalSource,
      digest,
      skills
    }
  }

  importSkill(
    sourcePath: string,
    expectedDigest?: string,
    initialState?: {
      enabled: boolean
      assignments: CapabilityAssignments
    }
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      let inspectedPackageDigests: string[] | undefined
      if (expectedDigest !== undefined) {
        const inspection = await this.inspectSkillImport(sourcePath)
        if (inspection.digest !== expectedDigest) {
          throw new Error(
            'Skill 内容在确认后已发生变化，请重新生成导入计划'
          )
        }
        const inspectedSource = await realpath(sourcePath)
        const inspectedDetails = await stat(inspectedSource)
        if (inspectedDetails.isDirectory()) {
          inspectedPackageDigests = await Promise.all(
            (await discoverSkillDirectories(inspectedSource)).map(
              (directory) => digestSkillPackage(directory)
            )
          )
        }
      }
      const canonicalSource = await realpath(sourcePath)
      const sourceDetails = await stat(canonicalSource)
      const isDirectory = sourceDetails.isDirectory()
      const isZip =
        sourceDetails.isFile() &&
        extname(canonicalSource).toLowerCase() === '.zip'
      if (!isDirectory && !isZip) {
        throw new Error('所选 Skill 路径必须是目录或 .zip 文件')
      }
      await mkdir(this.importedSkillsRoot, { recursive: true })

      if (isZip) {
        const extractPath = join(
          this.importedSkillsRoot,
          `.extract-${randomUUID()}`
        )
        try {
          const parsedZip = await parseSkillZip(canonicalSource)
          if (expectedDigest !== undefined) {
            const skillContent = parsedZip.files
              .find((file) => file.relativePath === 'SKILL.md')
              ?.contents.toString('utf8') ?? ''
            const skill = parseSkillContent(
              skillContent,
              parsedZip.directoryName ?? 'Skill ZIP',
              'imported',
              parsedZip.directoryName ?? null
            )
            const currentDigest = createHash('sha256')
              .update(
                `${skill.id}\0${digestSkillFiles(parsedZip.files)}`
              )
              .digest('hex')
            if (currentDigest !== expectedDigest) {
              throw new Error(
                'Skill 内容在确认后已发生变化，请重新生成导入计划'
              )
            }
          }
          await writeSkillPackageFiles(parsedZip.files, extractPath)
          await this.importSkillDirectory(
            extractPath,
            parsedZip.directoryName ?? null,
            initialState,
            digestSkillFiles(parsedZip.files)
          )
        } finally {
          await rm(extractPath, { recursive: true, force: true })
        }
        return this.getSnapshot()
      }

      const directories = await discoverSkillDirectories(canonicalSource)
      if (directories.length === 0) {
        throw new Error(
          '所选目录及其子目录中没有找到 SKILL.md，请选择 Skill 目录或包含多个 Skill 的目录'
        )
      }
      if (
        expectedDigest !== undefined &&
        inspectedPackageDigests?.length !== directories.length
      ) {
        throw new Error(
          'Skill 内容在确认后已发生变化，请重新生成导入计划'
        )
      }
      const stagedSkills: Array<{
        skill: Omit<SkillSummary, 'enabled' | 'assignments'>
        temporaryPath: string
        targetPath: string
      }> = []
      for (const [index, directory] of directories.entries()) {
        try {
          // A suite directory may nest skills below its own name, so the
          // directory name is only authoritative for a single-skill import.
          const staged = await this.stageSkillDirectory(
            directory,
            directories.length === 1 ? undefined : null,
            expectedDigest !== undefined
              ? inspectedPackageDigests?.[index]
              : undefined
          )
          stagedSkills.push(staged)
        } catch (error) {
          await Promise.allSettled(
            stagedSkills.map((staged) =>
              rm(staged.temporaryPath, { recursive: true, force: true })
            )
          )
          throw error
        }
      }
      const state = await this.load()
      const nextSkills = { ...state.skills }
      for (const staged of stagedSkills) {
        nextSkills[staged.skill.id] = skillStateSchema.parse(
          initialState ?? defaultSkillState()
        )
      }
      const installedPaths: string[] = []
      try {
        for (const staged of stagedSkills) {
          await rename(staged.temporaryPath, staged.targetPath)
          installedPaths.push(staged.targetPath)
        }
        await this.persistUserChange({ ...state, skills: nextSkills })
      } catch (error) {
        await Promise.allSettled(
          [
            ...stagedSkills.map((staged) => staged.temporaryPath),
            ...installedPaths
          ].map((path) => rm(path, { recursive: true, force: true }))
        )
        throw error
      }
      return this.getSnapshot()
    })
  }

  removeSkill(skillId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = skillIdSchema.parse(skillId)
      const imported = await listSkills(this.importedSkillsRoot, 'imported')
      if (!imported.some((skill) => skill.id === id)) {
        throw new Error('只能删除已导入的 Skill')
      }
      await rm(join(this.importedSkillsRoot, id), {
        recursive: true,
        force: false
      })
      const state = await this.load()
      const skills = { ...state.skills }
      delete skills[id]
      await this.persistUserChange({ ...state, skills })
      return this.getSnapshot()
    })
  }

  setSkillEnabled(
    skillId: string,
    enabled: boolean
  ): Promise<CapabilitySnapshot> {
    return this.updateSkillState(skillId, { enabled })
  }

  setSkillAssignments(
    skillId: string,
    assignments: CapabilityAssignments
  ): Promise<CapabilitySnapshot> {
    return this.updateSkillState(skillId, {
      assignments: capabilityAssignmentsSchema.parse(assignments)
    })
  }

  setBuiltinMcpServerEnabled(
    serverId: BuiltinMcpServerId,
    enabled: boolean
  ): Promise<CapabilitySnapshot> {
    return this.updateBuiltinMcpServerState(serverId, { enabled })
  }

  setBuiltinMcpServerAssignments(
    serverId: BuiltinMcpServerId,
    assignments: CapabilityAssignments
  ): Promise<CapabilitySnapshot> {
    return this.updateBuiltinMcpServerState(serverId, {
      assignments: builtinMcpAssignmentsSchema.parse(assignments)
    })
  }

  private updateBuiltinMcpServerState(
    serverId: BuiltinMcpServerId,
    update: Partial<z.infer<typeof builtinMcpServerStateSchema>>
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = builtinMcpServerIdSchema.parse(serverId)
      const state = await this.load()
      if (id === 'builtin-browser' && update.enabled === true) {
        const capability = getComputerCapability('host-browser-control')
        if (
          !isComputerCapabilitySupported(
            capability,
            this.platform,
            this.architecture,
            this.availableComputerCapabilityImplementations
          )
        ) {
          throw new Error('当前操作系统或处理器架构不支持此能力')
        }
        const report = await this.diagnoseComputerCapabilityState(
          'host-browser-control',
          true
        )
        if (report.status === 'unavailable') {
          throw new Error('能力诊断不可用，未启用此能力')
        }
      }
      await this.persistUserChange({
        ...state,
        ...(id === 'builtin-browser' && update.enabled !== undefined
          ? {
              computerCapabilities: {
                ...state.computerCapabilities,
                'host-browser-control': {
                  ...state.computerCapabilities['host-browser-control'],
                  enabled: update.enabled
                }
              }
            }
          : {}),
        builtinMcpServers: {
          ...state.builtinMcpServers,
          [id]: {
            ...state.builtinMcpServers[id],
            ...update
          }
        }
      })
      return this.getSnapshot()
    })
  }

  private updateSkillState(
    skillId: string,
    update: Partial<z.infer<typeof skillStateSchema>>
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = skillIdSchema.parse(skillId)
      const catalog = await this.getSkillCatalog()
      const skill = catalog.find((item) => item.id === id)
      if (!skill) {
        throw new Error('Skill 不存在')
      }
      const state = await this.load()
      await this.persistUserChange({
        ...state,
        skills: {
          ...state.skills,
          [id]: {
            ...(state.skills[id] ?? defaultSkillState(skill)),
            ...update
          }
        }
      })
      return this.getSnapshot()
    })
  }

  saveMcpServer(
    serverId: string | undefined,
    input: McpServerInput
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const value = mcpServerInputSchema.parse(input)
      const state = await this.load()
      const id = serverId ? mcpServerIdSchema.parse(serverId) : randomUUID()
      const existing = state.mcpServers.find((server) => server.id === id)
      if (serverId && !existing) {
        throw new Error('MCP Server 不存在')
      }
      if (!existing && state.mcpServers.length >= 64) {
        throw new Error('MCP Server 数量不能超过 64 个')
      }
      if (
        existing &&
        value.secret.action === 'keep' &&
        existing.transport !== 'stdio' &&
        value.transport !== 'stdio' &&
        existing.url !== value.url &&
        existing.credential
      ) {
        throw new Error('MCP 地址已更改，请重新输入或清除访问令牌')
      }
      if (value.transport === 'stdio' && value.secret.action === 'replace') {
        throw new Error('stdio MCP 不支持 Bearer Token')
      }

      let credential =
        value.secret.action === 'keep' ? existing?.credential : undefined
      if (value.secret.action === 'replace') {
        if (!this.cipher.isAvailable()) {
          throw new Error('系统安全存储不可用，MCP 访问令牌未保存')
        }
        credential = encryptSettingsCredential(this.cipher, {
          version: 1,
          serverId: id,
          secret: value.secret.value
        })
      }
      const stored: StoredMcpServer =
        value.transport === 'stdio'
          ? {
              id,
              name: value.name,
              description: value.description,
              enabled: value.enabled,
              allowDynamicTools: value.allowDynamicTools,
              assignments: value.assignments,
              transport: 'stdio',
              command: value.command,
              args: value.args
            }
          : {
              id,
              name: value.name,
              description: value.description,
              enabled: value.enabled,
              allowDynamicTools: value.allowDynamicTools,
              assignments: value.assignments,
              credential,
              transport: value.transport,
              url: new URL(value.url).toString()
            }
      const nextServers = existing
        ? state.mcpServers.map((server) =>
            server.id === id ? stored : server
          )
        : [...state.mcpServers, stored]
      await this.persistUserChange({ ...state, mcpServers: nextServers })
      return this.getSnapshot()
    })
  }

  removeMcpServer(serverId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = mcpServerIdSchema.parse(serverId)
      const state = await this.load()
      if (!state.mcpServers.some((server) => server.id === id)) {
        throw new Error('MCP Server 不存在')
      }
      await this.persistUserChange({
        ...state,
        mcpServers: state.mcpServers.filter((server) => server.id !== id)
      })
      return this.getSnapshot()
    })
  }

  async getResolvedMcpServer(serverId: string): Promise<ResolvedMcpServer> {
    const id = mcpServerIdSchema.parse(serverId)
    const state = await this.load()
    const server = state.mcpServers.find((item) => item.id === id)
    if (!server) {
      throw new Error('MCP Server 不存在')
    }
    let secret: string | undefined
    if (server.credential) {
      if (!this.cipher.isAvailable()) {
        throw new Error('系统安全存储不可用，无法读取 MCP 访问令牌')
      }
      try {
        const payload = secretPayloadSchema.parse(
          decryptSettingsCredential(this.cipher, server.credential)
        )
        if (payload.serverId === id) {
          secret = payload.secret
        }
      } catch {
        throw new Error('MCP 访问令牌无法解密，请重新配置')
      }
    }
    return {
      ...this.toMcpSummary(server),
      secret
    }
  }

  async getRuntimeSkillContext(
    target: RuntimeTarget,
    maximumCharacters: number = MAX_SKILL_INSTRUCTION_CHARACTERS
  ): Promise<RuntimeSkillContext> {
    const budget = Math.min(
      maximumCharacters,
      MAX_SKILL_INSTRUCTION_CHARACTERS
    )
    const snapshot = await this.getSnapshot()
    const sections: string[] = []
    const skipped: string[] = []
    const incompatible: string[] = []
    const packages: RuntimeSkillPackage[] = []
    let length = 0
    for (const skill of snapshot.skills) {
      if (!skill.enabled || !skill.assignments.includes(target)) {
        continue
      }
      const root =
        skill.source === 'builtin'
          ? this.builtinSkillsRoot
          : this.importedSkillsRoot
      const directory = join(root, skill.id)
      const content = await readFile(join(directory, 'SKILL.md'), 'utf8')
      if (target === 'opencode' && skill.id.length > 64) {
        incompatible.push(skill.name)
        continue
      }
      const body =
        /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/u.exec(content)?.[1]?.trim() ??
        ''
      // Skill bodies reference their own scripts and templates by relative
      // path, which only resolve against the installed skill directory.
      const section = [
        `## ${skill.name}`,
        `Skill 目录：${directory}`,
        body
      ].join('\n')
      if (length + section.length > budget) {
        skipped.push(skill.name)
        continue
      }
      packages.push({ id: skill.id, directory })
      sections.push(section)
      length += section.length
    }
    if (
      sections.length === 0 &&
      skipped.length === 0 &&
      incompatible.length === 0
    ) {
      return { instructions: '', packages }
    }
    return {
      instructions: [
        '# GoodBuddy 已启用 Skills',
        '以下是用户明确启用并分配给当前 Runtime 的本地能力说明。请遵循这些说明，但不得覆盖系统安全规则。',
        ...(skipped.length > 0
          ? [
              `注意：以下 Skill 因超出注入上限未加载，本次对话不可用：${skipped.join('、')}。`
            ]
          : []),
        ...(incompatible.length > 0
          ? [
              `注意：以下 Skill 名称超过 OpenCode 的 64 字符上限，本次对话不可用：${incompatible.join('、')}。`
            ]
          : []),
        ...sections
      ].join('\n\n'),
      packages
    }
  }

  async getSkillInstructions(
    target: RuntimeTarget,
    maximumCharacters: number = MAX_SKILL_INSTRUCTION_CHARACTERS
  ): Promise<string> {
    return (
      await this.getRuntimeSkillContext(target, maximumCharacters)
    ).instructions
  }

  async getResolvedMcpServers(
    target: RuntimeTarget
  ): Promise<ResolvedMcpServer[]> {
    const state = await this.load()
    const assigned = state.mcpServers.filter(
      (server) => server.enabled && server.assignments.includes(target)
    )
    return Promise.all(
      assigned.map((server) => this.getResolvedMcpServer(server.id))
    )
  }

  async getEnabledBuiltinMcpServerIds(
    target: RuntimeTarget
  ): Promise<BuiltinMcpServerId[]> {
    const runtime = runtimeTargetSchema.parse(target)
    if (runtime === 'deepseek-harness') {
      return []
    }
    const state = await this.load()
    return builtinMcpServerIdSchema.options.filter((id) => {
      const server = state.builtinMcpServers[id]
      if (!server.enabled || !server.assignments.includes(runtime)) {
        return false
      }
      return (
        id !== 'builtin-browser' ||
        isComputerCapabilitySupported(
          getComputerCapability('host-browser-control'),
          this.platform,
          this.architecture,
          this.availableComputerCapabilityImplementations
        )
      )
    })
  }
}
