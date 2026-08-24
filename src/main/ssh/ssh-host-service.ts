import { randomUUID } from 'node:crypto'
import type {
  SshHostDraftInspectionRequest,
  SshHostKeyInspection,
  SshHostsSnapshot,
  SshHostValidationRequest,
  SshHostValidationResult
} from '../../shared/ssh-host-contracts'
import {
  sshHostCreateInputSchema,
  sshHostDraftInspectionRequestSchema,
  sshHostUpdateInputSchema,
  sshHostValidationRequestSchema
} from '../../shared/ssh-host-contracts'
import type { SshHostStore } from './ssh-host-store'
import type {
  SshHostKeyCandidate,
  SshTransport
} from './ssh-transport'

const CANDIDATE_TTL_MS = 5 * 60_000
const MAX_PENDING_CANDIDATES = 100

type PendingHostKey = {
  candidate: SshHostKeyCandidate
  hostId?: string
  expectedRevision?: number
  sourceTargetKey?: string
  targetKey: string
  expiresAt: number
}

function targetKey(host: {
  hostname: string
  port: number
  username: string
}): string {
  return `${host.hostname}\0${host.port}\0${host.username}`
}

export type SshHostLifecycleHooks = {
  onHostEdited?: (hostId: string) => void
  onHostRemoved?: (hostId: string) => void
}

export class SshHostService {
  private readonly pendingHostKeys = new Map<
    string,
    PendingHostKey
  >()
  private activeInspections = 0
  private readonly activeInspectionKeys = new Set<string>()
  private readonly activeValidations = new Set<string>()
  private readonly activeValidationKeys = new Set<string>()
  private readonly now: () => number
  private readonly lifecycleHooks: SshHostLifecycleHooks

  constructor(
    private readonly store: SshHostStore,
    private readonly transport: SshTransport,
    nowOrHooks: (() => number) | SshHostLifecycleHooks = Date.now,
    lifecycleHooks: SshHostLifecycleHooks = {}
  ) {
    this.now =
      typeof nowOrHooks === 'function' ? nowOrHooks : Date.now
    this.lifecycleHooks =
      typeof nowOrHooks === 'function'
        ? lifecycleHooks
        : nowOrHooks
  }

  getSnapshot(): Promise<SshHostsSnapshot> {
    return this.store.getSnapshot()
  }

  async remove(hostId: string): Promise<void> {
    await this.store.remove(hostId)
    for (const [candidateId, pending] of this.pendingHostKeys) {
      if (pending.hostId === hostId) {
        this.pendingHostKeys.delete(candidateId)
      }
    }
    this.lifecycleHooks.onHostRemoved?.(hostId)
  }

  async inspectDraftHostKey(
    request: SshHostDraftInspectionRequest
  ): Promise<SshHostKeyInspection> {
    const parsed = sshHostDraftInspectionRequestSchema.parse(request)
    const requestedTargetKey = targetKey(parsed)
    const inspectionKeys = [
      `target:${requestedTargetKey}`,
      ...(parsed.hostId ? [`host:${parsed.hostId}`] : [])
    ]
    if (
      inspectionKeys.some((key) =>
        this.activeValidationKeys.has(key)
      )
    ) {
      throw new Error('SSH 主机正在验证，请等待当前操作完成')
    }
    if (
      inspectionKeys.some((key) =>
        this.activeInspectionKeys.has(key)
      )
    ) {
      throw new Error('SSH 主机密钥正在检查，请等待当前操作完成')
    }
    for (const [candidateId, pending] of this.pendingHostKeys) {
      if (pending.expiresAt <= this.now()) {
        this.pendingHostKeys.delete(candidateId)
      }
    }
    if (
      this.pendingHostKeys.size + this.activeInspections >=
      MAX_PENDING_CANDIDATES
    ) {
      throw new Error('SSH 主机密钥检查过多，请稍后重试')
    }
    this.activeInspections += 1
    for (const key of inspectionKeys) {
      this.activeInspectionKeys.add(key)
    }
    let existing:
      | Awaited<ReturnType<SshHostStore['getHostIdentity']>>
      | undefined
    let candidate: SshHostKeyCandidate
    try {
      existing = parsed.hostId
        ? await this.store.getHostIdentity(parsed.hostId)
        : undefined
      candidate = await this.transport.inspectHostKey({
        hostname: parsed.hostname,
        port: parsed.port,
        username: parsed.username
      })
    } finally {
      this.activeInspections -= 1
      for (const key of inspectionKeys) {
        this.activeInspectionKeys.delete(key)
      }
    }
    const sameEndpoint =
      existing !== undefined &&
      existing.hostname === parsed.hostname &&
      existing.port === parsed.port
    const existingHostKey = sameEndpoint
      ? existing?.hostKey
      : undefined
    const state =
      !existingHostKey
        ? 'unverified'
        : existingHostKey.fingerprintSha256 ===
            candidate.fingerprintSha256
          ? 'verified'
          : 'changed'
    const candidateId = randomUUID()
    for (const [existingId, pending] of this.pendingHostKeys) {
      if (
        !this.activeValidations.has(existingId) &&
        (pending.targetKey === requestedTargetKey ||
          (existing && pending.hostId === existing.id))
      ) {
        this.pendingHostKeys.delete(existingId)
      }
    }
    this.pendingHostKeys.set(candidateId, {
      candidate,
      ...(existing
        ? {
            hostId: existing.id,
            expectedRevision: existing.revision,
            sourceTargetKey: targetKey(existing)
          }
        : {}),
      targetKey: requestedTargetKey,
      expiresAt: this.now() + CANDIDATE_TTL_MS
    })
    return {
      candidateId,
      ...(existing ? { hostId: existing.id } : {}),
      state,
      algorithm: candidate.algorithm,
      fingerprintSha256: candidate.fingerprintSha256,
      ...(state === 'changed' && existing?.hostKey
        ? {
            previousHostKey: {
              algorithm: existing.hostKey.algorithm,
              fingerprintSha256:
                existing.hostKey.fingerprintSha256
            }
          }
        : {})
    }
  }

  discardCandidate(candidateId: string): void {
    if (!this.activeValidations.has(candidateId)) {
      this.pendingHostKeys.delete(candidateId)
    }
  }

  async validateAndSave(
    request: SshHostValidationRequest
  ): Promise<SshHostValidationResult> {
    const parsed = sshHostValidationRequestSchema.parse(request)
    const pending = this.pendingHostKeys.get(parsed.candidateId)
    if (!pending || pending.expiresAt <= this.now()) {
      this.pendingHostKeys.delete(parsed.candidateId)
      throw new Error('SSH 主机密钥检查已过期，请重新检查')
    }
    if (pending.targetKey !== targetKey(parsed.input)) {
      throw new Error('SSH 主机配置已变化，请重新检查主机密钥')
    }
    if (
      pending.candidate.fingerprintSha256 !==
      parsed.fingerprintSha256
    ) {
      throw new Error('SSH 主机密钥指纹不匹配')
    }
    if (this.activeValidations.has(parsed.candidateId)) {
      throw new Error('SSH 主机正在验证，请等待当前操作完成')
    }
    const validationKeys = [
      `target:${pending.targetKey}`,
      ...(pending.hostId ? [`host:${pending.hostId}`] : [])
    ]
    if (
      validationKeys.some((key) =>
        this.activeValidationKeys.has(key)
      )
    ) {
      throw new Error('SSH 主机正在验证，请等待当前操作完成')
    }
    this.activeValidations.add(parsed.candidateId)
    for (const key of validationKeys) {
      this.activeValidationKeys.add(key)
    }

    try {
      let resolvedExisting:
        | Awaited<
            ReturnType<SshHostStore['resolveConnectionTarget']>
          >
        | undefined
      if (pending.hostId) {
        resolvedExisting =
          await this.store.resolveConnectionTarget(
            pending.hostId
          )
        const existing = {
          id: resolvedExisting.host.id,
          hostname: resolvedExisting.host.hostname,
          port: resolvedExisting.host.port,
          username: resolvedExisting.host.username,
          revision: resolvedExisting.hostRevision
        }
        if (
          existing.revision !== pending.expectedRevision ||
          targetKey(existing) !== pending.sourceTargetKey
        ) {
          this.pendingHostKeys.delete(parsed.candidateId)
          throw new Error(
            'SSH 主机配置已变化，请重新检查主机密钥'
          )
        }
        sshHostUpdateInputSchema.parse(parsed.input)
        if (
          parsed.input.password.action === 'keep' &&
          (existing.hostname !== parsed.input.hostname ||
            existing.port !== parsed.input.port ||
            existing.username !== parsed.input.username ||
            parsed.input.authentication !== 'password')
        ) {
          throw new Error(
            '主机地址、端口、用户名或认证方式已变化，请重新输入密码'
          )
        }
      } else {
        sshHostCreateInputSchema.parse(parsed.input)
      }

      let password: string | undefined
      if (parsed.input.authentication === 'password') {
        if (parsed.input.password.action === 'replace') {
          if (!this.store.isSecureStorageAvailable()) {
            throw new Error(
              '系统安全存储不可用，无法保存 SSH 密码'
            )
          }
          password = parsed.input.password.value
        } else if (
          parsed.input.password.action === 'keep' &&
          pending.hostId
        ) {
          password = resolvedExisting?.host.password
        } else {
          throw new Error('SSH 密码不能为空')
        }
      }

      const connection = await this.transport.testConnection({
        id: pending.hostId ?? parsed.candidateId,
        name: parsed.input.name,
        hostname: parsed.input.hostname,
        port: parsed.input.port,
        username: parsed.input.username,
        authentication: parsed.input.authentication,
        ...(password ? { password } : {}),
        hostKey: pending.candidate
      })
      const host = await this.store.commitValidated({
        ...(pending.hostId ? { hostId: pending.hostId } : {}),
        ...(pending.expectedRevision !== undefined
          ? { expectedRevision: pending.expectedRevision }
          : {}),
        input: parsed.input,
        hostKey: pending.candidate
      })
      if (pending.hostId) {
        this.lifecycleHooks.onHostEdited?.(host.id)
      }
      for (const [candidateId, candidate] of this.pendingHostKeys) {
        if (
          candidateId === parsed.candidateId ||
          candidate.targetKey === pending.targetKey ||
          (pending.hostId && candidate.hostId === pending.hostId)
        ) {
          this.pendingHostKeys.delete(candidateId)
        }
      }
      return {
        host,
        connection: {
          hostId: host.id,
          ...connection
        }
      }
    } finally {
      this.activeValidations.delete(parsed.candidateId)
      for (const key of validationKeys) {
        this.activeValidationKeys.delete(key)
      }
    }
  }
}
