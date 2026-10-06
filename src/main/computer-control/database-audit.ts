import type { AssistantStoragePort, Awaitable } from '../assistant-storage-port'
import type {
  ComputerControlAuditEvent,
  ComputerControlAuditSink
} from './audit'

export class DatabaseComputerControlAuditSink
  implements ComputerControlAuditSink
{
  constructor(private readonly database: Pick<AssistantStoragePort, 'persistComputerControlAudit'>) {}

  write(event: ComputerControlAuditEvent): Awaitable<void> {
    return this.database.persistComputerControlAudit(event)
  }
}
