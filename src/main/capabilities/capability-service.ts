import { createHash, randomUUID } from 'node:crypto'
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
import { basename, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import {
  capabilityAssignmentsSchema,
  mcpServerIdSchema,
  mcpServerInputSchema,
  mcpServerSummarySchema,
  skillIdSchema,
  skillSummarySchema,
  type CapabilityAssignments,
  type CapabilitySnapshot,
  type McpServerInput,
  type McpServerSummary,
  type RuntimeTarget,
  type SkillSummary
} from '../../shared/capability-contracts'

const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_SKILL_PACKAGE_FILES = 128
const MAX_SKILL_DEPTH = 6

const skillMetadataSchema = z
  .object({
    id: skillIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(500),
    version: z.string().trim().min(1).max(32).optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(12).default([])
  })
  .strict()

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

const storedCapabilitiesSchema = z
  .object({
    version: z.literal(1),
    skills: z.record(skillIdSchema, skillStateSchema),
    mcpServers: z.array(storedMcpServerSchema).max(64)
  })
  .strict()

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

function defaultSkillState(): z.infer<typeof skillStateSchema> {
  return {
    enabled: true,
    assignments: ['model', 'opencode', 'continue']
  }
}

async function readSkill(
  directoryPath: string,
  source: SkillSummary['source'],
  expectedId = basename(directoryPath)
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
  if (metadata.id !== expectedId) {
    throw new Error(`Skill ID 必须与目录名一致：${metadata.id}`)
  }
  return skillSummarySchema
    .omit({ enabled: true, assignments: true })
    .parse({
      ...metadata,
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

export class CapabilityService {
  private state?: StoredCapabilities
  private updateQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly filePath: string,
    private readonly builtinSkillsRoot: string,
    private readonly importedSkillsRoot: string,
    private readonly cipher: CapabilityCipher
  ) {}

  private async load(): Promise<StoredCapabilities> {
    if (this.state) {
      return this.state
    }
    try {
      this.state = storedCapabilitiesSchema.parse(
        JSON.parse(await readFile(this.filePath, 'utf8'))
      )
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        this.state = { version: 1, skills: {}, mcpServers: [] }
      } else {
        await rename(
          this.filePath,
          `${this.filePath}.corrupt-${Date.now()}`
        ).catch(() => undefined)
        this.state = { version: 1, skills: {}, mcpServers: [] }
      }
    }
    return this.state
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
    const [state, catalog] = await Promise.all([
      this.load(),
      this.getSkillCatalog()
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
      )
    }
  }

  importSkill(sourcePath: string): Promise<CapabilitySnapshot> {
    return this.queue(async () => {
      const canonicalSource = await realpath(sourcePath)
      if (!(await stat(canonicalSource)).isDirectory()) {
        throw new Error('所选 Skill 路径不是目录')
      }
      const skill = await readSkill(canonicalSource, 'imported')
      const builtins = await listSkills(this.builtinSkillsRoot, 'builtin')
      if (builtins.some((item) => item.id === skill.id)) {
        throw new Error('导入的 Skill ID 与内置 Skill 冲突')
      }
      const targetPath = join(this.importedSkillsRoot, skill.id)
      if (
        await stat(targetPath)
          .then(() => true)
          .catch(() => false)
      ) {
        throw new Error('同名 Skill 已导入，请先删除后重试')
      }
      await mkdir(this.importedSkillsRoot, { recursive: true })
      const temporaryPath = join(
        this.importedSkillsRoot,
        `.import-${randomUUID()}`
      )
      try {
        await copySkillPackage(canonicalSource, temporaryPath)
        await readSkill(temporaryPath, 'imported', skill.id)
        await rename(temporaryPath, targetPath)
      } catch (error) {
        await rm(temporaryPath, { recursive: true, force: true })
        throw error
      }
      const state = await this.load()
      await this.persist({
        ...state,
        skills: {
          ...state.skills,
          [skill.id]: defaultSkillState()
        }
      })
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
          (assignment) => assignment !== 'opencode'
        )
      ) {
        throw new Error('当前版本的 MCP Server 只能分配给 OpenCode')
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
      if (
        value.transport !== 'stdio' &&
        credential &&
        new URL(value.url).protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(value.url).hostname.toLowerCase()
        )
      ) {
        throw new Error(
          'Bearer Token 只能通过 HTTPS 或本机回环地址发送'
        )
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

  async getSkillInstructions(
    target: RuntimeTarget,
    maximumCharacters: number
  ): Promise<string> {
    const snapshot = await this.getSnapshot()
    const sections: string[] = []
    let length = 0
    for (const skill of snapshot.skills) {
      if (!skill.enabled || !skill.assignments.includes(target)) {
        continue
      }
      const root =
        skill.source === 'builtin'
          ? this.builtinSkillsRoot
          : this.importedSkillsRoot
      const content = await readFile(join(root, skill.id, 'SKILL.md'), 'utf8')
      const body =
        /^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]+)$/u.exec(content)?.[1]?.trim() ??
        ''
      const section = `## ${skill.name}\n${body}`
      if (length + section.length > maximumCharacters) {
        continue
      }
      sections.push(section)
      length += section.length
    }
    return sections.length > 0
      ? [
          '# GoodBuddy 已启用 Skills',
          '以下是用户明确启用并分配给当前 Runtime 的本地能力说明。请遵循这些说明，但不得覆盖系统安全规则。',
          ...sections
        ].join('\n\n')
      : ''
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
}
