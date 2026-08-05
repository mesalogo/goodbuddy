import { createHash } from 'node:crypto'
import type {
  ComputerControlErrorCode,
  ComputerControlRisk
} from '../../shared/computer-control-contracts'

export type ComputerControlAuditEvent = {
  timestamp: number
  taskId: string
  conversationId: string
  leaseId: string
  commandId: string
  action:
    | 'observe'
    | 'activate'
    | 'replace_text'
    | 'select_option'
    | 'scroll'
  risk: ComputerControlRisk
  outcome: 'completed' | 'denied' | 'failed' | 'outcome_unknown'
  errorCode?: ComputerControlErrorCode
  textLength?: number
  textDigest?: string
}

export interface ComputerControlAuditSink {
  write(event: ComputerControlAuditEvent): void | Promise<void>
}

export const digestComputerControlText = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

export class InMemoryComputerControlAudit
  implements ComputerControlAuditSink
{
  private readonly records: ComputerControlAuditEvent[] = []

  constructor(private readonly maximumRecords = 1_000) {
    if (
      !Number.isInteger(maximumRecords) ||
      maximumRecords < 1 ||
      maximumRecords > 10_000
    ) {
      throw new Error('Invalid computer control audit capacity')
    }
  }

  write(event: ComputerControlAuditEvent): void {
    const bounded: ComputerControlAuditEvent = {
      ...event,
      taskId: event.taskId.slice(0, 128),
      conversationId: event.conversationId.slice(0, 128),
      leaseId: event.leaseId.slice(0, 160),
      commandId: event.commandId.slice(0, 160)
    }
    this.records.push(Object.freeze(bounded))
    if (this.records.length > this.maximumRecords) {
      this.records.splice(0, this.records.length - this.maximumRecords)
    }
  }

  entries(): readonly ComputerControlAuditEvent[] {
    return this.records.map((record) => ({ ...record }))
  }
}
