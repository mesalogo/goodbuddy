import type {
  RemoteChannelApproval,
  RemoteChannelApprovalDecision
} from '../../shared/remote-channel-contracts'

type PendingApproval = {
  approval: RemoteChannelApproval
  resolve: (decision: RemoteChannelApprovalDecision) => void
  timeout: ReturnType<typeof setTimeout>
  abort: () => void
}

export class RemoteChannelApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>()

  constructor(
    private readonly publish: (approval: RemoteChannelApproval) => void,
    private readonly timeoutMs = 120_000
  ) {}

  request(
    input: Omit<RemoteChannelApproval, 'approvalId' | 'expiresAt'>,
    signal: AbortSignal
  ): Promise<RemoteChannelApprovalDecision> {
    if (signal.aborted) {
      return Promise.resolve('deny')
    }
    const approvalId = crypto.randomUUID()
    const approval: RemoteChannelApproval = {
      ...input,
      approvalId,
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString()
    }
    return new Promise((resolve) => {
      const finish = (
        decision: RemoteChannelApprovalDecision
      ): void => {
        signal.removeEventListener('abort', abort)
        resolve(decision)
      }
      const abort = (): void => {
        this.respond(approvalId, 'deny')
      }
      const timeout = setTimeout(abort, this.timeoutMs)
      this.pending.set(approvalId, {
        approval,
        resolve: finish,
        timeout,
        abort
      })
      signal.addEventListener('abort', abort, { once: true })
      this.publish(approval)
    })
  }

  respond(
    approvalId: string,
    decision: RemoteChannelApprovalDecision
  ): boolean {
    const pending = this.pending.get(approvalId)
    if (!pending) {
      return false
    }
    clearTimeout(pending.timeout)
    this.pending.delete(approvalId)
    pending.resolve(decision)
    return true
  }

  clear(): void {
    for (const approvalId of [...this.pending.keys()]) {
      this.respond(approvalId, 'deny')
    }
  }

  listPending(): RemoteChannelApproval[] {
    return [...this.pending.values()].map((pending) =>
      structuredClone(pending.approval)
    )
  }
}
