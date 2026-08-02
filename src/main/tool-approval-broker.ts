import type {
  ApprovalDecision,
  AgentEvent,
  RuntimeSettings
} from '../shared/contracts'

type PendingApproval = {
  conversationId: string
  scopeKey: string
  resolve: (decision: ApprovalDecision) => void
  timeout: ReturnType<typeof setTimeout>
}

export type ToolApprovalRequest = {
  policy?: RuntimeSettings['toolApproval']
  requestId: string
  conversationId: string
  scopeKey: string
  title: string
  description: string
  toolName?: string
  argumentSummary?: string
  allowPermanent?: boolean
}

export class ToolApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly sessionGrants = new Set<string>()

  async request(
    request: ToolApprovalRequest,
    signal: AbortSignal,
    send: (event: AgentEvent) => void
  ): Promise<ApprovalDecision> {
    if (signal.aborted) {
      throw signal.reason
    }
    if (request.policy === 'policy') {
      throw new Error('当前策略已禁止 Agent 工具执行')
    }
    const grantKey = this.getGrantKey(
      request.conversationId,
      request.scopeKey
    )
    if (this.sessionGrants.has(grantKey)) {
      return 'session'
    }

    const approvalId = crypto.randomUUID()
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (decision: ApprovalDecision): void => {
        signal.removeEventListener('abort', abort)
        resolve(decision)
      }
      const abort = (): void => {
        this.respond(approvalId, 'deny')
      }
      const timeout = setTimeout(() => {
        this.respond(approvalId, 'deny')
      }, 120_000)

      this.pending.set(approvalId, {
        conversationId: request.conversationId,
        scopeKey: request.scopeKey,
        resolve: finish,
        timeout
      })
      signal.addEventListener('abort', abort, { once: true })
      send({
        requestId: request.requestId,
        type: 'approval',
        approvalId,
        title: request.title,
        description: request.description,
        toolName: request.toolName,
        argumentSummary: request.argumentSummary,
        allowPermanent: request.allowPermanent
      })
    })
  }

  respond(approvalId: string, decision: ApprovalDecision): void {
    const approval = this.pending.get(approvalId)
    if (!approval) {
      return
    }
    clearTimeout(approval.timeout)
    this.pending.delete(approvalId)

    if (decision === 'session') {
      this.sessionGrants.add(
        this.getGrantKey(approval.conversationId, approval.scopeKey)
      )
    }
    approval.resolve(decision)
  }

  private getGrantKey(conversationId: string, scopeKey: string): string {
    return `${conversationId}\u0000${scopeKey}`
  }

  clear(): void {
    for (const approvalId of this.pending.keys()) {
      this.respond(approvalId, 'deny')
    }
    this.sessionGrants.clear()
  }
}
