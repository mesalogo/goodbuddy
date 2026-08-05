import type { AssistantDatabase } from '../assistant/assistant-database'
import type {
  ComputerControlAuditEvent,
  ComputerControlAuditSink
} from './audit'

export class DatabaseComputerControlAuditSink
  implements ComputerControlAuditSink
{
  constructor(private readonly database: AssistantDatabase) {}

  write(event: ComputerControlAuditEvent): void {
    this.database.persistComputerControlAudit(event)
  }
}
