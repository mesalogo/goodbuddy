import { randomUUID } from 'node:crypto'
import {
  TERMINAL_LIMITS,
  type TerminalCreateRequest,
  type TerminalErrorCode,
  type TerminalEvent,
  type TerminalSize,
  type TerminalSnapshot
} from '../../shared/terminal-contracts'
import type { AssistantDatabase } from '../assistant/assistant-database'
import {
  type ExecutionSpaceDescriptor,
  type ExecutionSpaceResolver
} from '../execution-space/execution-space-resolver'
import type { RemoteAgentTargetResolver } from '../remote-agent/remote-agent-connection-manager'
import type {
  SshConnectionPool,
  SshConnectionPoolTarget
} from '../ssh/ssh-connection-pool'
import {
  LocalTerminalSession,
  type LocalTerminalSessionOptions
} from './local-terminal-session'
import {
  createSshTerminalSession,
  type SshTerminalSession,
  type SshTerminalSessionOptions
} from './ssh-terminal-session'

export class TerminalSessionManagerError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'TerminalSessionManagerError'
  }
}

export type ManagedTerminalSession = {
  snapshot(): TerminalSnapshot
  write(data: string): boolean | void
  resize(size: TerminalSize): boolean | void
  acknowledge(sequence: number): void
  close(): void | TerminalSnapshot | Promise<void | TerminalSnapshot>
  onEvent?: (listener: (event: TerminalEvent) => void) => () => void
}

export type TerminalSessionManagerDependencies = {
  database: Pick<AssistantDatabase, 'getProject'>
  executionSpaceResolver: Pick<ExecutionSpaceResolver, 'resolveProject'>
  targetResolver: RemoteAgentTargetResolver
  sshPool: SshConnectionPool
  remoteEnabled: () => boolean | Promise<boolean>
  deliverEvent: (ownerWebContentsId: number, event: TerminalEvent) => void
  createLocalSession?: (
    options: LocalTerminalSessionOptions
  ) => Promise<ManagedTerminalSession>
  createSshSession?: (
    pool: SshConnectionPool,
    options: SshTerminalSessionOptions
  ) => Promise<ManagedTerminalSession>
  createSessionId?: () => string
}

type SessionRecord = {
  ownerId: number
  sessionId: string
  deliveryEnabled: boolean
  delayedEvents: TerminalEvent[]
  closing: boolean
  session?: ManagedTerminalSession
  ready: Promise<ManagedTerminalSession>
  closePromise?: Promise<TerminalSnapshot>
  removeEventListener?: () => void
}

type ResolvedLaunch =
  | {
      kind: 'local'
      targetLabel: string
      projectDirectory?: string
    }
  | {
      kind: 'ssh'
      targetLabel: string
      workingDirectory: string
      poolTarget: SshConnectionPoolTarget
    }

/**
 * Owns ephemeral terminal sessions. Session identifiers are generated in Main
 * and every operation is scoped to the creating WebContents identifier.
 */
export class TerminalSessionManager {
  private readonly records = new Map<string, SessionRecord>()
  private disposePromise: Promise<void> | undefined
  private disposed = false

  constructor(
    private readonly dependencies: TerminalSessionManagerDependencies
  ) {}

  async create(
    ownerWebContentsId: number,
    request: TerminalCreateRequest
  ): Promise<TerminalSnapshot> {
    this.assertOwnerId(ownerWebContentsId)
    if (this.disposed) {
      throw new TerminalSessionManagerError(
        'internal-error',
        '终端会话管理器已关闭'
      )
    }
    if (this.ownerSessionCount(ownerWebContentsId) >=
      TERMINAL_LIMITS.maximumSessionsPerWindow) {
      throw new TerminalSessionManagerError(
        'session-limit-reached',
        `每个窗口最多可同时打开 ${TERMINAL_LIMITS.maximumSessionsPerWindow} 个终端`
      )
    }

    const sessionId =
      this.dependencies.createSessionId?.() ?? randomUUID()
    const record: SessionRecord = {
      ownerId: ownerWebContentsId,
      sessionId,
      deliveryEnabled: false,
      delayedEvents: [],
      closing: false,
      ready: Promise.resolve(undefined as never)
    }
    this.records.set(sessionId, record)
    record.ready = this.createSession(record, request)

    try {
      const session = await record.ready
      if (record.closing) {
        return await this.closeRecord(record)
      }
      return session.snapshot()
    } catch (error) {
      if (this.records.get(sessionId) === record) {
        this.records.delete(sessionId)
      }
      throw error
    }
  }

  /**
   * Enables event forwarding after the create response has crossed IPC. Events
   * produced while a PTY/channel was starting are retained and delivered first.
   */
  enableEventDelivery(
    ownerWebContentsId: number,
    sessionId: string
  ): void {
    const record = this.requireOwned(ownerWebContentsId, sessionId)
    if (record.deliveryEnabled) {
      return
    }
    record.deliveryEnabled = true
    for (const event of record.delayedEvents.splice(0)) {
      this.deliver(record, event)
    }
  }

  write(
    ownerWebContentsId: number,
    sessionId: string,
    data: string
  ): boolean {
    const record = this.requireOwned(ownerWebContentsId, sessionId)
    const session = this.requireRunning(record)
    return session.write(data) !== false
  }

  resize(
    ownerWebContentsId: number,
    sessionId: string,
    size: TerminalSize
  ): boolean {
    const record = this.requireOwned(ownerWebContentsId, sessionId)
    const session = this.requireRunning(record)
    return session.resize(size) !== false
  }

  snapshot(
    ownerWebContentsId: number,
    sessionId: string
  ): TerminalSnapshot {
    const record = this.requireOwned(ownerWebContentsId, sessionId)
    if (!record.session) {
      throw new TerminalSessionManagerError(
        'session-not-running',
        '终端会话仍在启动'
      )
    }
    return record.session.snapshot()
  }

  acknowledge(
    ownerWebContentsId: number,
    sessionId: string,
    sequence: number
  ): void {
    this.assertOwnerId(ownerWebContentsId)
    const record = this.records.get(sessionId)
    if (!record) {
      // ACKs already queued in the renderer may arrive after a successful
      // close. They are delivery bookkeeping, so treating them as complete is
      // both safe and necessary for a race-free close path.
      return
    }
    if (record.ownerId !== ownerWebContentsId) {
      throw new TerminalSessionManagerError(
        'session-not-found',
        '终端会话不存在'
      )
    }
    if (!record.session || record.closing) {
      return
    }
    record.session.acknowledge(sequence)
  }

  close(
    ownerWebContentsId: number,
    sessionId: string
  ): Promise<TerminalSnapshot> {
    const record = this.requireOwned(ownerWebContentsId, sessionId)
    return this.closeRecord(record)
  }

  async closeOwner(ownerWebContentsId: number): Promise<void> {
    this.assertOwnerId(ownerWebContentsId)
    const records = [...this.records.values()].filter(
      (record) => record.ownerId === ownerWebContentsId
    )
    await Promise.allSettled(records.map((record) => this.closeRecord(record)))
    for (const record of records) {
      record.removeEventListener?.()
      if (this.records.get(record.sessionId) === record) {
        this.records.delete(record.sessionId)
      }
    }
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal()
    return this.disposePromise
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true
    const records = [...this.records.values()]
    await Promise.allSettled(records.map((record) => this.closeRecord(record)))
    for (const record of records) {
      record.removeEventListener?.()
    }
    this.records.clear()
  }

  private async createSession(
    record: SessionRecord,
    request: TerminalCreateRequest
  ): Promise<ManagedTerminalSession> {
    const launch = await this.resolveLaunch(request)
    const common = {
      sessionId: record.sessionId,
      target: request.target,
      targetLabel: launch.targetLabel,
      title: `终端 · ${launch.targetLabel}`,
      size: { cols: request.cols, rows: request.rows }
    }
    let session: ManagedTerminalSession
    if (launch.kind === 'local') {
      session = await (
        this.dependencies.createLocalSession ??
        ((options) => LocalTerminalSession.create(options))
      )({
        ...common,
        target: request.target as Extract<
          TerminalCreateRequest['target'],
          { type: 'local' | 'project' }
        >,
        projectDirectory: launch.projectDirectory
      })
      record.session = session
      record.removeEventListener = session.onEvent?.((event) =>
        this.handleEvent(record, event)
      )
    } else {
      session = await (
        this.dependencies.createSshSession ??
        ((pool, options) =>
          createSshTerminalSession(pool, options) as Promise<SshTerminalSession>)
      )(this.dependencies.sshPool, {
        ...common,
        workingDirectory: launch.workingDirectory,
        poolTarget: launch.poolTarget,
        onEvent: (event) => this.handleEvent(record, event)
      })
      record.session = session
    }
    return session
  }

  private async resolveLaunch(
    request: TerminalCreateRequest
  ): Promise<ResolvedLaunch> {
    if (request.target.type === 'local') {
      return { kind: 'local', targetLabel: '本机' }
    }

    let project: ReturnType<AssistantDatabase['getProject']>
    try {
      project = this.dependencies.database.getProject(
        request.target.projectId
      )
    } catch (error) {
      throw this.resolutionError('target-not-found', error, '项目不存在')
    }
    let executionSpace: ExecutionSpaceDescriptor
    try {
      executionSpace =
        this.dependencies.executionSpaceResolver.resolveProject(project)
    } catch (error) {
      throw this.resolutionError(
        'target-unavailable',
        error,
        '项目执行空间不可用'
      )
    }
    if (executionSpace.kind === 'local') {
      return {
        kind: 'local',
        targetLabel: project.name,
        projectDirectory: executionSpace.rootPath
      }
    }
    await this.assertRemoteEnabled()
    const poolTarget = await this.resolveTarget(executionSpace.hostId)
    return {
      kind: 'ssh',
      targetLabel: poolTarget.host.name,
      workingDirectory: executionSpace.remoteRootPath,
      poolTarget
    }
  }

  private async resolveTarget(
    hostId: string
  ): Promise<SshConnectionPoolTarget> {
    try {
      return await this.dependencies.targetResolver.resolve(hostId)
    } catch (error) {
      throw this.resolutionError(
        'target-unavailable',
        error,
        'SSH 主机不可用'
      )
    }
  }

  private async assertRemoteEnabled(): Promise<void> {
    if (!(await this.dependencies.remoteEnabled())) {
      throw new TerminalSessionManagerError(
        'target-unavailable',
        '远程终端当前未启用'
      )
    }
  }

  private handleEvent(record: SessionRecord, event: TerminalEvent): void {
    if (this.records.get(record.sessionId) !== record) {
      return
    }
    if (!record.deliveryEnabled) {
      record.delayedEvents.push(event)
      return
    }
    this.deliver(record, event)
  }

  private deliver(record: SessionRecord, event: TerminalEvent): void {
    try {
      this.dependencies.deliverEvent(record.ownerId, event)
    } catch {
      // A destroyed renderer is cleaned up by closeOwner; it must not break
      // PTY/SSH event handling while that close is being scheduled.
    }
  }

  private requireRunning(record: SessionRecord): ManagedTerminalSession {
    const session = record.session
    if (
      !session ||
      record.closing ||
      session.snapshot().state !== 'running'
    ) {
      throw new TerminalSessionManagerError(
        'session-not-running',
        '终端会话未在运行'
      )
    }
    return session
  }

  private closeRecord(record: SessionRecord): Promise<TerminalSnapshot> {
    record.closing = true
    record.closePromise ??= (async () => {
      try {
        const session = await record.ready
        const closed = await session.close()
        const snapshot =
          closed && typeof closed === 'object' && 'sessionId' in closed
            ? closed
            : session.snapshot()
        record.removeEventListener?.()
        record.removeEventListener = undefined
        record.delayedEvents.length = 0
        if (this.records.get(record.sessionId) === record) {
          this.records.delete(record.sessionId)
        }
        return snapshot
      } catch (error) {
        record.closing = false
        record.closePromise = undefined
        throw error
      }
    })()
    return record.closePromise
  }

  private requireOwned(
    ownerWebContentsId: number,
    sessionId: string
  ): SessionRecord {
    this.assertOwnerId(ownerWebContentsId)
    const record = this.records.get(sessionId)
    if (!record || record.ownerId !== ownerWebContentsId) {
      throw new TerminalSessionManagerError(
        'session-not-found',
        '终端会话不存在'
      )
    }
    return record
  }

  private ownerSessionCount(ownerId: number): number {
    let count = 0
    for (const record of this.records.values()) {
      if (record.ownerId === ownerId && !record.closing) {
        count += 1
      }
    }
    return count
  }

  private assertOwnerId(ownerId: number): void {
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) {
      throw new TypeError('无效的终端窗口标识')
    }
  }

  private resolutionError(
    code: TerminalErrorCode,
    cause: unknown,
    fallback: string
  ): TerminalSessionManagerError {
    return new TerminalSessionManagerError(
      code,
      cause instanceof Error && cause.message
        ? cause.message
        : fallback
    )
  }
}
