import type {
  AgentEvent,
  RuntimeSettings
} from '../shared/contracts'

type PendingApproval = {
  policy: RuntimeSettings['toolApproval']
  workspace: string
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

export class ToolApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()
  private sessionGranted = false
  private readonly workspaceGrants = new Set<string>()

  async request(
    policy: RuntimeSettings['toolApproval'],
    requestId: string,
    workspace: string,
    signal: AbortSignal,
    send: (event: AgentEvent) => void
  ): Promise<void> {
    if (signal.aborted) {
      throw signal.reason
    }
    if (policy === 'session' && this.sessionGranted) {
      return
    }
    if (policy === 'workspace' && this.workspaceGrants.has(workspace)) {
      return
    }
    if (policy === 'policy') {
      throw new Error('企业策略尚未授权 Agent 工具执行')
    }

    const approvalId = crypto.randomUUID()
    const approved = await new Promise<boolean>((resolve) => {
      const finish = (result: boolean): void => {
        signal.removeEventListener('abort', abort)
        resolve(result)
      }
      const abort = (): void => {
        this.respond(approvalId, false)
      }
      const timeout = setTimeout(() => {
        this.respond(approvalId, false)
      }, 120_000)

      this.pending.set(approvalId, {
        policy,
        workspace,
        resolve: finish,
        timeout
      })
      signal.addEventListener('abort', abort, { once: true })
      send({
        requestId,
        type: 'approval',
        approvalId,
        title: '允许 Agent 使用工作区工具？',
        description:
          '该 Runtime 可能读取或修改工作区文件并执行命令。执行过程仍会显示在对话中。'
      })
    })

    if (!approved) {
      throw new Error('用户拒绝了 Agent 工具执行')
    }
  }

  respond(approvalId: string, approved: boolean): void {
    const approval = this.pending.get(approvalId)
    if (!approval) {
      return
    }
    clearTimeout(approval.timeout)
    this.pending.delete(approvalId)

    if (approved && approval.policy === 'session') {
      this.sessionGranted = true
    }
    if (approved && approval.policy === 'workspace') {
      this.workspaceGrants.add(approval.workspace)
    }
    approval.resolve(approved)
  }

  clear(): void {
    for (const approvalId of this.pending.keys()) {
      this.respond(approvalId, false)
    }
    this.sessionGranted = false
    this.workspaceGrants.clear()
  }
}
