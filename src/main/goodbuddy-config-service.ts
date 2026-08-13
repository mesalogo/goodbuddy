import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import {
  goodbuddyConfigApplyInputSchema,
  goodbuddyConfigApplyOutputSchema,
  goodbuddyConfigCapabilities,
  goodbuddyConfigCapabilitiesInputSchema,
  goodbuddyConfigGetInputSchema,
  goodbuddyConfigGetOutputSchema,
  goodbuddyConfigOperationRegistry,
  goodbuddyConfigPlanInputSchema,
  goodbuddyConfigPlanOutputSchema,
  type GoodBuddyConfigApplyOutput,
  type GoodBuddyConfigOperation,
  type GoodBuddyConfigPlanOutput,
  type GoodBuddyConfigPlanStep,
  type GoodBuddyConfigReload,
  type GoodBuddyConfigRisk,
  type GoodBuddyConfigSnapshot
} from '../shared/goodbuddy-config-contracts'
import type { ApplicationSettingsStore } from './application-settings-store'
import type {
  CapabilityService,
  SkillImportInspection
} from './capabilities/capability-service'
import {
  getCanonicalWorkspace,
  isPathInside
} from './workspace-file-access'

const DEFAULT_PLAN_TTL_MS = 5 * 60_000
const MAX_PLAN_TTL_MS = 10 * 60_000
const MAX_ACTIVE_PLANS = 32

type Plan = {
  requestId: string
  expiresAt: number
  output: GoodBuddyConfigPlanOutput
  operations: GoodBuddyConfigOperation[]
  skillImports: Map<number, SkillImportInspection>
  stateDigest: string
}

export type GoodBuddyConfigApplyEvent = {
  requestId: string
  planId: string
  summary: string
  risk: GoodBuddyConfigRisk
  reload: GoodBuddyConfigReload
  destructive: boolean
}

export type GoodBuddyConfigServiceOptions = {
  now?: () => number
  planTtlMs?: number
}

export type GoodBuddyConfigApplyAuthorizer = (
  event: GoodBuddyConfigApplyEvent,
  signal: AbortSignal
) => Promise<boolean>

function maximumRisk(
  risks: readonly GoodBuddyConfigRisk[]
): GoodBuddyConfigRisk {
  if (risks.includes('high')) {
    return 'high'
  }
  return risks.includes('medium') ? 'medium' : 'low'
}

function maximumReload(
  reloads: readonly GoodBuddyConfigReload[]
): GoodBuddyConfigReload {
  return reloads.includes('after-current-request')
    ? 'after-current-request'
    : 'none'
}

function toMcpInput(
  operation: Extract<
    GoodBuddyConfigOperation,
    { operation: 'mcp.add' | 'mcp.update' }
  >,
  current?: GoodBuddyConfigSnapshot['mcpServers'][number]
) {
  return {
    ...operation.connection,
    enabled:
      operation.operation === 'mcp.add'
        ? operation.enabled
        : current?.enabled ?? false,
    assignments:
      operation.operation === 'mcp.add'
        ? operation.assignments
        : current?.assignments ?? [],
    secret: { action: 'keep' as const }
  }
}

function stableSnapshotDigest(
  snapshot: GoodBuddyConfigSnapshot,
  capabilityDigest: string
): string {
  return createHash('sha256')
    .update(JSON.stringify({ snapshot, capabilityDigest }))
    .digest('hex')
}

function quoteApprovalValue(value: string, maximum = 1_000): string {
  return JSON.stringify(value.slice(0, maximum))
}

function boundedApplyError(error: unknown): string {
  return (
    (error instanceof Error ? error.message : '配置操作失败')
      .trim()
      .slice(0, 2_000) || '配置操作失败'
  )
}

export class GoodBuddyConfigService {
  private readonly now: () => number
  private readonly planTtlMs: number
  private readonly plans = new Map<string, Plan>()
  private readonly pendingReloads = new Map<
    string,
    GoodBuddyConfigReload
  >()
  private applyQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly applicationSettingsStore: ApplicationSettingsStore,
    private readonly capabilityService: CapabilityService,
    options: GoodBuddyConfigServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now
    const ttl = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS
    if (
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > MAX_PLAN_TTL_MS
    ) {
      throw new RangeError('GoodBuddy 配置计划有效期无效')
    }
    this.planTtlMs = ttl
  }

  getCapabilities(input: unknown = {}): typeof goodbuddyConfigCapabilities {
    goodbuddyConfigCapabilitiesInputSchema.parse(input)
    return goodbuddyConfigCapabilities
  }

  async getSnapshot(input: unknown = {}): Promise<GoodBuddyConfigSnapshot> {
    goodbuddyConfigGetInputSchema.parse(input)
    const [application, capabilities] = await Promise.all([
      this.applicationSettingsStore.get(),
      this.capabilityService.getSnapshot()
    ])
    return goodbuddyConfigGetOutputSchema.parse({
      application,
      skills: capabilities.skills,
      mcpServers: capabilities.mcpServers.map((server) => ({
        id: server.id,
        name: server.name,
        description: server.description,
        enabled: server.enabled,
        allowDynamicTools: server.allowDynamicTools,
        assignments: server.assignments,
        secretConfigured: server.secretConfigured,
        transport: server.transport
      }))
    })
  }

  private prunePlans(): void {
    const now = this.now()
    for (const [planId, plan] of this.plans) {
      if (plan.expiresAt <= now) {
        this.plans.delete(planId)
      }
    }
    while (this.plans.size >= MAX_ACTIVE_PLANS) {
      const oldestPlanId = this.plans.keys().next().value
      if (typeof oldestPlanId !== 'string') {
        break
      }
      this.plans.delete(oldestPlanId)
    }
  }

  private async resolveSkillPath(
    workspacePath: string,
    inputPath: string
  ): Promise<string> {
    const workspace = await getCanonicalWorkspace(
      workspacePath,
      'GoodBuddy 配置工作区不是目录'
    )
    const candidate = isAbsolute(inputPath)
      ? resolve(inputPath)
      : resolve(workspace, inputPath)
    if (!isPathInside(workspace, candidate)) {
      throw new Error('Skill 导入路径必须位于当前工作区')
    }
    const inspection =
      await this.capabilityService.inspectSkillImport(candidate)
    if (!isPathInside(workspace, inspection.sourcePath)) {
      throw new Error('Skill 导入路径不能通过符号链接超出当前工作区')
    }
    return inspection.sourcePath
  }

  private ensureSkill(
    snapshot: GoodBuddyConfigSnapshot,
    skillId: string,
    removable = false
  ): void {
    const skill = snapshot.skills.find((item) => item.id === skillId)
    if (!skill) {
      throw new Error(`Skill 不存在：${skillId}`)
    }
    if (removable && skill.source !== 'imported') {
      throw new Error(`只能删除已导入的 Skill：${skillId}`)
    }
  }

  private ensureMcp(
    snapshot: GoodBuddyConfigSnapshot,
    serverId: string
  ): GoodBuddyConfigSnapshot['mcpServers'][number] {
    const server = snapshot.mcpServers.find((item) => item.id === serverId)
    if (!server) {
      throw new Error(`MCP Server 不存在：${serverId}`)
    }
    return server
  }

  async plan(
    requestId: string,
    workspacePath: string,
    input: unknown
  ): Promise<GoodBuddyConfigPlanOutput> {
    const parsed = goodbuddyConfigPlanInputSchema.parse(input)
    const snapshot = await this.getSnapshot()
    const capabilityDigest =
      await this.capabilityService.getConfigurationDigest()
    const skillImports = new Map<number, SkillImportInspection>()
    const steps: GoodBuddyConfigPlanStep[] = []
    const normalizedOperations: GoodBuddyConfigOperation[] = []
    const introducedSkillIds = new Set<string>()

    for (const [index, operation] of parsed.operations.entries()) {
      let normalized = operation
      let summary: string =
        goodbuddyConfigOperationRegistry[operation.operation].summary
      switch (operation.operation) {
        case 'application.update':
          summary = `更新应用偏好：${Object.keys(operation.updates).join('、')}`
          break
        case 'skill.import': {
          const sourcePath = await this.resolveSkillPath(
            workspacePath,
            operation.sourcePath
          )
          const inspection =
            await this.capabilityService.inspectSkillImport(sourcePath)
          for (const skill of inspection.skills) {
            if (introducedSkillIds.has(skill.id)) {
              throw new Error(`计划包含重复的 Skill：${skill.id}`)
            }
            introducedSkillIds.add(skill.id)
          }
          normalized = { ...operation, sourcePath }
          skillImports.set(index, inspection)
          summary = `从 ${quoteApprovalValue(operation.sourcePath)} 导入 ${inspection.skills
            .map((skill) => skill.name)
            .join('、')}，${
            operation.enabled ? '启用' : '保持禁用'
          }，分配给 ${
            operation.assignments.length > 0
              ? operation.assignments.join('、')
              : '无 Runtime'
          }`
          break
        }
        case 'skill.setEnabled':
          this.ensureSkill(snapshot, operation.skillId)
          summary = `${
            operation.enabled ? '启用' : '禁用'
          } Skill「${operation.skillId}」`
          break
        case 'skill.setAssignments':
          this.ensureSkill(snapshot, operation.skillId)
          summary = `设置 Skill「${operation.skillId}」的 Runtime 分配`
          break
        case 'skill.remove':
          this.ensureSkill(snapshot, operation.skillId, true)
          summary = `永久删除已导入 Skill「${operation.skillId}」`
          break
        case 'mcp.add':
          summary = `添加${
            operation.connection.transport === 'stdio'
              ? '可启动本地程序的'
              : '远程'
          } MCP Server「${operation.connection.name}」：${
            operation.connection.transport === 'stdio'
              ? `命令 ${[
                  quoteApprovalValue(operation.connection.command),
                  ...operation.connection.args.map((argument) =>
                    quoteApprovalValue(argument)
                  )
                ].join(' ')}`
              : `地址 ${quoteApprovalValue(operation.connection.url, 2_048)}`
          }`
          break
        case 'mcp.update': {
          const current = this.ensureMcp(snapshot, operation.serverId)
          if (
            current.secretConfigured &&
            current.transport !== 'stdio' &&
            operation.connection.transport !== 'stdio'
          ) {
            throw new Error(
              '带访问令牌的 MCP 连接不能通过自然语言修改，请使用原生设置界面'
            )
          }
          summary = `修改 MCP Server「${current.name}」的公开连接设置：${
            operation.connection.transport === 'stdio'
              ? `命令 ${[
                  quoteApprovalValue(operation.connection.command),
                  ...operation.connection.args.map((argument) =>
                    quoteApprovalValue(argument)
                  )
                ].join(' ')}`
              : `地址 ${quoteApprovalValue(operation.connection.url, 2_048)}`
          }`
          break
        }
        case 'mcp.setEnabled': {
          const current = this.ensureMcp(snapshot, operation.serverId)
          summary = `${
            operation.enabled ? '启用' : '禁用'
          } MCP Server「${current.name}」`
          break
        }
        case 'mcp.setAssignments': {
          const current = this.ensureMcp(snapshot, operation.serverId)
          summary = `设置 MCP Server「${current.name}」的 Runtime 分配`
          break
        }
        case 'mcp.remove': {
          const current = this.ensureMcp(snapshot, operation.serverId)
          summary = `永久删除 MCP Server「${current.name}」`
          break
        }
      }
      normalizedOperations.push(normalized)
      const descriptor =
        goodbuddyConfigOperationRegistry[operation.operation]
      steps.push({
        index,
        operation: operation.operation,
        summary,
        risk: descriptor.risk,
        reload: descriptor.reload,
        destructive: descriptor.destructive
      })
    }

    this.prunePlans()
    const planId = randomUUID()
    const expiresAt = this.now() + this.planTtlMs
    const output = goodbuddyConfigPlanOutputSchema.parse({
      planId,
      expiresAt: new Date(expiresAt).toISOString(),
      operations: parsed.operations,
      steps,
      overallRisk: maximumRisk(steps.map((step) => step.risk)),
      reload: maximumReload(steps.map((step) => step.reload)),
      requiresApproval: true
    })
    this.plans.set(planId, {
      requestId,
      expiresAt,
      output,
      operations: normalizedOperations,
      skillImports,
      stateDigest: stableSnapshotDigest(snapshot, capabilityDigest)
    })
    return output
  }

  private async applyOperation(
    operation: GoodBuddyConfigOperation,
    skillInspection: SkillImportInspection | undefined
  ): Promise<void> {
    switch (operation.operation) {
      case 'application.update':
        await this.applicationSettingsStore.update(operation.updates)
        return
      case 'skill.import': {
        if (!skillInspection) {
          throw new Error('Skill 导入计划缺少校验信息')
        }
        await this.capabilityService.importSkill(
          operation.sourcePath,
          skillInspection.digest,
          {
            enabled: operation.enabled,
            assignments: operation.assignments
          }
        )
        return
      }
      case 'skill.setEnabled':
        await this.capabilityService.setSkillEnabled(
          operation.skillId,
          operation.enabled
        )
        return
      case 'skill.setAssignments':
        await this.capabilityService.setSkillAssignments(
          operation.skillId,
          operation.assignments
        )
        return
      case 'skill.remove':
        await this.capabilityService.removeSkill(operation.skillId)
        return
      case 'mcp.add':
        await this.capabilityService.saveMcpServer(
          undefined,
          toMcpInput(operation)
        )
        return
      case 'mcp.update': {
        const current = (await this.getSnapshot()).mcpServers.find(
          (server) => server.id === operation.serverId
        )
        if (!current) {
          throw new Error('MCP Server 不存在')
        }
        await this.capabilityService.saveMcpServer(
          operation.serverId,
          toMcpInput(operation, current)
        )
        return
      }
      case 'mcp.setEnabled':
      case 'mcp.setAssignments': {
        const current = (await this.capabilityService.getSnapshot()).mcpServers
          .find((server) => server.id === operation.serverId)
        if (!current) {
          throw new Error('MCP Server 不存在')
        }
        await this.capabilityService.saveMcpServer(operation.serverId, {
          ...('url' in current
            ? { transport: current.transport, url: current.url }
            : {
                transport: 'stdio' as const,
                command: current.command,
                args: current.args
              }),
          name: current.name,
          description: current.description,
          allowDynamicTools: current.allowDynamicTools,
          enabled:
            operation.operation === 'mcp.setEnabled'
              ? operation.enabled
              : current.enabled,
          assignments:
            operation.operation === 'mcp.setAssignments'
              ? operation.assignments
              : current.assignments,
          secret: { action: 'keep' }
        })
        return
      }
      case 'mcp.remove':
        await this.capabilityService.removeMcpServer(operation.serverId)
    }
  }

  apply(
    requestId: string,
    input: unknown,
    signal: AbortSignal,
    authorize: GoodBuddyConfigApplyAuthorizer | undefined
  ): Promise<GoodBuddyConfigApplyOutput> {
    const parsed = goodbuddyConfigApplyInputSchema.parse(input)
    const operation = this.applyQueue.then(async () => {
      this.prunePlans()
      const plan = this.plans.get(parsed.planId)
      if (
        !plan ||
        plan.requestId !== requestId ||
        plan.expiresAt <= this.now()
      ) {
        this.plans.delete(parsed.planId)
        throw new Error('GoodBuddy 配置计划不存在、已过期或不属于当前请求')
      }
      this.plans.delete(parsed.planId)
      signal.throwIfAborted()
      const approved =
        (await authorize?.(
          {
            requestId,
            planId: parsed.planId,
            summary: plan.output.steps
              .map((step) => `${step.index + 1}. ${step.summary}`)
              .join('\n'),
            risk: plan.output.overallRisk,
            reload: plan.output.reload,
            destructive: plan.output.steps.some(
              (step) => step.destructive
            )
          },
          signal
        )) ?? false
      if (!approved) {
        throw new Error('用户拒绝了 GoodBuddy 配置变更')
      }
      signal.throwIfAborted()
      if (plan.expiresAt <= this.now()) {
        throw new Error('GoodBuddy 配置计划在确认期间已过期，请重新生成计划')
      }
      const currentSnapshot = await this.getSnapshot()
      const currentCapabilityDigest =
        await this.capabilityService.getConfigurationDigest()
      if (
        stableSnapshotDigest(
          currentSnapshot,
          currentCapabilityDigest
        ) !== plan.stateDigest
      ) {
        throw new Error('GoodBuddy 配置在确认前已发生变化，请重新生成计划')
      }
      let appliedOperations = 0
      for (const [index, plannedOperation] of plan.operations.entries()) {
        try {
          signal.throwIfAborted()
          await this.applyOperation(
            plannedOperation,
            plan.skillImports.get(index)
          )
          appliedOperations += 1
        } catch (error) {
          if (appliedOperations === 0) {
            throw error
          }
          this.pendingReloads.set(requestId, 'after-current-request')
          return goodbuddyConfigApplyOutputSchema.parse({
            planId: parsed.planId,
            status: 'partially-applied',
            appliedOperations,
            reload: plan.output.reload,
            snapshot: await this.getSnapshot(),
            error: boundedApplyError(error)
          })
        }
      }
      const output = goodbuddyConfigApplyOutputSchema.parse({
        planId: parsed.planId,
        status: 'applied',
        appliedOperations,
        reload: plan.output.reload,
        snapshot: await this.getSnapshot()
      })
      this.pendingReloads.set(
        requestId,
        appliedOperations > 0
          ? 'after-current-request'
          : plan.output.reload
      )
      return output
    })
    this.applyQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  }

  revokeRequest(requestId: string): void {
    for (const [planId, plan] of this.plans) {
      if (plan.requestId === requestId) {
        this.plans.delete(planId)
      }
    }
  }

  takePendingReload(requestId: string): GoodBuddyConfigReload {
    const reload = this.pendingReloads.get(requestId) ?? 'none'
    this.pendingReloads.delete(requestId)
    return reload
  }

  clear(): void {
    this.plans.clear()
    this.pendingReloads.clear()
  }
}
