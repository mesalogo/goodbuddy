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
  capabilityDiagnosticReportSchema,
  capabilityAssignmentsSchema,
  computerCapabilityConfigSummarySchema,
  computerCapabilityIdSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mcpServerSummarySchema,
  skillIdSchema,
  skillSummarySchema,
  type CapabilityAssignments,
  type CapabilityDiagnosticReport,
  type CapabilitySnapshot,
  type BrowserProfilesSummary,
  type ComputerCapabilityId,
  type McpServerInput,
  type McpServerSummary,
  type RuntimeTarget,
  type SkillSummary
} from '../../shared/capability-contracts'
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

const encryptedSecretSchema = z
  .object({
    formatVersion: z.literal(1),
    scheme: z.literal('electron-safe-storage'),
    ciphertextBase64: z.string()
  })
  .optional()

const storedMcpCommonShape = {
  id: mcpServerIdSchema,
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
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

const storedCapabilitiesSchema = z
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

export type CapabilityCipher = {
  isAvailable: () => boolean
  encrypt: (value: string) => Buffer
  decrypt: (value: Buffer) => string
}

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

export type CapabilityServiceOptions = Readonly<{
  platform?: NodeJS.Platform
  architecture?: string
  electronTarget?: boolean
  browserProfiles?: BrowserProfileService
  diagnostics?: CapabilityDiagnostics
  availableComputerCapabilityImplementations?: readonly ComputerCapabilityImplementationKind[]
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

function emptyStoredCapabilities(): StoredCapabilities {
  return {
    version: 2,
    skills: {},
    mcpServers: [],
    computerCapabilities: defaultComputerCapabilityStates()
  }
}

function defaultSkillState(): z.infer<typeof skillStateSchema> {
  return {
    enabled: true,
    assignments: ['model', 'opencode', 'continue']
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
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/u.exec(content)
  if (!match?.[1] || !match[2]?.trim()) {
    throw new Error(`${basename(directoryPath)} 的 SKILL.md 格式无效`)
  }
  const metadata = skillMetadataSchema.parse(parseYaml(match[1]))
  // Standard SKILL.md files identify the skill by `name`; GoodBuddy packages
  // add an explicit `id` alongside a human-readable `name`.
  const identifier = skillIdSchema.safeParse(metadata.id ?? metadata.name)
  if (!identifier.success) {
    throw new Error(
      `${basename(directoryPath)} 的 SKILL.md 缺少可用的 Skill ID，请提供小写连字符格式的 id 或 name`
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
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
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

async function copySkillPackage(
  sourceRoot: string,
  targetRoot: string
): Promise<void> {
  let fileCount = 0
  let totalBytes = 0

  const copyDirectory = async (
    source: string,
    target: string,
    depth: number
  ): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH) {
      throw new Error('Skill 目录层级超过安全限制')
    }
    await mkdir(target, { recursive: true })
    const entries = await readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = join(source, entry.name)
      const targetPath = join(target, entry.name)
      const details = await lstat(sourcePath)
      if (details.isSymbolicLink()) {
        throw new Error('Skill 包不能包含符号链接')
      }
      if (details.isDirectory()) {
        await copyDirectory(sourcePath, targetPath, depth + 1)
        continue
      }
      if (!details.isFile()) {
        throw new Error('Skill 包只能包含普通文件和目录')
      }
      fileCount += 1
      totalBytes += details.size
      if (
        fileCount > MAX_SKILL_PACKAGE_FILES ||
        details.size > MAX_SKILL_FILE_BYTES ||
        totalBytes > MAX_SKILL_PACKAGE_BYTES
      ) {
        throw new Error('Skill 包大小或文件数量超过安全限制')
      }
      await writeFile(targetPath, await readFile(sourcePath), {
        mode: 0o600
      })
    }
  }

  await copyDirectory(sourceRoot, targetRoot, 0)
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

async function extractSkillZip(
  archivePath: string,
  targetRoot: string
): Promise<string | undefined> {
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

  await mkdir(targetRoot, { recursive: true })
  for (const [archiveName, contents] of Object.entries(files)) {
    const segments = selectedPaths.get(archiveName)
    if (!segments) {
      continue
    }
    const relativeSegments = segments.slice(packageRoot.length)
    const targetPath = join(targetRoot, ...relativeSegments)
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, contents, { mode: 0o600 })
  }
  return packageRoot.at(-1)
}

export class CapabilityService {
  private state?: StoredCapabilities
  private loadPromise?: Promise<StoredCapabilities>
  private updateQueue: Promise<void> = Promise.resolve()
  private readonly platform: NodeJS.Platform
  private readonly architecture: string
  private readonly electronTarget: boolean
  private readonly browserProfiles: BrowserProfileService
  private readonly diagnostics: CapabilityDiagnostics
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
            summary: '隔离的托管浏览器配置存储可用。'
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
      const version = z
        .object({ version: z.union([z.literal(1), z.literal(2)]) })
        .passthrough()
        .parse(raw).version
      if (version === 1) {
        const legacy: StoredCapabilitiesV1 =
          storedCapabilitiesV1Schema.parse(raw)
        loaded = {
          version: 2,
          skills: legacy.skills,
          mcpServers: legacy.mcpServers,
          computerCapabilities: defaultComputerCapabilityStates()
        }
        shouldPersist = true
      } else {
        loaded = storedCapabilitiesSchema.parse(raw)
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        loaded = emptyStoredCapabilities()
      } else {
        await rename(
          this.filePath,
          `${this.filePath}.corrupt-${Date.now()}`
        ).catch(() => undefined)
        loaded = emptyStoredCapabilities()
      }
    }
    const migrateMcpAssignments = loaded.mcpServers.some((server) =>
      server.assignments.includes('opencode')
    )
    const migrated = migrateMcpAssignments
      ? {
          ...loaded,
          mcpServers: loaded.mcpServers.map((server) => ({
            ...server,
            assignments: server.assignments.includes('opencode')
              ? (['model'] as CapabilityAssignments)
              : server.assignments
          }))
        }
      : loaded
    this.state = storedCapabilitiesSchema.parse(migrated)
    await this.validateBrowserProfileReferences(this.state)
    if (shouldPersist || migrateMcpAssignments) {
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
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    await writeFile(
      temporaryPath,
      `${JSON.stringify(validated, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    )
    await rename(temporaryPath, this.filePath)
    this.state = validated
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
          ...(state.skills[skill.id] ?? defaultSkillState())
        }))
        .sort((left, right) =>
          left.source === right.source
            ? left.name.localeCompare(right.name, 'zh-CN')
            : left.source === 'builtin'
              ? -1
              : 1
        ),
      mcpServers: state.mcpServers.map((server) =>
        this.toMcpSummary(server)
      ),
      computerCapabilities: computerCapabilityCatalog.map((capability) =>
        computerCapabilityConfigSummarySchema.parse({
          id: capability.id,
          name: capability.name,
          description: capability.description,
          enabled: state.computerCapabilities[capability.id].enabled,
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
      browserProfiles: this.toBrowserProfilesSummary(browserProfileState)
    }
  }

  async getComputerCapabilityStatus(
    capabilityId: ComputerCapabilityId
  ): Promise<{ enabled: boolean; supported: boolean }> {
    const id = computerCapabilityIdSchema.parse(capabilityId)
    const capability = getComputerCapability(id)
    const state = await this.load()
    return {
      enabled: state.computerCapabilities[id].enabled,
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
      await this.persist({
        ...state,
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
        await this.persist(nextState)
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
            await this.persist(state)
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
      state.computerCapabilities[id].enabled
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
      return this.getSnapshot()
    })
  }

  setDefaultBrowserProfile(profileId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.setDefaultProfile(
        browserProfileIdSchema.parse(profileId)
      )
      return this.getSnapshot()
    })
  }

  removeBrowserProfile(profileId: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      await this.browserProfiles.deleteProfile(
        browserProfileIdSchema.parse(profileId)
      )
      return this.getSnapshot()
    })
  }

  private async importSkillDirectory(
    sourceDirectory: string,
    expectedId: string | null | undefined
  ): Promise<string> {
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
      await copySkillPackage(sourceDirectory, temporaryPath)
      await readSkill(temporaryPath, 'imported', skill.id)
      await rename(temporaryPath, targetPath)
      const state = await this.load()
      await this.persist({
        ...state,
        skills: {
          ...state.skills,
          [skill.id]: defaultSkillState()
        }
      })
      return skill.id
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true })
      throw error
    }
  }

  importSkill(sourcePath: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
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
          const archiveDirectoryName = await extractSkillZip(
            canonicalSource,
            extractPath
          )
          await this.importSkillDirectory(
            extractPath,
            archiveDirectoryName ?? null
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
      const failures: string[] = []
      let importedCount = 0
      for (const directory of directories) {
        try {
          // A suite directory may nest skills below its own name, so the
          // directory name is only authoritative for a single-skill import.
          await this.importSkillDirectory(
            directory,
            directories.length === 1 ? undefined : null
          )
          importedCount += 1
        } catch (error) {
          failures.push(
            `${basename(directory)}：${
              error instanceof Error ? error.message : '导入失败'
            }`
          )
        }
      }
      if (importedCount === 0) {
        throw new Error(`Skill 导入失败。${failures.join('；')}`)
      }
      if (failures.length > 0) {
        throw new Error(
          `已导入 ${importedCount} 个 Skill，${failures.length} 个失败。${failures.join('；')}`
        )
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
      await this.persist({ ...state, skills })
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

  private updateSkillState(
    skillId: string,
    update: Partial<z.infer<typeof skillStateSchema>>
  ): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const id = skillIdSchema.parse(skillId)
      const catalog = await this.getSkillCatalog()
      if (!catalog.some((skill) => skill.id === id)) {
        throw new Error('Skill 不存在')
      }
      const state = await this.load()
      await this.persist({
        ...state,
        skills: {
          ...state.skills,
          [id]: {
            ...(state.skills[id] ?? defaultSkillState()),
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
      if (
        value.assignments.some(
          (assignment) => assignment !== 'model'
        )
      ) {
        throw new Error('当前版本的 MCP Server 只能分配给直连模型')
      }
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
        credential = {
          formatVersion: 1 as const,
          scheme: 'electron-safe-storage' as const,
          ciphertextBase64: this.cipher
            .encrypt(
              JSON.stringify({
                version: 1,
                serverId: id,
                secret: value.secret.value
              })
            )
            .toString('base64')
        }
      }
      const stored: StoredMcpServer =
        value.transport === 'stdio'
          ? {
              id,
              name: value.name,
              description: value.description,
              enabled: value.enabled,
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
      await this.persist({ ...state, mcpServers: nextServers })
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
      await this.persist({
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
          JSON.parse(
            this.cipher.decrypt(
              Buffer.from(server.credential.ciphertextBase64, 'base64')
            )
          )
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
    if (sections.length === 0 && skipped.length === 0) {
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
    if (target !== 'model') {
      return []
    }
    const state = await this.load()
    const assigned = state.mcpServers.filter(
      (server) => server.enabled && server.assignments.includes(target)
    )
    return Promise.all(
      assigned.map((server) => this.getResolvedMcpServer(server.id))
    )
  }
}
